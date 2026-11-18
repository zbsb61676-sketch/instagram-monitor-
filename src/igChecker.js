require('./dnsPatch');

/**
 * Instagram Profile Privacy Checker
 * Checks whether an Instagram handle is Public, Private, Not Found, or Rate-limited.
 */

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const db = require('./db');
const proxyManager = require('./proxyManager');
const { httpFetch } = require('./httpClient');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#064;/g, '@')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isBotChallengePage(html) {
  if (!html || typeof html !== 'string') return true;
  return (
    /Just a moment\.\.\./i.test(html) ||
    /Attention Required!\s*\|\s*Cloudflare/i.test(html) ||
    /cf-browser-verification/i.test(html) ||
    /challenge-platform/i.test(html) ||
    /Checking your browser before accessing/i.test(html) ||
    /Enable JavaScript and cookies to continue/i.test(html) ||
    /DDoS-Guard/i.test(html) ||
    /Access denied\s*\|\s*.*used Cloudflare/i.test(html)
  );
}

/**
 * Parse anonymous mirror HTML safely, rejecting bot walls and generic landing pages.
 */
function parseMirrorHtml(html, cleanUsername, providerName = 'mirror') {
  const clean = (cleanUsername || '').trim().toLowerCase().replace(/^@/, '');
  if (!clean || !html || html.length < 500) return null;
  if (isBotChallengePage(html)) return null;

  const isNotFound = /User not found|Page not found|Account not found|404 Not Found/i.test(html);
  if (isNotFound) {
    return {
      status: 'not_found',
      profileInfo: null,
      fallbackMirror: providerName,
      error: 'Account not found (via mirror fallback)'
    };
  }

  // Ensure the mirror page actually rendered the requested profile (not a generic landing/error page)
  if (!html.toLowerCase().includes(clean)) {
    return null;
  }

  const isPrivate = /This account is private|Private Account|Follow to see their photos and videos/i.test(html);

  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  let fullName = '';
  if (titleMatch) {
    const parts = titleMatch[1].split('•')[0].split('|')[0].replace(/Watch instagram stories.*/i, '').trim();
    const escapedClean = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fullName = parts.replace(new RegExp(`^${escapedClean}\\s*`, 'i'), '').trim();
  }

  return {
    status: isPrivate ? 'private' : 'public',
    profileInfo: {
      fullName: fullName || clean,
      isVerified: false,
      biography: '',
      profilePicUrl: '',
      postsCount: 0
    },
    fallbackMirror: providerName,
    error: null
  };
}

/**
 * Checks an Instagram handle's privacy status.
 * @param {string} username - Target handle (without @)
 * @param {object} options - { proxyUrl, sessionCookie }
 * @returns {Promise<{ status: 'public'|'private'|'not_found'|'rate_limited'|'error', profileInfo: object, latencyMs?: number, error?: string }>}
 */
async function checkInstagramProfile(username, options = {}) {
  const t0 = Date.now();
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  if (!clean) {
    return { status: 'error', profileInfo: null, latencyMs: 0, error: 'Invalid username format' };
  }
  const url = `https://www.instagram.com/${clean}/`;

  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  if (options.sessionCookie) {
    const cookieHeader = options.sessionCookie.includes('=')
      ? options.sessionCookie
      : `sessionid=${options.sessionCookie}`;
    headers['Cookie'] = cookieHeader;
  }

  const fetchOptions = {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(10000) // 10s timeout
  };

  let activeProxy = null;
  try {
    const fetched = await httpFetch(url, fetchOptions, { proxyUrl: options.proxyUrl });
    const response = fetched.response;
    activeProxy = fetched.activeProxy;

    if (response.status === 429) {
      if (activeProxy) proxyManager.markProxyFailed(activeProxy, 60);
      const mirrorResult = await checkViaMirror(clean);
      if (mirrorResult) {
        return mirrorResult;
      }
      return {
        status: 'rate_limited',
        profileInfo: null,
        error: 'Instagram returned HTTP 429 (Too Many Requests / IP Rate Limit)'
      };
    }

    if (activeProxy && response.ok) {
      proxyManager.markProxyHealthy(activeProxy);
    }

    if (response.status === 404) {
      return {
        status: 'not_found',
        profileInfo: null,
        error: 'Account does not exist (HTTP 404)'
      };
    }

    const html = await response.text();

    const locationHeader = response.headers.get('location') || '';
    // Check if redirected to login page, checkpoint challenge, or account suspension
    const isLoginChallenge = 
      response.url.includes('/accounts/login') ||
      response.url.includes('/challenge/') ||
      locationHeader.includes('/accounts/login') ||
      locationHeader.includes('/challenge/') ||
      html.includes('<title>Login • Instagram</title>') ||
      html.includes('Login • Instagram') ||
      html.includes('"pageID":"CAAIGLoginHomepage"') ||
      html.includes('checkpoint_required') ||
      html.includes('account_suspended') ||
      html.includes('suspension_banner') ||
      response.status === 401 ||
      response.status === 403;

    if (isLoginChallenge) {
      // If a session cookie was active and triggered a login/checkpoint challenge,
      // immediately auto-disable it to protect the account and server IP from further flags!
      if (options.sessionCookie) {
        console.warn(`[IGChecker] Session cookie flagged or checkpointed by Instagram. Automatically clearing cookie and falling back to Anonymous Safe Mode.`);
        db.updateSettings({ sessionCookie: '' });
        db.addLog(
          `⚠️ Instagram session cookie flagged or expired. Automatically cleared cookie and switched to Anonymous Safe Mode. Never use a personal account!`,
          'warning'
        );
        // Automatically retry without the compromised session cookie in Anonymous Mode
        return checkInstagramProfile(username, { ...options, sessionCookie: '' });
      }

      // Anonymous Mirror Fallback (bypasses login checkpoint / IP rate limit)
      const mirrorResult = await checkViaMirror(clean);
      if (mirrorResult) {
        return mirrorResult;
      }

      return {
        status: 'rate_limited',
        profileInfo: null,
        error: 'Instagram redirected to Login challenge (IP rate limited)'
      };
    }

    // Check if page unavailable / deleted / not found
    if (
      html.includes("Sorry, this page isn't available") ||
      html.includes("The link you followed may be broken") ||
      html.includes('"pageID":"httpErrorPage"') ||
      html.includes('Page Not Found • Instagram')
    ) {
      return {
        status: 'not_found',
        profileInfo: null,
        error: 'Profile page is unavailable or removed'
      };
    }

    // Extract target profile metadata
    const profileInfo = extractProfileInfo(html, clean);

    // Privacy detection
    const isPrivate = determinePrivacy(html, clean);

    return {
      status: isPrivate ? 'private' : 'public',
      profileInfo,
      latencyMs: Date.now() - t0,
      error: null
    };
  } catch (err) {
    if (activeProxy) proxyManager.markProxyFailed(activeProxy, 60);
    // Attempt anonymous mirror fallback on network timeout or fetch error
    const mirrorResult = await checkViaMirror(clean);
    if (mirrorResult) {
      return { ...mirrorResult, latencyMs: Date.now() - t0 };
    }

    return {
      status: 'error',
      profileInfo: null,
      latencyMs: Date.now() - t0,
      error: err.message
    };
  }
}

/**
 * Fallback privacy & profile check via anonymous web mirrors (Greatfon, Dumpor)
 * Used when direct Instagram scraping is blocked by datacenter IP rate limits,
 * login challenges (429/403), or network timeouts on Render.
 */
async function checkViaMirror(username) {
  const clean = (username || '').trim().toLowerCase().replace(/^@/, '');
  if (!clean) return null;

  const mirrorUrls = [
    `https://dumpor.io/v/${clean}`,
    `https://greatfon.com/v/${clean}`
  ];

  for (const url of mirrorUrls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(9000)
      });

      if (!res.ok) continue;

      const html = await res.text();
      const providerName = url.includes('greatfon') ? 'greatfon' : 'dumpor';
      const parsed = parseMirrorHtml(html, clean, providerName);
      if (parsed) {
        return parsed;
      }
    } catch (err) {
      // try next mirror
    }
  }

  return null;
}

/**
 * Determine whether the target profile is private or public
 */
function determinePrivacy(html, cleanUsername) {
  const clean = (cleanUsername || '').trim().toLowerCase().replace(/^@/, '');

  // 1. Text markers in HTML (standard Instagram markers for private profiles)
  const isPrivateText = 
    /this account is private/i.test(html) ||
    /follow to see their photos and videos/i.test(html) ||
    /follow this account to see/i.test(html) ||
    /already follow [^?]*to see their photos/i.test(html);

  if (isPrivateText) {
    return true;
  }

  // 2. Embedded JSON scripts scanning specifically for the target user object
  const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const sc of scripts) {
    if (clean && sc.includes(`"${clean}"`)) {
      try {
        const parsed = JSON.parse(sc);
        let foundPrivacy = null;

        function findTargetUser(obj) {
          if (!obj || typeof obj !== 'object' || foundPrivacy !== null) return;
          if (obj.username?.toLowerCase() === clean && typeof obj.is_private === 'boolean') {
            foundPrivacy = obj.is_private;
            return;
          }
          for (const k of Object.keys(obj)) {
            findTargetUser(obj[k]);
          }
        }

        findTargetUser(parsed);
        if (foundPrivacy !== null) {
          return foundPrivacy;
        }
      } catch (e) {}
    }
  }

  // If no private indicator found and profile loaded, it is public
  return false;
}

/**
 * Extract profile details like full name, verification badge, bio, profile pic, and counts
 */
function extractProfileInfo(html, cleanUsername) {
  const clean = (cleanUsername || '').trim().toLowerCase().replace(/^@/, '');

  const info = {
    fullName: '',
    isVerified: false,
    biography: '',
    profilePicUrl: '',
    latestReelMedia: null,
    followerCount: null,
    followingCount: null,
    postCodes: [],
    postsCount: 0
  };

  try {
    // 1. Full name from OpenGraph title or <title>
    const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ||
                         html.match(/<title>([^<]*)<\/title>/i);
    if (ogTitleMatch) {
      const decodedTitle = decodeHtmlEntities(ogTitleMatch[1]);
      const nameMatch = decodedTitle.match(/^(.*?)(?:\s*\(@[a-zA-Z0-9_.]+\))?\s*•\s*Instagram/i);
      if (nameMatch && nameMatch[1].trim()) {
        info.fullName = nameMatch[1].trim();
      }
    }

    // 2. Avatar from og:image
    const ogImgMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i);
    if (ogImgMatch) {
      info.profilePicUrl = decodeHtmlEntities(ogImgMatch[1]);
    }

    // 3. Bio & Stats from Meta description
    const metaDescMatch = html.match(/<meta\s+(?:content="([^"]*)"\s+name="description"|name="description"\s+content="([^"]*)")/i);
    const metaDesc = metaDescMatch ? (metaDescMatch[1] || metaDescMatch[2]) : '';
    const ogDescMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i);
    const ogDesc = ogDescMatch ? ogDescMatch[1] : '';

    const combinedDesc = decodeHtmlEntities((metaDesc || '') + ' ' + (ogDesc || ''));

    const bioMatch = combinedDesc.match(/on Instagram:\s*"([\s\S]*?)"/);
    if (bioMatch) {
      info.biography = bioMatch[1].trim();
    }

    const followersMatch = combinedDesc.match(/([\d,.]+[KMkm]?)\s+Followers/i);
    if (followersMatch) info.followerCount = followersMatch[1];

    const followingMatch = combinedDesc.match(/([\d,.]+[KMkm]?)\s+Following/i);
    if (followingMatch) info.followingCount = followingMatch[1];

    const postsMatch = combinedDesc.match(/([\d,.]+[KMkm]?)\s+Posts/i);
    if (postsMatch) {
      const pCount = parseInt(postsMatch[1].replace(/,/g, ''), 10);
      if (!isNaN(pCount)) info.postsCount = pCount;
    }

    // 4. Verification badge & target-specific user object check
    const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    for (const sc of scripts) {
      if (clean && sc.includes(`"${clean}"`)) {
        try {
          const parsed = JSON.parse(sc);
          function inspectTarget(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.username?.toLowerCase() === clean) {
              if (obj.is_verified !== undefined) info.isVerified = !!obj.is_verified;
              if (obj.full_name && !info.fullName) info.fullName = obj.full_name;
              if (obj.biography && !info.biography) info.biography = obj.biography;
              if (obj.profile_pic_url_hd && !info.profilePicUrl) info.profilePicUrl = obj.profile_pic_url_hd;
              if (obj.latest_reel_media && !info.latestReelMedia) info.latestReelMedia = obj.latest_reel_media;
              if ((obj.id || obj.pk) && !info.userId) info.userId = String(obj.id || obj.pk);
              return;
            }
            for (const k of Object.keys(obj)) inspectTarget(obj[k]);
          }
          inspectTarget(parsed);
        } catch (e) {}
      }
    }

    // Extract timeline post shortcodes
    const rawCodes = [...html.matchAll(/"code"\s*:\s*"([A-Za-z0-9_-]{11})"/g)].map(m => m[1]);
    info.postCodes = [...new Set(rawCodes)];
    if (info.postsCount === 0 && info.postCodes.length > 0) {
      info.postsCount = info.postCodes.length;
    }
  } catch (err) {
    // Non-fatal metadata extraction
  }

  return info;
}

module.exports = {
  checkInstagramProfile,
  determinePrivacy,
  extractProfileInfo,
  decodeHtmlEntities,
  isBotChallengePage,
  parseMirrorHtml
};
