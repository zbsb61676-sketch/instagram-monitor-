/**
 * Instagram Public Content Downloader & Deduplicator
 * Downloads profile picture, full carousel slides, highlights, posts, reels, and stories with strict deduplication.
 */

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

  // Always fetch fresh media from Instagram server (duplicate-skipping removed)
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
    if (s.includes('lox_highlights_connection') || s.includes('XIGHighlightReel')) {
      try {
        const parsed = JSON.parse(s);

        function scanForReels(obj) {
          if (!obj || typeof obj !== 'object') return;

          if (obj.__typename === 'XIGHighlightReel' || (obj.id && obj.title && ('cover_media_cropped_thumbnail_url' in obj || 'cover_media' in obj))) {
            const id = String(obj.id);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              highlights.push({
                id,
                title: obj.title || 'Highlight',
                coverUrl: obj.cover_media_cropped_thumbnail_url || obj.cover_media?.thumbnail_src || null
              });
            }
          }

          if (Array.isArray(obj)) {
            for (const item of obj) scanForReels(item);
          } else {
            for (const k of Object.keys(obj)) scanForReels(obj[k]);
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
 * Fetch and download highlight reel story images
 */
async function downloadSingleHighlight(username, highlight, highlightsDir, options = {}) {
  const destPath = path.join(highlightsDir, `${highlight.id}.jpg`);

  // Try fetching the story highlight page for full-resolution image
  let fullImageUrl = null;
  try {
    const res = await fetch(`https://www.instagram.com/stories/highlights/${highlight.id}/`, {
      headers: getBrowserHeaders(),
      signal: AbortSignal.timeout(12000)
    });

    if (res.ok) {
      const html = await res.text();
      const imgs = [...html.matchAll(/https:\/\/[^"'\s<>]*?scontent[^"'\s<>]+/g)]
        .map(m => m[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&'))
        .filter(u => u.includes('STORY') || u.includes('51.'));

      if (imgs.length > 0) {
        fullImageUrl = imgs[0];
      }
    }
  } catch (e) {
    // continue to fallback
  }

  // Fallback to cover URL
  const downloadUrl = fullImageUrl || highlight.coverUrl;
  if (!downloadUrl) return false;

  const downloaded = await downloadFile(downloadUrl, destPath, options);
  if (downloaded) {
    // Save metadata json
    fs.writeFileSync(path.join(highlightsDir, `${highlight.id}.json`), JSON.stringify(highlight, null, 2), 'utf-8');
  }
  return downloaded;
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
    const highlights = extractHighlightsFromScripts(scripts);
    summary.totalFound += highlights.length;

    for (const hl of highlights) {
      const hlMediaId = `highlight_${hl.id}`;
      try {
        const downloaded = await downloadSingleHighlight(clean, hl, highlightsDir, options);
        if (downloaded) {
          summary.newlyDownloaded++;
          const record = recordMedia({
            id: hlMediaId,
            code: hl.id,
            type: 'highlight',
            title: hl.title,
            fileName: `${hl.id}.jpg`,
            filePath: path.join(highlightsDir, `${hl.id}.jpg`),
            fileUrl: `${urlPrefix}/${clean}/highlights/${hl.id}.jpg`,
            thumbnailUrl: `${urlPrefix}/${clean}/highlights/${hl.id}.jpg`,
            thumbnailPath: path.join(highlightsDir, `${hl.id}.jpg`),
            caption: `Highlight: ${hl.title}`
          });
          summary.downloadedItems.push(record);
          if (typeof onProgress === 'function') {
            onProgress({ type: 'ITEM_DOWNLOADED', item: record, current: summary.newlyDownloaded, total: summary.totalFound });
          }
        }
      } catch (hlErr) {
        summary.errors.push(`Highlight ${hl.title} download error: ${hlErr.message}`);
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

    // 5. Download Active Stories if session cookie is present and authenticated (always downloaded fresh)
    if (options.sessionCookie && userId) {
      try {
        const storiesResult = await downloadActiveStories(clean, userId, storiesDir, options, onProgress);
        summary.newlyDownloaded += storiesResult.newlyDownloaded;
        summary.downloadedItems.push(...storiesResult.items);
      } catch (storyErr) {
        summary.errors.push(`Story download error: ${storyErr.message}`);
      }
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
async function downloadActiveStories(username, userId, storiesDir, options, onProgress = null) {
  const result = { newlyDownloaded: 0, skipped: 0, items: [] };
  if (!options.sessionCookie || !username) return result;

  const isCache = options.isCache === true;
  const urlPrefix = isCache ? '/cache' : '/downloads';

  const recordMedia = (data) => {
    if (isCache) {
      return cacheManager.recordCachedItem(username, data);
    }
    return db.recordDownloadedMedia(username, data);
  };

  const cookieHeader = options.sessionCookie.includes('=')
    ? options.sessionCookie
    : `sessionid=${options.sessionCookie}`;

  let items = [];

  // Method 1: Web Stories Page with Authenticated SSR Parsing (Most reliable for web sessions)
  try {
    const webStoriesUrl = `https://www.instagram.com/stories/${username}/`;
    const csrfMatch = cookieHeader.match(/csrftoken=([^;]+)/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    let webFetchOptions = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Cookie': cookieHeader,
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
        webFetchOptions.dispatcher = new ProxyAgent(options.proxyUrl);
      } catch (e) {}
    }

    const res = await fetch(webStoriesUrl, webFetchOptions);
    if (res.ok) {
      const html = await res.text();
      const scripts = [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);

      for (const s of scripts) {
        if (s.includes('reels_media') && (s.includes('xdt_api__v1__feed__reels_media') || s.includes('items'))) {
          try {
            const parsed = JSON.parse(s);

            function scanForReelItems(obj) {
              if (!obj || typeof obj !== 'object') return;
              const ownerUsername = obj.user?.username || obj.owner?.username;
              const matchesUser = ownerUsername && ownerUsername.toLowerCase() === clean;
              if (matchesUser && Array.isArray(obj.items) && obj.items.length > 0 && (obj.items[0].video_versions || obj.items[0].image_versions2)) {
                items = obj.items;
                return;
              }
              for (const k of Object.keys(obj)) {
                if (items.length > 0) break;
                scanForReelItems(obj[k]);
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
          'Cookie': cookieHeader,
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
          'Cookie': cookieHeader,
          'Referer': `https://www.instagram.com/stories/${username}/`,
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

    const isVideo = item.media_type === 2 && item.video_versions && item.video_versions.length > 0;
    const mediaUrl = isVideo
      ? item.video_versions[0].url
      : (item.image_versions2?.candidates?.[0]?.url || item.display_url || null);

    const thumbCandidateUrl = item.image_versions2?.candidates?.[0]?.url || item.display_url || null;

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
          thumbnailUrl = `${urlPrefix}/${username}/stories/${thumbFileName}`;
          thumbnailPath = thumbDestPath;
        } catch (te) {}
      } else if (!isVideo) {
        thumbnailUrl = `${urlPrefix}/${username}/stories/${fileName}`;
        thumbnailPath = destPath;
      }

      try {
        const downloaded = await downloadFile(cleanUrl, destPath, options);
        if (downloaded) {
          result.newlyDownloaded++;
          const recorded = recordMedia({
            id: storyId,
            code: rawId,
            type: isVideo ? 'story_video' : 'story',
            fileName,
            filePath: destPath,
            fileUrl: `${urlPrefix}/${username}/stories/${fileName}`,
            thumbnailUrl: thumbnailUrl || `${urlPrefix}/${username}/stories/${fileName}`,
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
      } catch (e) {}
    }
  }

  return result;
}

module.exports = {
  downloadTargetContent,
  downloadFile,
  fetchPostSlides
};
