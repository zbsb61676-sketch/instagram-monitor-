/**
 * Instagram Public Content Downloader & Deduplicator
 * Downloads profile picture, full carousel slides, highlights, posts, reels, and stories with strict deduplication.
 */

require('./dnsPatch');

const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const cacheManager = require('./cacheManager');

// Ensure base downloads folder exists
if (!fs.existsSync(config.DOWNLOADS_DIR)) {
  fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true });
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
 * Download a file from URL and save to destination path atomically
 */
async function downloadFile(url, destPath, options = {}) {
  if (!url) return false;

  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Reuse existing valid file if not forced
  if (options.force !== true && fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
    return true;
  }

  let fetchOptions = {
    method: 'GET',
    headers: {
      'User-Agent': getRandomUserAgent(),
      'Accept': '*/*',
      'Referer': 'https://www.instagram.com/'
    },
    signal: AbortSignal.timeout(25000)
  };

  if (options.proxyUrl) {
    try {
      const { ProxyAgent } = require('undici');
      fetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
    } catch (e) {
      // ignore
    }
  }

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }

  const buffer = await res.arrayBuffer();
  const tempPath = `${destPath}.tmp`;
  fs.writeFileSync(tempPath, Buffer.from(buffer));
  fs.renameSync(tempPath, destPath);
  return true; // Newly downloaded
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

      let isVideo = obj.media_type === 2 || obj.product_type === 'clips' || Boolean(obj.video_url);
      const isCarousel = obj.product_type === 'carousel_container' ||
                         obj.media_type === 8 ||
                         (obj.carousel_media_count && obj.carousel_media_count > 1) ||
                         Boolean(obj.carousel_media);

      // Clean display URL
      const displayUrl = obj.display_uri 
        ? obj.display_uri.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
        : null;

      const videoUrl = obj.video_url
        ? obj.video_url.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
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
 * Fetch and extract all slides for a carousel post
 */
async function fetchPostSlides(shortcode, options = {}) {
  const slides = [];
  const url = `https://www.instagram.com/p/${shortcode}/`;

  let fetchOptions = {
    method: 'GET',
    headers: getBrowserHeaders(),
    signal: AbortSignal.timeout(15000)
  };

  if (options.proxyUrl) {
    try {
      const { ProxyAgent } = require('undici');
      fetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
    } catch (e) {}
  }

  try {
    const res = await fetch(url, fetchOptions);
    if (!res.ok) return slides;

    const html = await res.text();
    const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

    for (const s of scripts) {
      if (s.includes('carousel_media') && s.includes(shortcode)) {
        try {
          const parsed = JSON.parse(s);

          function findCarouselMedia(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (Array.isArray(obj.carousel_media) && obj.carousel_media.length > 0) {
              obj.carousel_media.forEach((child, index) => {
                const isVideo = child.media_type === 2 || Boolean(child.video_versions && child.video_versions.length > 0);
                const bestImage = child.image_versions2?.candidates?.[0]?.url || child.display_uri;
                const bestVideo = isVideo ? (child.video_versions?.[0]?.url || null) : null;
                const cleanImg = bestImage ? bestImage.replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null;
                const cleanVid = bestVideo ? bestVideo.replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null;

                slides.push({
                  index: index + 1,
                  id: String(child.pk || child.id || `${shortcode}_${index + 1}`),
                  isVideo,
                  url: (isVideo && cleanVid) ? cleanVid : cleanImg,
                  displayUrl: cleanImg
                });
              });
              return;
            }

            for (const k of Object.keys(obj)) {
              if (slides.length > 0) break;
              findCarouselMedia(obj[k]);
            }
          }

          findCarouselMedia(parsed);
          if (slides.length > 0) break;
        } catch (e) {}
      }
    }
  } catch (err) {
    console.warn(`[Slides] Error fetching slides for ${shortcode}:`, err.message);
  }

  return slides;
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
  const cookieHeader = options.sessionCookie || db.getSettings().sessionCookie;

  const recordMedia = (data) => {
    if (isCache) {
      return cacheManager.recordCachedItem(username, data);
    }
    return db.recordDownloadedMedia(username, data);
  };

  for (const hl of highlights) {
    const hlId = String(hl.id).replace(/^highlight:/, '');
    const cleanTitle = (hl.title || 'Highlight').replace(/[/\\?%*:|"<>]/g, '_').trim();

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
          'Cookie': cookieHeader || '',
          'X-CSRFToken': csrf,
          'X-IG-App-ID': '936619743392459',
          'X-ASBD-ID': '359341',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin'
        },
        signal: AbortSignal.timeout(15000)
      };

      if (options.proxyUrl) {
        try {
          const { ProxyAgent } = require('undici');
          hlFetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
        } catch (e) {}
      }

      const res = await fetch(hlUrl, hlFetchOptions);
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

    // Process all items in this highlight reel
    if (reelItems.length > 0) {
      for (let idx = 0; idx < reelItems.length; idx++) {
        const item = reelItems[idx];
        const rawId = String(item.pk || item.id || idx).split('_')[0];
        const isVideo = (item.media_type === 2 || item.is_video === true) && (item.video_versions?.length > 0 || item.video_resources?.length > 0 || item.video_url);

        const videoUrl = item.video_versions?.[0]?.url || item.video_resources?.[0]?.src || item.video_url || null;
        const photoCandidate = item.image_versions2?.candidates?.[0]?.url ||
                               item.display_resources?.[item.display_resources.length - 1]?.src ||
                               item.display_url ||
                               item.display_uri ||
                               null;

        const mediaUrl = isVideo ? videoUrl : photoCandidate;
        if (!mediaUrl) continue;

        const cleanUrl = mediaUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        const ext = isVideo ? 'mp4' : 'jpg';
        const fileName = `${rawId}.${ext}`;
        const destPath = path.join(hlDir, fileName);

        let thumbUrl = null;
        let thumbPath = null;
        if (isVideo && photoCandidate) {
          const cleanThumb = photoCandidate.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          const thumbFileName = `${rawId}_thumb.jpg`;
          const thumbDest = path.join(hlDir, thumbFileName);
          try {
            await downloadFile(cleanThumb, thumbDest, options);
            thumbUrl = `${urlPrefix}/${clean}/highlights/${cleanTitle}_${hlId}/${thumbFileName}`;
            thumbPath = thumbDest;
          } catch (te) {}
        }

        let fileReady = false;
        try {
          const downloaded = await downloadFile(cleanUrl, destPath, options);
          if (downloaded) fileReady = true;
        } catch (err) {
          if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
            fileReady = true;
          }
        }

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
      }
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
  }

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

  const summary = {
    username: clean,
    totalFound: 0,
    newlyDownloaded: 0,
    skipped: 0,
    downloadedItems: [],
    errors: []
  };

  db.addLog(`Starting full content archive (posts, slides & highlights) for @${clean}...`, 'info', clean);

  try {
    // 1. Fetch profile HTML page
    const profileUrl = `https://www.instagram.com/${clean}/`;
    let fetchOptions = {
      method: 'GET',
      headers: getBrowserHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    };

    if (options.proxyUrl) {
      try {
        const { ProxyAgent } = require('undici');
        fetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
      } catch (e) {}
    }

    const res = await fetch(profileUrl, fetchOptions);
    if (!res.ok) {
      throw new Error(`Profile request returned HTTP ${res.status}`);
    }

    const html = await res.text();
    const { userId, avatarUrl, fullName, bio } = extractProfileDetails(html, clean);

    // Save profile metadata & avatar (always fetched fresh from Instagram)
    if (avatarUrl) {
      const avatarPath = path.join(profileDir, 'avatar.jpg');
      const avatarMediaId = `avatar_${clean}`;
      try {
        const downloaded = await downloadFile(avatarUrl, avatarPath, options);
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

    // 2. Parse Posts, Reels, & Highlights from Relay Scripts
    const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    let allMedia = [];

    for (const scriptContent of scripts) {
      if (scriptContent.includes('display_uri') || scriptContent.includes('carousel')) {
        try {
          const parsed = JSON.parse(scriptContent);
          const found = extractMediaObjects(parsed);
          allMedia.push(...found);
        } catch (e) {}
      }
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

    // 3. Extract and Download Highlights (always downloaded fresh)
    let highlights = extractHighlightsFromScripts(scripts);
    if (highlights.length === 0) {
      const knownHlIds = new Set();
      const dbHighlights = db.getDownloadedMedia(clean).filter(m => m.type?.includes('highlight'));
      for (const h of dbHighlights) {
        if (h.highlightId && !knownHlIds.has(h.highlightId)) {
          knownHlIds.add(h.highlightId);
          highlights.push({
            id: h.highlightId,
            title: h.highlightTitle || 'Highlight',
            coverUrl: h.thumbnailUrl || h.fileUrl || null
          });
        }
      }
    }
    summary.totalFound += highlights.length;

    if (highlights.length > 0) {
      const hlResult = await downloadAllHighlights(clean, highlights, highlightsDir, options, onProgress);
      summary.newlyDownloaded += hlResult.newlyDownloaded;
      summary.downloadedItems.push(...hlResult.items);
      if (hlResult.errors?.length > 0) {
        summary.errors.push(...hlResult.errors);
      }
    }

    // 4. Download Posts & Carousel Slides with Strict Deduplication
    for (const post of uniquePosts) {
      const isCarousel = post.isCarousel || post.productType === 'carousel_container' || (post.carouselCount && post.carouselCount > 1);

      if (isCarousel) {
        // Fetch all slides for carousel post
        const slides = await fetchPostSlides(post.code, options);

        if (slides.length > 0) {
          summary.totalFound += slides.length;

          // Save caption if present
          if (post.caption) {
            fs.writeFileSync(path.join(postsDir, `${post.code}_caption.txt`), post.caption, 'utf-8');
          }

          // Save post metadata json with slides
          fs.writeFileSync(path.join(postsDir, `${post.code}.json`), JSON.stringify({ ...post, slides }, null, 2), 'utf-8');

          for (const slide of slides) {
            const slideId = `${post.code}_slide_${slide.index}`;
            const ext = slide.isVideo ? 'mp4' : 'jpg';
            const fileName = `${post.code}_slide_${slide.index}.${ext}`;
            const destPath = path.join(postsDir, fileName);

            try {
              const downloaded = await downloadFile(slide.url, destPath, options);
              if (downloaded) {
                summary.newlyDownloaded++;
                let thumbnailUrl = null;
                let thumbnailPath = null;
                if (slide.isVideo && slide.displayUrl) {
                  const thumbFileName = `${post.code}_slide_${slide.index}_thumb.jpg`;
                  thumbnailPath = path.join(postsDir, thumbFileName);
                  try {
                    await downloadFile(slide.displayUrl, thumbnailPath, options);
                    thumbnailUrl = `${urlPrefix}/${clean}/posts/${thumbFileName}`;
                  } catch (e) {}
                } else if (!slide.isVideo) {
                  thumbnailUrl = `${urlPrefix}/${clean}/posts/${fileName}`;
                  thumbnailPath = destPath;
                }

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
          }
          continue; // Finished processing carousel post
        }
      }

      // Standard single image/video post (always downloaded fresh)
      const mediaId = post.pk || post.code;
      const imagePath = path.join(postsDir, `${post.code}.jpg`);

      try {
        if (post.displayUrl) {
          const imgDownloaded = await downloadFile(post.displayUrl, imagePath, options);
          if (imgDownloaded) {
            summary.newlyDownloaded++;

            if (post.caption) {
              fs.writeFileSync(path.join(postsDir, `${post.code}_caption.txt`), post.caption, 'utf-8');
            }
            fs.writeFileSync(path.join(postsDir, `${post.code}.json`), JSON.stringify(post, null, 2), 'utf-8');

            const record = recordMedia({
              id: mediaId,
              code: post.code,
              type: post.isVideo ? 'video_post' : 'photo_post',
              fileName: `${post.code}.jpg`,
              filePath: imagePath,
              fileUrl: `${urlPrefix}/${clean}/posts/${post.code}.jpg`,
              thumbnailUrl: `${urlPrefix}/${clean}/posts/${post.code}.jpg`,
              thumbnailPath: imagePath,
              caption: post.caption
            });
            summary.downloadedItems.push(record);
            if (typeof onProgress === 'function') {
              onProgress({ type: 'ITEM_DOWNLOADED', item: record, current: summary.newlyDownloaded, total: summary.totalFound });
            }
          }
        }
      } catch (postErr) {
        summary.errors.push(`Post ${post.code} download error: ${postErr.message}`);
      }
    }

    // 5. Download Active Stories (always checked and downloaded fresh)
    try {
      const storiesResult = await downloadActiveStories(clean, userId, storiesDir, options, onProgress);
      summary.newlyDownloaded += storiesResult.newlyDownloaded;
      summary.downloadedItems.push(...storiesResult.items);
    } catch (storyErr) {
      summary.errors.push(`Story download error: ${storyErr.message}`);
    }

    db.addLog(
      `Content download complete for @${clean}: ${summary.newlyDownloaded} media files downloaded fresh from Instagram server.`,
      summary.newlyDownloaded > 0 ? 'success' : 'info',
      clean
    );

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
      return cacheManager.recordCachedItem(username, data);
    }
    return db.recordDownloadedMedia(username, data);
  };

  const cookieHeader = sessionCookie
    ? (sessionCookie.includes('=') ? sessionCookie : `sessionid=${sessionCookie}`)
    : '';

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

    if (options.proxyUrl) {
      try {
        const { ProxyAgent } = require('undici');
        webFetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
      } catch (e) {}
    }

    const res = await fetch(webStoriesUrl, webFetchOptions);
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

      if (options.proxyUrl) {
        try {
          const { ProxyAgent } = require('undici');
          mobileFetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
        } catch (e) {}
      }

      const res = await fetch(mobileUrl, mobileFetchOptions);
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

      if (options.proxyUrl) {
        try {
          const { ProxyAgent } = require('undici');
          reelsFetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
        } catch (e) {}
      }

      const res = await fetch(webUrl, reelsFetchOptions);
      if (res.ok) {
        const data = await res.json();
        const reel = data?.reels?.[userId] || data?.reels_media?.[0];
        if (Array.isArray(reel?.items) && reel.items.length > 0) {
          items = reel.items;
        }
      }
    } catch (e) {}
  }

  for (const item of items) {
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

    if (mediaUrl) {
      const cleanUrl = mediaUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      const ext = isVideo ? 'mp4' : 'jpg';
      const fileName = `${rawId}.${ext}`;
      const destPath = path.join(storiesDir, fileName);

      let thumbnailUrl = null;
      let thumbnailPath = null;
      if (isVideo && thumbCandidateUrl) {
        const cleanThumb = thumbCandidateUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        const thumbFileName = `${rawId}_thumb.jpg`;
        const thumbDestPath = path.join(storiesDir, thumbFileName);
        try {
          await downloadFile(cleanThumb, thumbDestPath, options);
          thumbnailUrl = `${urlPrefix}/${clean}/stories/${thumbFileName}`;
          thumbnailPath = thumbDestPath;
        } catch (te) {}
      } else if (!isVideo) {
        thumbnailUrl = `${urlPrefix}/${clean}/stories/${fileName}`;
        thumbnailPath = destPath;
      }

      let fileReady = false;
      try {
        const downloaded = await downloadFile(cleanUrl, destPath, options);
        if (downloaded) fileReady = true;
      } catch (err) {
        // Fallback: Use existing valid local file if download failed
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
          fileReady = true;
        }
      }

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
    }
  }

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
      const res = await fetch(profileUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Cookie': sessionCookie,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'X-IG-App-ID': '936619743392459'
        },
        signal: AbortSignal.timeout(10000)
      });
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
        discoveredHighlights.push({
          id: h.highlightId,
          title: h.highlightTitle || 'Highlight',
          coverUrl: h.thumbnailUrl || h.fileUrl || null
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

module.exports = {
  downloadTargetContent,
  downloadFile,
  fetchPostSlides,
  fetchActiveStories,
  fetchHighlights,
  downloadAllHighlights
};
