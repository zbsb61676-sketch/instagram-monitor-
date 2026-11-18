/**
 * Instagram Public Content Downloader & Deduplicator
 * Downloads profile picture, full carousel slides, highlights, posts, reels, and stories with strict deduplication.
 */

require('./dnsPatch');

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('./config');
const db = require('./db');
const cacheManager = require('./cacheManager');
const anonyigProvider = require('./anonyigProvider');
const { httpFetch } = require('./httpClient');

// Ensure base downloads folder exists
if (!fs.existsSync(config.DOWNLOADS_DIR)) {
  fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true });
}

/**
 * Shared concurrency limiter (semaphore) so nested highlight/carousel/post/story
 * downloads never exceed the safe global concurrency budget.
 */
function createLimiter(maxConcurrent = 6) {
  const limit = Math.max(1, maxConcurrent);
  let active = 0;
  const queue = [];

  return async function runLimited(fn) {
    if (active >= limit) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) {
        const next = queue.shift();
        next();
      }
    }
  };
}

/**
 * Bounded concurrent worker pool — speeds up bulk media downloads dramatically
 * while keeping concurrency safely capped to prevent memory spikes or rate limits.
 */
async function runWithConcurrency(items, concurrency, workerFn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;
      results[idx] = await workerFn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}

function formatCookieHeader(sessionCookie) {
  const raw = (sessionCookie || '').trim();
  if (!raw) return '';
  return raw.includes('=') ? raw : `sessionid=${raw}`;
}

function isLoginWallResponse(res, html = '', cleanUsername = '') {
  const finalUrl = res?.url || '';
  if (
    res?.status === 401 ||
    res?.status === 403 ||
    res?.status === 429 ||
    finalUrl.includes('/accounts/login') ||
    finalUrl.includes('/challenge/')
  ) {
    return true;
  }
  if (!html) return false;
  if (
    html.includes('<title>Login • Instagram</title>') ||
    html.includes('Login • Instagram') ||
    html.includes('"pageID":"CAAIGLoginHomepage"') ||
    html.includes('checkpoint_required')
  ) {
    return true;
  }
  // Instagram serves a stripped generic "<title>Instagram</title>" shell to blocked datacenter IPs (e.g. Render/AWS)
  const isGenericShell = /<title>\s*Instagram\s*<\/title>/i.test(html) && !html.includes('og:image');
  if (isGenericShell) return true;
  if (cleanUsername && !html.toLowerCase().includes(cleanUsername.toLowerCase()) && !html.includes('display_uri')) {
    return true;
  }
  return false;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBrowserHeaders() {
  return {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
}

/**
 * High-speed streaming atomic file downloader with HTTP keep-alive reuse,
 * automatic transient retry, and guaranteed temporary file cleanup on failure.
 */
async function downloadFile(url, destPath, options = {}) {
  if (!url) return false;

  const exec = async () => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Reuse existing valid file if not forced
    if (options.force !== true && fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
      return true;
    }

    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
    const timeoutMs = options.timeoutMs || 25000;
    let lastErr = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const tempPath = `${destPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = options.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;

        const fetchOptions = {
          method: 'GET',
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            'Referer': 'https://www.instagram.com/'
          },
          signal
        };

        const { response: res } = await httpFetch(url, fetchOptions, {
          proxyUrl: options.proxyUrl,
          useKeepAlive: true
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} downloading ${url}`);
          err.status = res.status;
          throw err;
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.startsWith('text/html')) {
          const err = new Error(`Unexpected HTML response downloading ${url}`);
          err.nonRetryable = true;
          throw err;
        }

        if (res.body) {
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tempPath));
        } else {
          const buffer = await res.arrayBuffer();
          fs.writeFileSync(tempPath, Buffer.from(buffer));
        }

        const stat = fs.statSync(tempPath);
        if (stat.size === 0) {
          throw new Error(`Empty response body downloading ${url}`);
        }

        fs.renameSync(tempPath, destPath);
        return true; // Newly downloaded
      } catch (err) {
        lastErr = err;
        // Always clean up partial temp file on failure
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        if (err.nonRetryable || (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) || options.signal?.aborted) {
          throw err;
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
        }
      }
    }

    throw lastErr || new Error(`Failed downloading ${url}`);
  };

  return typeof options._limiter === 'function' ? options._limiter(exec) : exec();
}

/**
 * Traverses JSON object to extract Polaris media objects
 */
function extractMediaObjects(obj, collected = []) {
  if (!obj || typeof obj !== 'object') return collected;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractMediaObjects(item, collected);
    }
    return collected;
  }

  // Identify Instagram media object
  if (obj.display_uri || obj.video_url || obj.pk || obj.code) {
    if (obj.display_uri || obj.video_url) {
      const pk = obj.pk || obj.id || (obj.code ? `code_${obj.code}` : null);
      const code = obj.code || (obj.seo_canonical_url ? obj.seo_canonical_url.split('/').filter(Boolean).pop() : pk);
      
      let captionText = '';
      if (typeof obj.caption === 'string') {
        captionText = obj.caption;
      } else if (obj.caption && typeof obj.caption === 'object' && obj.caption.text) {
        captionText = obj.caption.text;
      } else if (obj.accessibility_caption) {
        captionText = obj.accessibility_caption;
      }

      const rawVideo = obj.video_url || obj.video_versions?.[0]?.url || null;
      const rawDisplay = obj.image_versions2?.candidates?.[0]?.url || obj.display_uri || obj.display_url || null;

      let isVideo = obj.media_type === 2 || obj.product_type === 'clips' || Boolean(rawVideo);
      const isCarousel = obj.product_type === 'carousel_container' ||
                         obj.media_type === 8 ||
                         (obj.carousel_media_count && obj.carousel_media_count > 1) ||
                         Boolean(obj.carousel_media);

      // Clean display URL
      const displayUrl = rawDisplay
        ? rawDisplay.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
        : null;

      const videoUrl = rawVideo
        ? rawVideo.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
        : null;

      if (displayUrl || videoUrl) {
        collected.push({
          pk: String(pk || Date.now()),
          code: String(code || pk || Date.now()),
          displayUrl,
          videoUrl,
          isVideo,
          isCarousel,
          carouselCount: obj.carousel_media_count || (Array.isArray(obj.carousel_media) ? obj.carousel_media.length : 0),
          caption: captionText,
          productType: obj.product_type || (isCarousel ? 'carousel_container' : 'feed'),
          canonicalUrl: obj.seo_canonical_url || (code ? `https://www.instagram.com/p/${code}/` : '')
        });
      }
    }
  }

  for (const key of Object.keys(obj)) {
    extractMediaObjects(obj[key], collected);
  }

  return collected;
}

/**
 * Extract user ID and profile info from HTML
 */
function extractProfileDetails(html, targetUsername = '') {
  const clean = (targetUsername || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  let userId = null;
  let avatarUrl = null;
  let fullName = '';
  let bio = '';

  // 1. Avatar from og:image
  const ogImgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i);
  if (ogImgMatch) {
    avatarUrl = ogImgMatch[1].replace(/&amp;/g, '&');
  }

  // 2. Full Name from og:title or <title>
  const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ||
                       html.match(/<title>([^<]*)<\/title>/i);
  if (ogTitleMatch) {
    const rawTitle = ogTitleMatch[1]
      .replace(/&#064;/g, '@')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    const nameMatch = rawTitle.match(/^(.*?)(?:\s*\(@[a-zA-Z0-9_.]+\))?\s*•\s*Instagram/i);
    if (nameMatch && nameMatch[1].trim()) fullName = nameMatch[1].trim();
  }

  // 3. Bio from meta description
  const metaDescMatch = html.match(/<meta\s+(?:content="([^"]*)"\s+name="description"|name="description"\s+content="([^"]*)")/i);
  const metaDesc = metaDescMatch ? (metaDescMatch[1] || metaDescMatch[2]) : '';
  const bioMatch = metaDesc.replace(/&quot;/g, '"').match(/on Instagram:\s*"([\s\S]*?)"/);
  if (bioMatch) bio = bioMatch[1].trim();

  // 4. Find userId matching the target username specifically
  const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const s of scripts) {
    if (clean && s.includes(`"${clean}"`)) {
      try {
        const obj = JSON.parse(s);
        function findTargetUserId(o) {
          if (!o || typeof o !== 'object' || userId) return;
          if (o.username?.toLowerCase() === clean && (o.id || o.pk)) {
            userId = String(o.id || o.pk);
            return;
          }
          for (const k of Object.keys(o)) findTargetUserId(o[k]);
        }
        findTargetUserId(obj);
        if (userId) break;
      } catch (e) {}
    }
  }

  return { userId, avatarUrl, fullName, bio };
}

/**
 * Extract highlight reels from profile JSON scripts
 */
function extractHighlightsFromScripts(scripts) {
  const highlights = [];
  const seenIds = new Set();

  for (const s of scripts) {
    if (s.includes('lox_highlights_connection') || s.includes('XIGHighlightReel') || s.includes('highlight:')) {
      try {
        const parsed = JSON.parse(s);

        function scanForReels(obj, depth = 0) {
          if (!obj || typeof obj !== 'object' || depth > 15) return;

          if (obj.lox_highlights_connection && Array.isArray(obj.lox_highlights_connection.edges)) {
            for (const edge of obj.lox_highlights_connection.edges) {
              const node = edge.node;
              if (node && node.id) {
                const id = String(node.id).replace(/^highlight:/, '');
                if (!seenIds.has(id)) {
                  seenIds.add(id);
                  highlights.push({
                    id,
                    title: node.title || 'Highlight',
                    coverUrl: node.cover_media_cropped_thumbnail_url || node.cover_media?.thumbnail_src || node.cover_media?.cropped_image_version?.url || node.cover_media?.image_versions2?.candidates?.[0]?.url || null
                  });
                }
              }
            }
          }

          if (obj.__typename === 'XIGHighlightReel' || (obj.id && obj.title && ('cover_media_cropped_thumbnail_url' in obj || 'cover_media' in obj))) {
            const id = String(obj.id).replace(/^highlight:/, '');
            if (!seenIds.has(id)) {
              seenIds.add(id);
              highlights.push({
                id,
                title: obj.title || 'Highlight',
                coverUrl: obj.cover_media_cropped_thumbnail_url || obj.cover_media?.thumbnail_src || obj.cover_media?.cropped_image_version?.url || obj.cover_media?.image_versions2?.candidates?.[0]?.url || null
              });
            }
          }

          if (Array.isArray(obj)) {
            for (const item of obj) scanForReels(item, depth + 1);
          } else {
            for (const k of Object.keys(obj)) scanForReels(obj[k], depth + 1);
          }
        }

        scanForReels(parsed);
      } catch (e) {
        // continue
      }
    }
  }

  return highlights;
}

/**
 * Fetch real full-resolution media for any Instagram post/reel/carousel shortcode.
 * Resolves actual playable MP4 video_versions, full-res image_versions2, and all carousel slides.
 */
async function fetchPostMedia(shortcode, options = {}) {
  const result = {
    code: shortcode,
    isVideo: false,
    videoUrl: null,
    imageUrl: null,
    isCarousel: false,
    slides: []
  };
  if (!shortcode) return result;

  const url = `https://www.instagram.com/p/${shortcode}/`;
  const headers = getBrowserHeaders();
  const cookieHeader = formatCookieHeader(options.sessionCookie);
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  try {
    const { response: res } = await httpFetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    }, { proxyUrl: options.proxyUrl });

    if (!res.ok) return result;

    const html = await res.text();
    const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

    let postObj = null;
    for (const s of scripts) {
      if (s.includes(shortcode) && (s.includes('video_versions') || s.includes('image_versions2') || s.includes('carousel_media'))) {
        try {
          const parsed = JSON.parse(s);
          function scan(obj) {
            if (!obj || typeof obj !== 'object' || postObj) return;
            if (obj.code === shortcode && (obj.video_versions || obj.image_versions2 || obj.carousel_media)) {
              postObj = obj;
              return;
            }
            for (const k of Object.keys(obj)) {
              if (postObj) break;
              scan(obj[k]);
            }
          }
          scan(parsed);
          if (postObj) break;
        } catch (e) {}
      }
    }

    if (postObj) {
      const cleanUrl = (u) => u ? String(u).replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null;

      if (Array.isArray(postObj.carousel_media) && postObj.carousel_media.length > 0) {
        result.isCarousel = true;
        postObj.carousel_media.forEach((child, index) => {
          const childVideo = cleanUrl(child.video_versions?.[0]?.url || child.video_url);
          const childImg = cleanUrl(child.image_versions2?.candidates?.[0]?.url || child.display_uri);
          const isVid = child.media_type === 2 || Boolean(childVideo);
          if (childVideo || childImg) {
            result.slides.push({
              index: index + 1,
              id: String(child.pk || child.id || `${shortcode}_${index + 1}`),
              isVideo: isVid,
              url: (isVid && childVideo) ? childVideo : childImg,
              displayUrl: childImg
            });
          }
        });
      }

      result.videoUrl = cleanUrl(postObj.video_versions?.[0]?.url || postObj.video_url);
      result.imageUrl = cleanUrl(postObj.image_versions2?.candidates?.[0]?.url || postObj.display_uri);
      result.isVideo = postObj.media_type === 2 || postObj.product_type === 'clips' || Boolean(result.videoUrl);
    }
  } catch (err) {
    console.warn(`[PostMedia] Error resolving ${shortcode}:`, err.message);
  }

  return result;
}

/**
 * Fetch and extract all slides for a carousel post
 */
async function fetchPostSlides(shortcode, options = {}) {
  const resolved = await fetchPostMedia(shortcode, options);
  return resolved.slides || [];
}

/**
 * Fetch and download full highlight reels (all individual photos & videos inside each highlight)
 */
async function downloadAllHighlights(username, highlights = [], highlightsDir, options = {}, onProgress = null) {
  const result = { newlyDownloaded: 0, items: [], errors: [] };
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) return result;

  const isCache = options.isCache === true;
  const urlPrefix = isCache ? '/cache' : '/downloads';
  const cookieHeader = formatCookieHeader(options.sessionCookie || db.getSettings().sessionCookie);

  const recordMedia = (data) => {
    if (isCache) {
      return cacheManager.recordCachedItem(clean, data);
    }
    return db.recordDownloadedMedia(clean, data);
  };

  const downloadConcurrency = options.concurrency || config.DOWNLOAD_CONCURRENCY || 6;
  const metaConcurrency = options.metadataConcurrency || config.METADATA_CONCURRENCY || 3;

  await runWithConcurrency(highlights, metaConcurrency, async (hl) => {
    const hlId = String(hl.id).replace(/^highlight:/, '');
    const cleanTitle = (hl.title || 'Highlight')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'Highlight';

    // Dedicated folder for this highlight reel
    const hlDir = path.join(highlightsDir, `${cleanTitle}_${hlId}`);
    if (!fs.existsSync(hlDir)) {
      fs.mkdirSync(hlDir, { recursive: true });
    }

    let reelItems = [];

    // Method 1: Web Highlight Story Page SSR (Retrieves all story items inside this highlight)
    try {
      const hlUrl = `https://www.instagram.com/stories/highlights/${hlId}/`;
      const csrfMatch = cookieHeader ? cookieHeader.match(/csrftoken=([^;]+)/) : null;
      const csrf = csrfMatch ? csrfMatch[1] : '';

      let hlFetchOptions = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
          ...(csrf ? { 'X-CSRFToken': csrf } : {}),
          'X-IG-App-ID': '936619743392459',
          'X-ASBD-ID': '359341',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin'
        },
        signal: AbortSignal.timeout(15000)
      };

      const { response: res } = await httpFetch(hlUrl, hlFetchOptions, { proxyUrl: options.proxyUrl });
      if (res.ok) {
        const html = await res.text();
        const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

        for (const sc of scripts) {
          if (sc.includes('items') || sc.includes('reels_media')) {
            try {
              const parsed = JSON.parse(sc);

              function scanHighlightItems(obj, depth = 0) {
                if (!obj || typeof obj !== 'object' || depth > 15 || reelItems.length > 0) return;

                if (Array.isArray(obj.edges) && obj.edges.length > 0) {
                  for (const e of obj.edges) {
                    if (e.node && Array.isArray(e.node.items) && e.node.items.length > 0) {
                      reelItems = e.node.items;
                      return;
                    }
                  }
                }

                if (Array.isArray(obj.reels_media) && obj.reels_media.length > 0) {
                  for (const rm of obj.reels_media) {
                    if (Array.isArray(rm.items) && rm.items.length > 0) {
                      reelItems = rm.items;
                      return;
                    }
                  }
                }

                if (Array.isArray(obj.items) && obj.items.length > 0 && (obj.items[0].video_versions || obj.items[0].image_versions2)) {
                  reelItems = obj.items;
                  return;
                }

                for (const k of Object.keys(obj)) {
                  if (reelItems.length > 0) break;
                  if (typeof obj[k] === 'object') scanHighlightItems(obj[k], depth + 1);
                }
              }

              scanHighlightItems(parsed);
              if (reelItems.length > 0) break;
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      result.errors.push(`Highlight ${hl.title} fetch error: ${e.message}`);
    }

    // Method 2: Mobile Reels API Endpoint
    if (reelItems.length === 0) {
      try {
        const mobileHlUrl = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:${hlId}`;
        let mobFetchOptions = {
          method: 'GET',
          headers: {
            'User-Agent': 'Instagram 320.0.0.35.109 Android (33/13; 480dpi; 1080x2400; samsung; SM-G998B; p3s; exynos2100; en_US)',
            'X-IG-App-ID': '936619743392459',
            'Accept': '*/*',
            ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
          },
          signal: AbortSignal.timeout(12000)
        };
        const { response: mobRes } = await httpFetch(mobileHlUrl, mobFetchOptions, { proxyUrl: options.proxyUrl });
        if (mobRes.ok) {
          const mobData = await mobRes.json();
          const reel = mobData?.reels?.[`highlight:${hlId}`] || mobData?.reels?.[hlId];
          if (Array.isArray(reel?.items) && reel.items.length > 0) {
            reelItems = reel.items;
          }
        }
      } catch (me) {}
    }

    // Method 3: Web Reels Media Endpoint
    if (reelItems.length === 0) {
      try {
        const webHlUrl = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:${hlId}`;
        let webReelsOptions = {
          method: 'GET',
          headers: {
            'User-Agent': getRandomUserAgent(),
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
            ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
            'Referer': `https://www.instagram.com/stories/highlights/${hlId}/`,
            'Accept': '*/*'
          },
          signal: AbortSignal.timeout(12000)
        };
        const { response: webRes } = await httpFetch(webHlUrl, webReelsOptions, { proxyUrl: options.proxyUrl });
        if (webRes.ok) {
          const webData = await webRes.json();
          const reel = webData?.reels?.[`highlight:${hlId}`] || webData?.reels?.[hlId] || webData?.reels_media?.[0];
          if (Array.isArray(reel?.items) && reel.items.length > 0) {
            reelItems = reel.items;
          }
        }
      } catch (we) {}
    }

    // Process all items in this highlight reel concurrently
    if (reelItems.length > 0) {
      await runWithConcurrency(reelItems, downloadConcurrency, async (item, idx) => {
        const rawId = String(item.pk || item.id || idx).split('_')[0];
        const isVideo = (item.media_type === 2 || item.is_video === true) && (item.video_versions?.length > 0 || item.video_resources?.length > 0 || item.video_url);

        const videoUrl = item.video_versions?.[0]?.url || item.video_resources?.[0]?.src || item.video_url || null;
        const photoCandidate = item.image_versions2?.candidates?.[0]?.url ||
                               item.display_resources?.[item.display_resources.length - 1]?.src ||
                               item.display_url ||
                               item.display_uri ||
                               null;

        const mediaUrl = isVideo ? videoUrl : photoCandidate;
        if (!mediaUrl) return;

        const cleanUrl = mediaUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        const ext = isVideo ? 'mp4' : 'jpg';
        const fileName = `${rawId}.${ext}`;
        const destPath = path.join(hlDir, fileName);

        let thumbUrl = null;
        let thumbPath = null;
        let fileReady = false;

        // Download main media and video thumbnail in parallel
        const tasks = [
          downloadFile(cleanUrl, destPath, options)
            .then((downloaded) => { if (downloaded) fileReady = true; })
            .catch(() => {
              if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
                fileReady = true;
              }
            })
        ];

        if (isVideo && photoCandidate) {
          const cleanThumb = photoCandidate.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          const thumbFileName = `${rawId}_thumb.jpg`;
          const thumbDest = path.join(hlDir, thumbFileName);
          tasks.push(
            downloadFile(cleanThumb, thumbDest, options)
              .then(() => {
                thumbUrl = `${urlPrefix}/${clean}/highlights/${cleanTitle}_${hlId}/${thumbFileName}`;
                thumbPath = thumbDest;
              })
              .catch(() => {})
          );
        }

        await Promise.all(tasks);

        if (fileReady) {
          result.newlyDownloaded++;
          const recorded = recordMedia({
            id: `highlight_${hlId}_${rawId}`,
            code: rawId,
            highlightId: hlId,
            highlightTitle: hl.title,
            type: isVideo ? 'highlight_video' : 'highlight_photo',
            fileName,
            filePath: destPath,
            fileUrl: `${urlPrefix}/${clean}/highlights/${cleanTitle}_${hlId}/${fileName}`,
            thumbnailUrl: thumbUrl || `${urlPrefix}/${clean}/highlights/${cleanTitle}_${hlId}/${fileName}`,
            thumbnailPath: thumbPath || destPath,
            caption: `Highlight: ${hl.title} (${item.taken_at ? new Date(item.taken_at * 1000).toLocaleDateString() : 'Story'})`
          });
          result.items.push(recorded);
          if (typeof onProgress === 'function') {
            onProgress({ type: 'ITEM_DOWNLOADED', item: recorded, current: result.newlyDownloaded, total: reelItems.length });
          }
        }
      });
    } else {
      // Fallback: If no items returned or rate limited, download the highlight cover
      const coverUrl = hl.coverUrl;
      if (coverUrl) {
        const destPath = path.join(highlightsDir, `${hlId}.jpg`);
        try {
          const downloaded = await downloadFile(coverUrl, destPath, options);
          if (downloaded || (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000)) {
            result.newlyDownloaded++;
            const recorded = recordMedia({
              id: `highlight_${hlId}`,
              code: hlId,
              highlightId: hlId,
              highlightTitle: hl.title,
              type: 'highlight',
              fileName: `${hlId}.jpg`,
              filePath: destPath,
              fileUrl: `${urlPrefix}/${clean}/highlights/${hlId}.jpg`,
              thumbnailUrl: `${urlPrefix}/${clean}/highlights/${hlId}.jpg`,
              thumbnailPath: destPath,
              caption: `Highlight Cover: ${hl.title}`
            });
            result.items.push(recorded);
          }
        } catch (ce) {}
      }
    }
  });

  return result;
}

/**
 * Main Content Downloader with Deduplication, Slides & Highlights
 * @param {string} username - Target Instagram handle
 * @param {object} options - { proxyUrl, sessionCookie }
 * @param {function} onProgress - Optional callback for live item-by-item progress
 */
async function downloadTargetContent(username, options = {}, onProgress = null) {
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) return { totalCount: 0, downloadedItems: [] };
  const isCache = options.isCache === true;
  const rootDir = isCache ? config.CACHE_DIR : config.DOWNLOADS_DIR;
  const urlPrefix = isCache ? '/cache' : '/downloads';
  const userDir = path.join(rootDir, clean);
  const postsDir = path.join(userDir, 'posts');
  const highlightsDir = path.join(userDir, 'highlights');
  const storiesDir = path.join(userDir, 'stories');
  const profileDir = path.join(userDir, 'profile');

  const recordMedia = (data) => {
    if (isCache) {
      return cacheManager.recordCachedItem(clean, data);
    }
    return db.recordDownloadedMedia(clean, data);
  };

  // Ensure directories exist
  [userDir, postsDir, highlightsDir, storiesDir, profileDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const startedAt = Date.now();
  const downloadConcurrency = options.concurrency || config.DOWNLOAD_CONCURRENCY || 6;
  const metaConcurrency = options.metadataConcurrency || config.METADATA_CONCURRENCY || 3;
  const dlOptions = { ...options, _limiter: options._limiter || createLimiter(downloadConcurrency) };

  const summary = {
    username: clean,
    totalFound: 0,
    newlyDownloaded: 0,
    skipped: 0,
    downloadedItems: [],
    errors: [],
    durationMs: 0,
    itemsPerSec: 0,
    source: 'instagram'
  };

  db.addLog(`Starting high-speed ${isCache ? 'temporary ' : ''}content download (concurrency=${downloadConcurrency}) for @${clean}...`, 'info', clean);

  try {
    let html = '';
    let userId = null;
    let avatarUrl = null;
    let fullName = '';
    let bio = '';
    let isPrivateProfile = false;
    let allMedia = [];
    let scripts = [];
    let stage1Blocked = false;

    // Stage 1: Direct Instagram Profile HTML
    const profileUrl = `https://www.instagram.com/${clean}/`;
    const profileHeaders = getBrowserHeaders();
    const profileCookie = formatCookieHeader(options.sessionCookie);
    if (profileCookie) {
      profileHeaders['Cookie'] = profileCookie;
    }

    try {
      let { response: res } = await httpFetch(profileUrl, {
        method: 'GET',
        headers: profileHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      }, { proxyUrl: options.proxyUrl });

      if (profileCookie && isLoginWallResponse(res)) {
        // Retry anonymously if cookie triggered a login/checkpoint challenge
        const retry = await httpFetch(profileUrl, {
          method: 'GET',
          headers: getBrowserHeaders(),
          redirect: 'follow',
          signal: AbortSignal.timeout(15000)
        }, { proxyUrl: options.proxyUrl });
        res = retry.response;
      }

      if (res.status === 404) {
        throw new Error(`Account @${clean} does not exist (HTTP 404)`);
      }

      if (res.ok) {
        html = await res.text();
        if (isLoginWallResponse(res, html, clean)) {
          stage1Blocked = true;
          summary.blockedByInstagram = true;
          summary.errors.push('Instagram blocked this cloud server IP (login wall / datacenter IP block). Add a Proxy URL or burner Session Cookie in Settings, or run locally.');
          html = '';
        } else {
          if (/this account is private|follow to see their photos and videos/i.test(html)) {
            isPrivateProfile = true;
          }
          const details = extractProfileDetails(html, clean);
          userId = details.userId;
          avatarUrl = details.avatarUrl;
          fullName = details.fullName;
          bio = details.bio;

          scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
          for (const scriptContent of scripts) {
            if (scriptContent.includes('display_uri') || scriptContent.includes('display_url') || scriptContent.includes('video_url') || scriptContent.includes('carousel') || scriptContent.includes('edge_owner_to_timeline_media')) {
              try {
                const parsed = JSON.parse(scriptContent);
                const found = extractMediaObjects(parsed);
                allMedia.push(...found);
              } catch (e) {}
            }
          }
        }
      } else {
        stage1Blocked = true;
        summary.errors.push(`Direct Instagram HTML returned HTTP ${res.status}`);
      }
    } catch (stage1Err) {
      if (stage1Err.message && stage1Err.message.includes('HTTP 404')) {
        throw stage1Err;
      }
      stage1Blocked = true;
      summary.errors.push(`Direct fetch fallback triggered: ${stage1Err.message}`);
    }

    // Stage 2: Instagram Web Profile Info API Fallback (when Stage 1 is blocked or returned 0 posts)
    if ((stage1Blocked || allMedia.length === 0) && !isPrivateProfile) {
      try {
        const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`;
        const apiHeaders = {
          'User-Agent': getRandomUserAgent(),
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': '*/*',
          'Referer': `https://www.instagram.com/${clean}/`,
          ...(profileCookie ? { 'Cookie': profileCookie } : {})
        };
        const { response: apiRes } = await httpFetch(apiUrl, {
          method: 'GET',
          headers: apiHeaders,
          signal: AbortSignal.timeout(12000)
        }, { proxyUrl: options.proxyUrl });

        if (apiRes.ok) {
          const apiData = await apiRes.json();
          const user = apiData?.data?.user;
          if (user) {
            summary.source = 'instagram_api';
            userId = userId || (user.id ? String(user.id) : null);
            avatarUrl = avatarUrl || user.profile_pic_url_hd || user.profile_pic_url || null;
            fullName = fullName || user.full_name || '';
            bio = bio || user.biography || '';
            if (user.is_private === true) {
              isPrivateProfile = true;
            }
            const edges = user.edge_owner_to_timeline_media?.edges || [];
            for (const edge of edges) {
              const node = edge?.node;
              if (!node) continue;
              const code = node.shortcode || String(node.id);
              const captionText = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
              const sidecarEdges = node.edge_sidecar_to_children?.edges || [];
              const preloadedSlides = sidecarEdges.map((se, i) => ({
                index: i + 1,
                id: String(se.node?.id || `${code}_${i + 1}`),
                isVideo: Boolean(se.node?.is_video && se.node?.video_url),
                url: (se.node?.is_video && se.node?.video_url) ? se.node.video_url : se.node?.display_url,
                displayUrl: se.node?.display_url || null
              })).filter(s => Boolean(s.url));

              allMedia.push({
                pk: String(node.id || code),
                code: String(code),
                displayUrl: node.display_url || null,
                videoUrl: node.video_url || null,
                isVideo: Boolean(node.is_video),
                isCarousel: preloadedSlides.length > 1,
                carouselCount: preloadedSlides.length,
                preloadedSlides: preloadedSlides.length > 1 ? preloadedSlides : null,
                caption: captionText,
                productType: preloadedSlides.length > 1 ? 'carousel_container' : 'feed',
                canonicalUrl: `https://www.instagram.com/p/${code}/`
              });
            }
          }
        }
      } catch (apiErr) {
        summary.errors.push(`Web API fallback error: ${apiErr.message}`);
      }
    }

    // Stage 3: Anonymous Public Mirror Fallback (works even when Render datacenter IPs are blocked by Instagram)
    if (allMedia.length === 0 && !isPrivateProfile) {
      try {
        const mirrorRes = await anonyigProvider.fetchPublicMirrorMedia(clean);
        if (mirrorRes && mirrorRes.success && Array.isArray(mirrorRes.items) && mirrorRes.items.length > 0) {
          summary.source = `mirror_${mirrorRes.provider || 'public'}`;
          mirrorRes.items.forEach((m, idx) => {
            if (m.url) {
              allMedia.push({
                pk: `mirror_${idx + 1}`,
                code: `mirror_${idx + 1}`,
                displayUrl: m.url,
                videoUrl: null,
                isVideo: false,
                isCarousel: false,
                carouselCount: 0,
                caption: `Public post via anonymous mirror (${mirrorRes.provider || 'mirror'})`,
                productType: 'feed',
                canonicalUrl: `https://www.instagram.com/${clean}/`
              });
            }
          });
        }
      } catch (mirrorErr) {
        summary.errors.push(`Mirror fallback error: ${mirrorErr.message}`);
      }
    }

    if (isPrivateProfile && allMedia.length === 0) {
      summary.isPrivate = true;
    }

    // Save profile bio text
    if (bio || fullName || userId) {
      fs.writeFileSync(path.join(profileDir, 'profile_info.json'), JSON.stringify({
        username: clean,
        fullName,
        bio,
        userId,
        updatedAt: new Date().toISOString()
      }, null, 2));
    }

    // Unique posts map by pk / code
    const uniquePostsMap = new Map();
    for (const item of allMedia) {
      const key = item.code || item.pk;
      if (key && !uniquePostsMap.has(key)) {
        uniquePostsMap.set(key, item);
      }
    }

    const uniquePosts = Array.from(uniquePostsMap.values());
    summary.totalFound += uniquePosts.length;

    // 3. Discover Highlights
    let highlights = extractHighlightsFromScripts(scripts);
    if (highlights.length === 0) {
      const knownHlIds = new Set();
      const dbHighlights = db.getDownloadedMedia(clean).filter(m => m.type?.includes('highlight'));
      for (const h of dbHighlights) {
        if (h.highlightId && !knownHlIds.has(h.highlightId)) {
          knownHlIds.add(h.highlightId);
          const remoteCover = [h.thumbnailUrl, h.fileUrl].find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
          highlights.push({
            id: h.highlightId,
            title: h.highlightTitle || 'Highlight',
            coverUrl: remoteCover
          });
        }
      }
    }
    summary.totalFound += highlights.length;

    // 4. Execute Avatar, Highlights, Posts/Carousels, and Active Stories IN PARALLEL (bounded by shared _limiter)!
    const avatarTask = async () => {
      if (!avatarUrl) return;
      const avatarPath = path.join(profileDir, 'avatar.jpg');
      const avatarMediaId = `avatar_${clean}`;
      try {
        const downloaded = await downloadFile(avatarUrl, avatarPath, dlOptions);
        if (downloaded) {
          summary.newlyDownloaded++;
          const item = recordMedia({
            id: avatarMediaId,
            code: 'avatar',
            type: 'profile_pic',
            fileName: 'avatar.jpg',
            filePath: avatarPath,
            fileUrl: `${urlPrefix}/${clean}/profile/avatar.jpg`,
            thumbnailUrl: `${urlPrefix}/${clean}/profile/avatar.jpg`,
            thumbnailPath: avatarPath,
            caption: `${fullName || clean} Profile Picture`
          });
          summary.downloadedItems.push(item);
          if (typeof onProgress === 'function') {
            onProgress({ type: 'ITEM_DOWNLOADED', item, current: summary.newlyDownloaded, total: summary.totalFound });
          }
        }
      } catch (err) {
        summary.errors.push(`Avatar download failed: ${err.message}`);
      }
    };

    const highlightsTask = async () => {
      if (highlights.length === 0) return;
      const hlResult = await downloadAllHighlights(clean, highlights, highlightsDir, dlOptions, onProgress);
      summary.newlyDownloaded += hlResult.newlyDownloaded;
      summary.downloadedItems.push(...hlResult.items);
      if (hlResult.errors?.length > 0) {
        summary.errors.push(...hlResult.errors);
      }
    };

    const postsTask = async () => {
      // Split carousel posts (need page fetch) vs direct single posts (immediate CDN download)
      const carouselPosts = [];
      const singlePosts = [];

      for (const post of uniquePosts) {
        const isCarousel = post.isCarousel || post.productType === 'carousel_container' || (post.carouselCount && post.carouselCount > 1);
        if (isCarousel) carouselPosts.push(post);
        else singlePosts.push(post);
      }

      // Download single posts concurrently at high speed while resolving carousel slides in parallel
      const singleDownloadPromise = runWithConcurrency(singlePosts, downloadConcurrency, async (post) => {
        const mediaId = post.pk || post.code;
        let resolvedVideoUrl = post.videoUrl || null;
        let resolvedDisplayUrl = post.displayUrl || null;

        // Profile grid HTML omits video_versions & full-res image_versions2 — resolve real MP4 / HD image!
        if (post.code && ((post.isVideo && !resolvedVideoUrl) || (resolvedDisplayUrl && resolvedDisplayUrl.includes('s640x640')))) {
          const resolved = await fetchPostMedia(post.code, dlOptions);
          if (resolved.videoUrl) resolvedVideoUrl = resolved.videoUrl;
          if (resolved.imageUrl) resolvedDisplayUrl = resolved.imageUrl;
        }

        const isVideoWithSource = (post.isVideo || Boolean(resolvedVideoUrl)) && Boolean(resolvedVideoUrl);
        const ext = isVideoWithSource ? 'mp4' : 'jpg';
        const mainFileName = `${post.code}.${ext}`;
        const mainPath = path.join(postsDir, mainFileName);
        const thumbFileName = `${post.code}_thumb.jpg`;
        const thumbPath = path.join(postsDir, thumbFileName);

        try {
          let fileReady = false;
          let downloadedThumb = false;

          if (isVideoWithSource) {
            // Download real MP4 video and full-res thumbnail simultaneously
            const dlTasks = [
              downloadFile(resolvedVideoUrl, mainPath, dlOptions)
                .then(vidDl => {
                  if (vidDl || (fs.existsSync(mainPath) && fs.statSync(mainPath).size > 1000)) {
                    fileReady = true;
                  }
                })
            ];
            if (resolvedDisplayUrl) {
              dlTasks.push(
                downloadFile(resolvedDisplayUrl, thumbPath, dlOptions)
                  .then(() => { downloadedThumb = true; })
                  .catch(() => {})
              );
            }
            await Promise.all(dlTasks);
          } else if (resolvedDisplayUrl) {
            const imgDownloaded = await downloadFile(resolvedDisplayUrl, mainPath, dlOptions);
            if (imgDownloaded || (fs.existsSync(mainPath) && fs.statSync(mainPath).size > 1000)) {
              fileReady = true;
            }
          }

          if (fileReady) {
            summary.newlyDownloaded++;

            if (post.caption) {
              fs.writeFileSync(path.join(postsDir, `${post.code}_caption.txt`), post.caption, 'utf-8');
            }
            fs.writeFileSync(path.join(postsDir, `${post.code}.json`), JSON.stringify(post, null, 2), 'utf-8');

            const record = recordMedia({
              id: mediaId,
              code: post.code,
              type: post.isVideo ? 'video_post' : 'photo_post',
              fileName: mainFileName,
              filePath: mainPath,
              fileUrl: `${urlPrefix}/${clean}/posts/${mainFileName}`,
              thumbnailUrl: (isVideoWithSource && downloadedThumb) ? `${urlPrefix}/${clean}/posts/${thumbFileName}` : `${urlPrefix}/${clean}/posts/${mainFileName}`,
              thumbnailPath: (isVideoWithSource && downloadedThumb) ? thumbPath : mainPath,
              caption: post.caption
            });
            summary.downloadedItems.push(record);
            if (typeof onProgress === 'function') {
              onProgress({ type: 'ITEM_DOWNLOADED', item: record, current: summary.newlyDownloaded, total: summary.totalFound });
            }
          }
        } catch (postErr) {
          summary.errors.push(`Post ${post.code} download error: ${postErr.message}`);
        }
      });

      const carouselDownloadPromise = runWithConcurrency(carouselPosts, metaConcurrency, async (post) => {
        const slides = Array.isArray(post.preloadedSlides) && post.preloadedSlides.length > 0
          ? post.preloadedSlides
          : await fetchPostSlides(post.code, dlOptions);
        if (slides.length > 0) {
          summary.totalFound += slides.length;

          if (post.caption) {
            fs.writeFileSync(path.join(postsDir, `${post.code}_caption.txt`), post.caption, 'utf-8');
          }
          fs.writeFileSync(path.join(postsDir, `${post.code}.json`), JSON.stringify({ ...post, slides }, null, 2), 'utf-8');

          await runWithConcurrency(slides, downloadConcurrency, async (slide) => {
            const slideId = `${post.code}_slide_${slide.index}`;
            const ext = slide.isVideo ? 'mp4' : 'jpg';
            const fileName = `${post.code}_slide_${slide.index}.${ext}`;
            const destPath = path.join(postsDir, fileName);

            try {
              let thumbnailUrl = null;
              let thumbnailPath = null;
              let downloaded = false;

              const slideTasks = [
                downloadFile(slide.url, destPath, dlOptions).then(ok => { downloaded = ok; })
              ];

              if (slide.isVideo && slide.displayUrl) {
                const thumbFileName = `${post.code}_slide_${slide.index}_thumb.jpg`;
                const tPath = path.join(postsDir, thumbFileName);
                slideTasks.push(
                  downloadFile(slide.displayUrl, tPath, dlOptions)
                    .then(() => {
                      thumbnailPath = tPath;
                      thumbnailUrl = `${urlPrefix}/${clean}/posts/${thumbFileName}`;
                    })
                    .catch(() => {})
                );
              } else if (!slide.isVideo) {
                thumbnailUrl = `${urlPrefix}/${clean}/posts/${fileName}`;
                thumbnailPath = destPath;
              }

              await Promise.all(slideTasks);

              if (downloaded) {
                summary.newlyDownloaded++;
                const record = recordMedia({
                  id: slideId,
                  code: post.code,
                  slideIndex: slide.index,
                  totalSlides: slides.length,
                  type: slide.isVideo ? 'carousel_video_slide' : 'carousel_slide',
                  fileName,
                  filePath: destPath,
                  fileUrl: `${urlPrefix}/${clean}/posts/${fileName}`,
                  thumbnailUrl: thumbnailUrl || `${urlPrefix}/${clean}/posts/${fileName}`,
                  thumbnailPath,
                  caption: `${post.caption ? post.caption + ' ' : ''}(Slide ${slide.index}/${slides.length})`
                });
                summary.downloadedItems.push(record);
                if (typeof onProgress === 'function') {
                  onProgress({ type: 'ITEM_DOWNLOADED', item: record, current: summary.newlyDownloaded, total: summary.totalFound });
                }
              }
            } catch (slideErr) {
              summary.errors.push(`Slide ${slide.index} of post ${post.code} error: ${slideErr.message}`);
            }
          });
        } else if (post.displayUrl || post.videoUrl) {
          // Fallback to cover media if carousel slide extraction returned empty
          const mediaId = post.pk || post.code;
          const ext = post.isVideo && post.videoUrl ? 'mp4' : 'jpg';
          const mainFileName = `${post.code}.${ext}`;
          const mainPath = path.join(postsDir, mainFileName);
          try {
            const downloaded = await downloadFile(post.isVideo && post.videoUrl ? post.videoUrl : post.displayUrl, mainPath, dlOptions);
            if (downloaded) {
              summary.newlyDownloaded++;
              const record = recordMedia({
                id: mediaId,
                code: post.code,
                type: post.isVideo ? 'video_post' : 'photo_post',
                fileName: mainFileName,
                filePath: mainPath,
                fileUrl: `${urlPrefix}/${clean}/posts/${mainFileName}`,
                thumbnailUrl: `${urlPrefix}/${clean}/posts/${mainFileName}`,
                thumbnailPath: mainPath,
                caption: post.caption
              });
              summary.downloadedItems.push(record);
              if (typeof onProgress === 'function') {
                onProgress({ type: 'ITEM_DOWNLOADED', item: record, current: summary.newlyDownloaded, total: summary.totalFound });
              }
            }
          } catch (fallbackErr) {
            summary.errors.push(`Carousel ${post.code} fallback error: ${fallbackErr.message}`);
          }
        }
      });

      await Promise.all([singleDownloadPromise, carouselDownloadPromise]);
    };

    const storiesTask = async () => {
      try {
        const storiesResult = await downloadActiveStories(clean, userId, storiesDir, dlOptions, onProgress);
        summary.newlyDownloaded += storiesResult.newlyDownloaded;
        summary.downloadedItems.push(...storiesResult.items);
      } catch (storyErr) {
        summary.errors.push(`Story download error: ${storyErr.message}`);
      }
    };

    await Promise.all([
      avatarTask(),
      highlightsTask(),
      postsTask(),
      storiesTask()
    ]);

    if (isCache) {
      cacheManager.flushUserIndex(clean);
    }

    summary.durationMs = Date.now() - startedAt;
    summary.itemsPerSec = summary.durationMs > 0
      ? Number((summary.newlyDownloaded / (summary.durationMs / 1000)).toFixed(1))
      : summary.newlyDownloaded;

    if (summary.newlyDownloaded === 0 && (summary.blockedByInstagram || stage1Blocked)) {
      db.addLog(
        `⚠️ Instagram blocked this server's datacenter IP for @${clean} (0 files). Add a Proxy URL or burner IG Session Cookie in Settings, or run locally.`,
        'warning',
        clean
      );
    } else {
      db.addLog(
        `Content download complete for @${clean}: ${summary.newlyDownloaded} media files in ${(summary.durationMs / 1000).toFixed(1)}s (${summary.itemsPerSec} files/s, source=${summary.source}).`,
        summary.newlyDownloaded > 0 ? 'success' : 'info',
        clean
      );
    }

    return summary;
  } catch (err) {
    db.addLog(`Content download failed for @${clean}: ${err.message}`, 'error', clean);
    summary.errors.push(err.message);
    return summary;
  }
}

/**
 * Fetch and download active stories if session cookie is available
 */
async function downloadActiveStories(username, userId, storiesDir, options = {}, onProgress = null) {
  const result = { newlyDownloaded: 0, skipped: 0, items: [] };
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) return result;

  const settings = db.getSettings();
  const sessionCookie = options.sessionCookie || settings.sessionCookie;

  const isCache = options.isCache === true;
  const urlPrefix = isCache ? '/cache' : '/downloads';

  const recordMedia = (data) => {
    if (isCache) {
      return cacheManager.recordCachedItem(clean, data);
    }
    return db.recordDownloadedMedia(clean, data);
  };

  const cookieHeader = formatCookieHeader(sessionCookie);

  let items = [];

  // Method 1: Web Stories Page with Authenticated SSR Parsing (Most reliable for web sessions)
  try {
    const webStoriesUrl = `https://www.instagram.com/stories/${clean}/`;
    const csrfMatch = cookieHeader ? cookieHeader.match(/csrftoken=([^;]+)/) : null;
    const csrf = csrfMatch ? csrfMatch[1] : '';

    let webFetchOptions = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '359341',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin'
      },
      signal: AbortSignal.timeout(15000)
    };

    const { response: res } = await httpFetch(webStoriesUrl, webFetchOptions, { proxyUrl: options.proxyUrl });
    if (res.ok) {
      const html = await res.text();
      const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

      for (const s of scripts) {
        if (s.includes('reels_media') || s.includes('items')) {
          try {
            const parsed = JSON.parse(s);

            function scanForReelItems(obj, depth = 0) {
              if (!obj || typeof obj !== 'object' || depth > 15 || items.length > 0) return;

              // Check reels_media array
              if (Array.isArray(obj.reels_media) && obj.reels_media.length > 0) {
                for (const rm of obj.reels_media) {
                  const rmUser = rm.user?.username;
                  if ((!rmUser || rmUser.toLowerCase() === clean) && Array.isArray(rm.items) && rm.items.length > 0) {
                    items = rm.items;
                    return;
                  }
                }
              }

              // Check reels_media__connection edges
              if (Array.isArray(obj.edges) && obj.edges.length > 0) {
                for (const edge of obj.edges) {
                  const node = edge.node;
                  if (node && Array.isArray(node.items) && node.items.length > 0) {
                    const nodeUser = node.user?.username;
                    if (!nodeUser || nodeUser.toLowerCase() === clean) {
                      items = node.items;
                      return;
                    }
                  }
                }
              }

              // Check owner username / items directly
              const ownerUsername = obj.user?.username || obj.owner?.username;
              const matchesUser = ownerUsername && ownerUsername.toLowerCase() === clean;
              if (matchesUser && Array.isArray(obj.items) && obj.items.length > 0 && (obj.items[0].video_versions || obj.items[0].image_versions2)) {
                items = obj.items;
                return;
              }

              for (const k of Object.keys(obj)) {
                if (items.length > 0) break;
                scanForReelItems(obj[k], depth + 1);
              }
            }

            scanForReelItems(parsed);
            if (items.length > 0) break;
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  // Method 2: Mobile Story Endpoint (Fallback)
  if (items.length === 0 && userId) {
    try {
      const mobileUrl = `https://i.instagram.com/api/v1/feed/user/${userId}/story/`;
      let mobileFetchOptions = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
          'X-IG-App-ID': '936619743392459',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
          'Accept': '*/*'
        },
        signal: AbortSignal.timeout(10000)
      };

      const { response: res } = await httpFetch(mobileUrl, mobileFetchOptions, { proxyUrl: options.proxyUrl });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.reel?.items) && data.reel.items.length > 0) {
          items = data.reel.items;
        }
      }
    } catch (e) {}
  }

  // Method 3: Web Reels Media Endpoint (Fallback)
  if (items.length === 0 && userId) {
    try {
      const webUrl = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
      let reelsFetchOptions = {
        method: 'GET',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
          'Referer': `https://www.instagram.com/stories/${clean}/`,
          'Accept': '*/*'
        },
        signal: AbortSignal.timeout(10000)
      };

      const { response: res } = await httpFetch(webUrl, reelsFetchOptions, { proxyUrl: options.proxyUrl });
      if (res.ok) {
        const data = await res.json();
        const reel = data?.reels?.[userId] || data?.reels_media?.[0];
        if (Array.isArray(reel?.items) && reel.items.length > 0) {
          items = reel.items;
        }
      }
    } catch (e) {}
  }

  const downloadConcurrency = options.concurrency || config.DOWNLOAD_CONCURRENCY || 6;

  await runWithConcurrency(items, downloadConcurrency, async (item) => {
    const rawId = String(item.pk || item.id).split('_')[0];
    const storyId = `story_${rawId}`;

    const isVideo = (item.media_type === 2 || item.is_video === true) && (item.video_versions?.length > 0 || item.video_resources?.length > 0 || item.video_url);

    const videoUrl = item.video_versions?.[0]?.url || item.video_resources?.[0]?.src || item.video_url || null;
    const photoCandidate = item.image_versions2?.candidates?.[0]?.url ||
                           item.display_resources?.[item.display_resources.length - 1]?.src ||
                           item.display_url ||
                           item.display_uri ||
                           null;

    const mediaUrl = isVideo ? videoUrl : photoCandidate;
    const thumbCandidateUrl = photoCandidate;

    if (!mediaUrl) return;

    const cleanUrl = mediaUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const ext = isVideo ? 'mp4' : 'jpg';
    const fileName = `${rawId}.${ext}`;
    const destPath = path.join(storiesDir, fileName);

    let thumbnailUrl = null;
    let thumbnailPath = null;
    let fileReady = false;

    const storyTasks = [
      downloadFile(cleanUrl, destPath, options)
        .then(downloaded => { if (downloaded) fileReady = true; })
        .catch(() => {
          if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
            fileReady = true;
          }
        })
    ];

    if (isVideo && thumbCandidateUrl) {
      const cleanThumb = thumbCandidateUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      const thumbFileName = `${rawId}_thumb.jpg`;
      const thumbDestPath = path.join(storiesDir, thumbFileName);
      storyTasks.push(
        downloadFile(cleanThumb, thumbDestPath, options)
          .then(() => {
            thumbnailUrl = `${urlPrefix}/${clean}/stories/${thumbFileName}`;
            thumbnailPath = thumbDestPath;
          })
          .catch(() => {})
      );
    } else if (!isVideo) {
      thumbnailUrl = `${urlPrefix}/${clean}/stories/${fileName}`;
      thumbnailPath = destPath;
    }

    await Promise.all(storyTasks);

    if (fileReady) {
      result.newlyDownloaded++;
      const recorded = recordMedia({
        id: storyId,
        code: rawId,
        type: isVideo ? 'story_video' : 'story',
        fileName,
        filePath: destPath,
        fileUrl: `${urlPrefix}/${clean}/stories/${fileName}`,
        thumbnailUrl: thumbnailUrl || `${urlPrefix}/${clean}/stories/${fileName}`,
        thumbnailPath,
        caption: `Instagram Story (${item.taken_at ? new Date(item.taken_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Active Story'})`
      });
      result.items.push(recorded);
      if (typeof onProgress === 'function') {
        onProgress({
          type: 'ITEM_DOWNLOADED',
          item: recorded,
          current: result.newlyDownloaded,
          total: items.length
        });
      }
    }
  });

  return result;
}

/**
 * Standalone story fetcher used by Telegram bot & API
 * Fetches active stories for a user, downloads them, and returns an array of media objects.
 */
async function fetchActiveStories(username, options = {}) {
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) return { items: [] };

  const isCache = options.isCache === true;
  const rootDir = isCache ? config.CACHE_DIR : config.DOWNLOADS_DIR;
  const storiesDir = path.join(rootDir, clean, 'stories');
  if (!fs.existsSync(storiesDir)) {
    fs.mkdirSync(storiesDir, { recursive: true });
  }

  const settings = db.getSettings();
  const sessionCookie = options.sessionCookie || settings.sessionCookie;

  let userId = null;
  const target = db.getTarget(clean);
  if (target?.profileInfo?.userId) {
    userId = target.profileInfo.userId;
  }

  let result = { newlyDownloaded: 0, skipped: 0, items: [] };

  // Attempt story extraction (via authenticated session if configured, or public mobile/web headers)
  result = await downloadActiveStories(clean, userId, storiesDir, { ...options, sessionCookie });

  // If no stories found and userId is unknown, attempt to fetch userId and retry mobile/reels endpoints
  if (result.items.length === 0 && !userId) {
    try {
      const profileUrl = `https://www.instagram.com/${clean}/`;
      const res = await fetch(profileUrl, {
        headers: getBrowserHeaders(),
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const html = await res.text();
        const details = extractProfileDetails(html, clean);
        if (details.userId) {
          userId = details.userId;
          const retryResult = await downloadActiveStories(clean, userId, storiesDir, { ...options, sessionCookie });
          if (retryResult.items.length > 0) {
            result = retryResult;
          }
        }
      }
    } catch (e) {}
  }

  // Fallback: If no new items downloaded or session cookie not configured,
  // return existing stories on disk from database or directory
  if (result.items.length === 0) {
    const downloaded = db.getDownloadedMedia(clean).filter(m => m.type?.includes('story'));
    if (downloaded.length > 0) {
      result.items = downloaded.map(item => {
        let fullPath = item.filePath;
        if (!fullPath && item.fileUrl) {
          const rel = item.fileUrl.replace(/^\/downloads\//, '');
          fullPath = path.join(config.DOWNLOADS_DIR, rel);
        }
        return { ...item, filePath: fullPath };
      }).filter(item => item.filePath && fs.existsSync(item.filePath));
    } else if (fs.existsSync(storiesDir)) {
      const files = fs.readdirSync(storiesDir).filter(f => !f.includes('_thumb') && (f.endsWith('.jpg') || f.endsWith('.mp4')));
      result.items = files.map(f => {
        const isVideo = f.endsWith('.mp4');
        const rawId = f.split('.')[0];
        const filePath = path.join(storiesDir, f);
        return {
          id: `story_${rawId}`,
          code: rawId,
          type: isVideo ? 'story_video' : 'story',
          fileName: f,
          filePath,
          fileUrl: `/downloads/${clean}/stories/${f}`,
          caption: `Instagram Story (${new Date(fs.statSync(filePath).mtimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
        };
      });
    }
  }

  result.anonyigUrl = `https://anonyig.com/en2/?url=${encodeURIComponent(clean)}`;
  return result;
}

/**
 * Standalone highlight fetcher used by Telegram bot & API
 * Discovers and downloads full highlight reels (photos & videos) for a user.
 */
async function fetchHighlights(username, options = {}) {
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) return { items: [], highlights: [] };

  const isCache = options.isCache === true;
  const rootDir = isCache ? config.CACHE_DIR : config.DOWNLOADS_DIR;
  const highlightsDir = path.join(rootDir, clean, 'highlights');
  if (!fs.existsSync(highlightsDir)) {
    fs.mkdirSync(highlightsDir, { recursive: true });
  }

  const settings = db.getSettings();
  const sessionCookie = options.sessionCookie || settings.sessionCookie;

  // 1. Fetch profile page to discover highlights (using public browser headers where lox_highlights_connection is served)
  let discoveredHighlights = [];
  try {
    const profileUrl = `https://www.instagram.com/${clean}/`;
    const res = await fetch(profileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const html = await res.text();
      const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
      discoveredHighlights = extractHighlightsFromScripts(scripts);
    }
  } catch (e) {}

  // Fallback 1: If public fetch returned 0 highlights, try with cookie headers
  if (discoveredHighlights.length === 0 && sessionCookie) {
    try {
      const profileUrl = `https://www.instagram.com/${clean}/`;
      const formattedCookie = formatCookieHeader(sessionCookie);
      const cookieFetchOptions = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Cookie': formattedCookie,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'X-IG-App-ID': '936619743392459'
        },
        signal: AbortSignal.timeout(10000)
      };
      const { response: res } = await httpFetch(profileUrl, cookieFetchOptions, { proxyUrl: options.proxyUrl });
      if (res.ok) {
        const html = await res.text();
        const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
        discoveredHighlights = extractHighlightsFromScripts(scripts);
      }
    } catch (e) {}
  }

  // Fallback 2: Check database and existing folder names for known highlight IDs
  if (discoveredHighlights.length === 0) {
    const knownIds = new Set();
    const dbHighlights = db.getDownloadedMedia(clean).filter(m => m.type?.includes('highlight'));
    for (const h of dbHighlights) {
      if (h.highlightId && !knownIds.has(h.highlightId)) {
        knownIds.add(h.highlightId);
        const remoteCover = [h.thumbnailUrl, h.fileUrl].find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
        discoveredHighlights.push({
          id: h.highlightId,
          title: h.highlightTitle || 'Highlight',
          coverUrl: remoteCover
        });
      }
    }

    if (fs.existsSync(highlightsDir)) {
      try {
        const entries = fs.readdirSync(highlightsDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isDirectory()) {
            const parts = ent.name.split('_');
            const hlId = parts[parts.length - 1];
            const title = parts.slice(0, parts.length - 1).join('_') || 'Highlight';
            if (/^\d+$/.test(hlId) && !knownIds.has(hlId)) {
              knownIds.add(hlId);
              discoveredHighlights.push({ id: hlId, title, coverUrl: null });
            }
          }
        }
      } catch (e) {}
    }
  }

  let result = { newlyDownloaded: 0, items: [], highlights: discoveredHighlights };

  if (discoveredHighlights.length > 0) {
    const dlResult = await downloadAllHighlights(clean, discoveredHighlights, highlightsDir, { ...options, sessionCookie });
    result.newlyDownloaded = dlResult.newlyDownloaded;
    result.items = dlResult.items;
  }

  // Fallback 3: If no items returned, retrieve from database or disk
  if (result.items.length === 0) {
    const downloaded = db.getDownloadedMedia(clean).filter(m => m.type?.includes('highlight'));
    if (downloaded.length > 0) {
      result.items = downloaded;
    } else if (fs.existsSync(highlightsDir)) {
      function scanDir(dir) {
        const found = [];
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
              found.push(...scanDir(full));
            } else if (ent.isFile() && !ent.name.includes('_thumb') && !ent.name.endsWith('.json') && (ent.name.endsWith('.jpg') || ent.name.endsWith('.mp4'))) {
              const isVideo = ent.name.endsWith('.mp4');
              const rawId = ent.name.split('.')[0];
              const parentDirName = path.basename(dir);
              const hlTitle = parentDirName.includes('_') ? parentDirName.split('_')[0] : 'Highlight';
              found.push({
                id: `highlight_${rawId}`,
                code: rawId,
                highlightTitle: hlTitle,
                type: isVideo ? 'highlight_video' : 'highlight_photo',
                fileName: ent.name,
                filePath: full,
                fileUrl: `/downloads/${clean}/highlights/${path.relative(highlightsDir, full).replace(/\\/g, '/')}`,
                caption: `Highlight: ${hlTitle}`
              });
            }
          }
        } catch (e) {}
        return found;
      }
      result.items = scanDir(highlightsDir);
    }
  }

  result.anonyigUrl = `https://anonyig.com/en2/?url=${encodeURIComponent(clean)}`;
  return result;
}

/**
 * Phase 1: Instant Zero-Disk Profile Media Inspector (~1-2s)
 * Fetches profile metadata, post/reel media URLs, and highlight reel directory
 * WITHOUT writing any media files to disk. Media is downloaded on demand only
 * when the user clicks Download or ZIP.
 */
async function inspectProfileMedia(username, options = {}) {
  const startedAt = Date.now();
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) throw new Error('Invalid username format');

  const manifest = {
    username: clean,
    source: 'instagram',
    isPrivate: false,
    profile: { fullName: '', bio: '', userId: null, avatarUrl: null },
    highlights: [],
    items: [],
    errors: [],
    durationMs: 0
  };

  let html = '';
  let scripts = [];
  let allMedia = [];
  let stage1Blocked = false;
  const profileCookie = formatCookieHeader(options.sessionCookie);

  // Stage 1: Direct Instagram Profile HTML
  const profileUrl = `https://www.instagram.com/${clean}/`;
  const profileHeaders = getBrowserHeaders();
  if (profileCookie) profileHeaders['Cookie'] = profileCookie;

  try {
    let { response: res } = await httpFetch(profileUrl, {
      method: 'GET',
      headers: profileHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    }, { proxyUrl: options.proxyUrl });

    if (profileCookie && isLoginWallResponse(res)) {
      const retry = await httpFetch(profileUrl, {
        method: 'GET',
        headers: getBrowserHeaders(),
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      }, { proxyUrl: options.proxyUrl });
      res = retry.response;
    }

    if (res.status === 404) {
      throw new Error(`Account @${clean} does not exist (HTTP 404)`);
    }

    if (res.ok) {
      html = await res.text();
      if (isLoginWallResponse(res, html, clean)) {
        stage1Blocked = true;
        manifest.blockedByInstagram = true;
        manifest.errors.push('Instagram blocked this cloud server IP (datacenter IP block). Add a Proxy URL or burner IG Session Cookie in Settings, or use Backup Viewer / run locally.');
        html = '';
      } else {
        if (/this account is private|follow to see their photos and videos/i.test(html)) {
          manifest.isPrivate = true;
        }
        const details = extractProfileDetails(html, clean);
        manifest.profile = {
          fullName: details.fullName || '',
          bio: details.bio || '',
          userId: details.userId || null,
          avatarUrl: details.avatarUrl || null
        };
        scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
        for (const scriptContent of scripts) {
          if (scriptContent.includes('display_uri') || scriptContent.includes('display_url') || scriptContent.includes('video_url') || scriptContent.includes('carousel') || scriptContent.includes('edge_owner_to_timeline_media')) {
            try {
              const parsed = JSON.parse(scriptContent);
              allMedia.push(...extractMediaObjects(parsed));
            } catch (e) {}
          }
        }
      }
    } else {
      stage1Blocked = true;
      manifest.errors.push(`Instagram HTML returned HTTP ${res.status}`);
    }
  } catch (err) {
    if (err.message && err.message.includes('HTTP 404')) throw err;
    stage1Blocked = true;
    manifest.errors.push(err.message);
  }

  // Stage 2: Instagram Web Profile Info API Fallback
  if ((stage1Blocked || allMedia.length === 0) && !manifest.isPrivate) {
    try {
      const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`;
      const { response: apiRes } = await httpFetch(apiUrl, {
        method: 'GET',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': '*/*',
          'Referer': `https://www.instagram.com/${clean}/`,
          ...(profileCookie ? { 'Cookie': profileCookie } : {})
        },
        signal: AbortSignal.timeout(10000)
      }, { proxyUrl: options.proxyUrl });

      if (apiRes.ok) {
        const apiData = await apiRes.json();
        const user = apiData?.data?.user;
        if (user) {
          manifest.source = 'instagram_api';
          manifest.profile.userId = manifest.profile.userId || (user.id ? String(user.id) : null);
          manifest.profile.avatarUrl = manifest.profile.avatarUrl || user.profile_pic_url_hd || user.profile_pic_url || null;
          manifest.profile.fullName = manifest.profile.fullName || user.full_name || '';
          manifest.profile.bio = manifest.profile.bio || user.biography || '';
          if (user.is_private === true) manifest.isPrivate = true;

          const edges = user.edge_owner_to_timeline_media?.edges || [];
          for (const edge of edges) {
            const node = edge?.node;
            if (!node) continue;
            const code = node.shortcode || String(node.id);
            const captionText = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
            const sidecarEdges = node.edge_sidecar_to_children?.edges || [];
            const preloadedSlides = sidecarEdges.map((se, i) => ({
              index: i + 1,
              id: String(se.node?.id || `${code}_${i + 1}`),
              isVideo: Boolean(se.node?.is_video && se.node?.video_url),
              url: (se.node?.is_video && se.node?.video_url) ? se.node.video_url : se.node?.display_url,
              displayUrl: se.node?.display_url || null
            })).filter(s => Boolean(s.url));

            allMedia.push({
              pk: String(node.id || code),
              code: String(code),
              displayUrl: node.display_url || null,
              videoUrl: node.video_url || null,
              isVideo: Boolean(node.is_video),
              isCarousel: preloadedSlides.length > 1,
              carouselCount: preloadedSlides.length,
              preloadedSlides: preloadedSlides.length > 1 ? preloadedSlides : null,
              caption: captionText
            });
          }
        }
      }
    } catch (apiErr) {
      manifest.errors.push(`Web API fallback: ${apiErr.message}`);
    }
  }

  // Stage 3: Anonymous Public Mirror Fallback
  if (allMedia.length === 0 && !manifest.isPrivate) {
    try {
      const mirrorRes = await anonyigProvider.fetchPublicMirrorMedia(clean);
      if (mirrorRes && mirrorRes.success && Array.isArray(mirrorRes.items) && mirrorRes.items.length > 0) {
        manifest.source = `mirror_${mirrorRes.provider || 'public'}`;
        mirrorRes.items.forEach((m, idx) => {
          if (m.url) {
            allMedia.push({
              pk: `mirror_${idx + 1}`,
              code: `mirror_${idx + 1}`,
              displayUrl: m.url,
              videoUrl: null,
              isVideo: false,
              isCarousel: false,
              caption: `Public post via ${mirrorRes.provider || 'mirror'}`
            });
          }
        });
      }
    } catch (mirrorErr) {
      manifest.errors.push(`Mirror fallback: ${mirrorErr.message}`);
    }
  }

  // Build deduplicated item manifest (with proxied preview URLs for instant browser rendering)
  const makeProxyUrl = (u) => u ? `/api/media-proxy?url=${encodeURIComponent(u)}` : '';

  if (manifest.profile.avatarUrl) {
    manifest.items.push({
      id: `avatar_${clean}`,
      code: 'avatar',
      type: 'profile_pic',
      fileName: `${clean}_avatar.jpg`,
      mediaUrl: manifest.profile.avatarUrl,
      thumbnailUrl: makeProxyUrl(manifest.profile.avatarUrl),
      fileUrl: makeProxyUrl(manifest.profile.avatarUrl),
      isVideo: false,
      caption: `${manifest.profile.fullName || clean} Profile Picture`
    });
  }

  const seenKeys = new Set();
  for (const post of allMedia) {
    const key = post.code || post.pk;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (Array.isArray(post.preloadedSlides) && post.preloadedSlides.length > 0) {
      for (const slide of post.preloadedSlides) {
        const ext = slide.isVideo ? 'mp4' : 'jpg';
        const thumb = slide.displayUrl || slide.url;
        manifest.items.push({
          id: `${post.code}_slide_${slide.index}`,
          code: post.code,
          slideIndex: slide.index,
          totalSlides: post.preloadedSlides.length,
          type: slide.isVideo ? 'carousel_video_slide' : 'carousel_slide',
          fileName: `${post.code}_slide_${slide.index}.${ext}`,
          mediaUrl: slide.url,
          thumbnailUrl: makeProxyUrl(thumb),
          fileUrl: makeProxyUrl(slide.url),
          isVideo: Boolean(slide.isVideo),
          caption: `${post.caption ? post.caption + ' ' : ''}(Slide ${slide.index}/${post.preloadedSlides.length})`
        });
      }
    } else {
      const isVideo = Boolean(post.isVideo || post.videoUrl);
      const isCarousel = Boolean(post.isCarousel || (post.carouselCount && post.carouselCount > 1));
      const mediaUrl = post.videoUrl || post.displayUrl;
      if (!mediaUrl) continue;
      const thumbUrl = post.displayUrl || mediaUrl;
      const ext = isVideo ? 'mp4' : 'jpg';
      const needsResolve = Boolean(
        post.code &&
        !String(post.code).startsWith('mirror_') &&
        ((isVideo && !post.videoUrl) || isCarousel || (post.displayUrl && post.displayUrl.includes('s640x640')))
      );
      manifest.items.push({
        id: String(post.pk || post.code),
        code: String(post.code || post.pk),
        type: isVideo ? 'video_post' : (isCarousel ? 'carousel_slide' : 'photo_post'),
        fileName: `${post.code || post.pk}.${ext}`,
        mediaUrl,
        thumbnailUrl: makeProxyUrl(thumbUrl),
        fileUrl: makeProxyUrl(mediaUrl),
        isVideo,
        isCarousel,
        needsResolve,
        caption: post.caption || ''
      });
    }
  }

  // Discover highlight reel headers (downloaded on demand when user selects a reel!)
  const discoveredHighlights = extractHighlightsFromScripts(scripts);
  manifest.highlights = discoveredHighlights.map(h => ({
    id: h.id,
    title: h.title || 'Highlight',
    coverUrl: h.coverUrl || null,
    previewUrl: makeProxyUrl(h.coverUrl)
  }));

  manifest.durationMs = Date.now() - startedAt;
  cacheManager.setInspectManifest(clean, manifest);
  return manifest;
}

/**
 * Inspect media items inside a single highlight reel on demand (zero disk writes).
 */
async function inspectHighlightReel(username, highlightId, highlightTitle = 'Highlight', options = {}) {
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  const hlId = String(highlightId || '').replace(/^highlight:/, '');
  if (!clean || !hlId) return [];

  const cookieHeader = formatCookieHeader(options.sessionCookie || db.getSettings().sessionCookie);
  const csrfMatch = cookieHeader ? cookieHeader.match(/csrftoken=([^;]+)/) : null;
  const csrf = csrfMatch ? csrfMatch[1] : '';
  let reelItems = [];

  // Try Web SSR -> Mobile Reels -> Web Reels
  try {
    const { response: res } = await httpFetch(`https://www.instagram.com/stories/highlights/${hlId}/`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        'X-IG-App-ID': '936619743392459'
      },
      signal: AbortSignal.timeout(12000)
    }, { proxyUrl: options.proxyUrl });

    if (res.ok) {
      const html = await res.text();
      const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
      for (const sc of scripts) {
        if (sc.includes('items') || sc.includes('reels_media')) {
          try {
            const parsed = JSON.parse(sc);
            function scan(obj, depth = 0) {
              if (!obj || typeof obj !== 'object' || depth > 15 || reelItems.length > 0) return;
              if (Array.isArray(obj.reels_media)) {
                for (const rm of obj.reels_media) {
                  if (Array.isArray(rm.items) && rm.items.length > 0) { reelItems = rm.items; return; }
                }
              }
              if (Array.isArray(obj.edges)) {
                for (const e of obj.edges) {
                  if (e.node && Array.isArray(e.node.items) && e.node.items.length > 0) { reelItems = e.node.items; return; }
                }
              }
              if (Array.isArray(obj.items) && obj.items.length > 0 && (obj.items[0].video_versions || obj.items[0].image_versions2)) {
                reelItems = obj.items; return;
              }
              for (const k of Object.keys(obj)) {
                if (reelItems.length > 0) break;
                if (typeof obj[k] === 'object') scan(obj[k], depth + 1);
              }
            }
            scan(parsed);
            if (reelItems.length > 0) break;
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  if (reelItems.length === 0) {
    try {
      const { response: mobRes } = await httpFetch(`https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:${hlId}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Instagram 320.0.0.35.109 Android (33/13; 480dpi; 1080x2400; samsung; SM-G998B; p3s; exynos2100; en_US)',
          'X-IG-App-ID': '936619743392459',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
        },
        signal: AbortSignal.timeout(10000)
      }, { proxyUrl: options.proxyUrl });
      if (mobRes.ok) {
        const mobData = await mobRes.json();
        const reel = mobData?.reels?.[`highlight:${hlId}`] || mobData?.reels?.[hlId];
        if (Array.isArray(reel?.items)) reelItems = reel.items;
      }
    } catch (e) {}
  }

  const makeProxyUrl = (u) => u ? `/api/media-proxy?url=${encodeURIComponent(u)}` : '';
  const mapped = [];
  for (let idx = 0; idx < reelItems.length; idx++) {
    const item = reelItems[idx];
    const rawId = String(item.pk || item.id || idx).split('_')[0];
    const isVideo = (item.media_type === 2 || item.is_video === true) && (item.video_versions?.length > 0 || item.video_resources?.length > 0 || item.video_url);
    const videoUrl = item.video_versions?.[0]?.url || item.video_resources?.[0]?.src || item.video_url || null;
    const photoCandidate = item.image_versions2?.candidates?.[0]?.url ||
                           item.display_resources?.[item.display_resources.length - 1]?.src ||
                           item.display_url || item.display_uri || null;
    const mediaUrl = isVideo ? videoUrl : photoCandidate;
    if (!mediaUrl) continue;
    const cleanUrl = mediaUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const cleanThumb = (photoCandidate || mediaUrl).replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const ext = isVideo ? 'mp4' : 'jpg';

    mapped.push({
      id: `highlight_${hlId}_${rawId}`,
      code: rawId,
      highlightId: hlId,
      highlightTitle,
      type: isVideo ? 'highlight_video' : 'highlight_photo',
      fileName: `${hlId}_${rawId}.${ext}`,
      mediaUrl: cleanUrl,
      thumbnailUrl: makeProxyUrl(cleanThumb),
      fileUrl: makeProxyUrl(cleanUrl),
      isVideo: Boolean(isVideo),
      caption: `Highlight: ${highlightTitle}`
    });
  }

  // Merge into existing in-memory manifest so /api/temp/download & /api/temp/download-zip can serve them on demand
  const manifest = cacheManager.getInspectManifest(clean);
  if (manifest && mapped.length > 0) {
    const existingIds = new Set(manifest.items.map(i => i.id));
    for (const m of mapped) {
      if (!existingIds.has(m.id)) {
        manifest.items.push(m);
      }
    }
    cacheManager.setInspectManifest(clean, manifest);
  }

  return mapped;
}

/**
 * Resolve an inspected manifest item into actual full-HD downloadable file(s):
 * - Video / Reel posts -> real playable .mp4 URL
 * - Carousel posts -> all full-resolution photo & .mp4 video slides
 * - Photo posts -> full-resolution original JPEG (not 640x640 grid thumbnail)
 */
async function resolveItemForDownload(item, options = {}) {
  if (!item) return [];
  const shouldResolve = Boolean(
    item.needsResolve ||
    (item.code && !String(item.code).startsWith('mirror_') && item.type !== 'profile_pic' && !item.type?.includes('highlight') && !item.type?.includes('story') && (
      (item.isVideo && !String(item.mediaUrl || '').includes('.mp4')) ||
      item.isCarousel ||
      String(item.mediaUrl || '').includes('s640x640')
    ))
  );

  if (!shouldResolve) {
    return item.mediaUrl ? [{
      url: item.mediaUrl,
      fileName: item.fileName || `${item.id}.${item.isVideo ? 'mp4' : 'jpg'}`,
      isVideo: Boolean(item.isVideo)
    }] : [];
  }

  const resolved = await fetchPostMedia(item.code, options);
  if (resolved.isCarousel && resolved.slides.length > 0) {
    return resolved.slides.map(slide => ({
      url: slide.url,
      fileName: `${item.code}_slide_${slide.index}.${slide.isVideo ? 'mp4' : 'jpg'}`,
      isVideo: Boolean(slide.isVideo)
    }));
  }

  if (resolved.videoUrl) {
    return [{
      url: resolved.videoUrl,
      fileName: `${item.code}.mp4`,
      isVideo: true
    }];
  }

  if (resolved.imageUrl) {
    return [{
      url: resolved.imageUrl,
      fileName: `${item.code}.jpg`,
      isVideo: false
    }];
  }

  return item.mediaUrl ? [{
    url: item.mediaUrl,
    fileName: item.fileName || `${item.id}.${item.isVideo ? 'mp4' : 'jpg'}`,
    isVideo: Boolean(item.isVideo)
  }] : [];
}

/**
 * Phase 2: Resolve real full-HD media URLs & download ONLY the requested items
 * into an isolated temporary directory concurrently for immediate streaming + cleanup.
 */
async function downloadItemsToTempDir(items, tempDir, options = {}) {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const concurrency = options.concurrency || config.DOWNLOAD_CONCURRENCY || 6;
  const metaConcurrency = options.metadataConcurrency || config.METADATA_CONCURRENCY || 3;
  const dlOptions = { ...options, force: true, _limiter: createLimiter(concurrency) };

  // Step 1: Resolve real full-HD MP4 / full-res image / carousel slides concurrently
  const resolvedNested = await runWithConcurrency(items, metaConcurrency, async (item) => {
    try {
      const files = await resolveItemForDownload(item, dlOptions);
      return files.map(f => ({ ...f, sourceId: item.id }));
    } catch (e) {
      return item?.mediaUrl ? [{
        url: item.mediaUrl,
        fileName: item.fileName || `${item.id}.${item.isVideo ? 'mp4' : 'jpg'}`,
        isVideo: Boolean(item.isVideo),
        sourceId: item.id
      }] : [];
    }
  });

  const downloadQueue = resolvedNested.flat().filter(f => Boolean(f.url));
  const downloaded = [];

  // Step 2: Stream all resolved full-HD files into the temp dir concurrently
  await runWithConcurrency(downloadQueue, concurrency, async (entry, idx) => {
    const safeName = (entry.fileName || `media_${idx + 1}.${entry.isVideo ? 'mp4' : 'jpg'}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(tempDir, `${idx + 1}_${safeName}`);
    try {
      const ok = await downloadFile(entry.url, destPath, dlOptions);
      if (ok && fs.existsSync(destPath)) {
        downloaded.push({
          id: entry.sourceId || String(idx + 1),
          filePath: destPath,
          entryName: safeName,
          isVideo: entry.isVideo
        });
      }
    } catch (e) {
      // skip individual broken CDN URL without failing the entire ZIP
    }
  });

  return downloaded;
}

module.exports = {
  downloadTargetContent,
  inspectProfileMedia,
  inspectHighlightReel,
  resolveItemForDownload,
  fetchPostMedia,
  downloadItemsToTempDir,
  downloadFile,
  runWithConcurrency,
  fetchPostSlides,
  fetchActiveStories,
  fetchHighlights,
  downloadAllHighlights
};
