/**
 * Instagram Profile Privacy Checker
 * Checks whether an Instagram handle is Public, Private, Not Found, or Rate-limited.
 */

const proxyManager = require('./proxyManager');

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

/**
 * Checks an Instagram handle's privacy status.
 * @param {string} username - Target handle (without @)
 * @param {object} options - { proxyUrl, sessionCookie }
 * @returns {Promise<{ status: 'public'|'private'|'not_found'|'rate_limited'|'error', profileInfo: object, error?: string }>}
 */
async function checkInstagramProfile(username, options = {}) {
  const clean = username.trim().toLowerCase().replace(/^@/, '');
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

  let fetchOptions = {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(10000) // 10s timeout
  };

  // Rotating Proxy Pool
  const activeProxy = options.proxyUrl || proxyManager.getNextProxy();
  if (activeProxy) {
    try {
      const { ProxyAgent } = require('undici');
      fetchOptions.dispatcher = new ProxyAgent(activeProxy);
    } catch (e) {
      // ignore
    }
  }

  try {
    const response = await fetch(url, fetchOptions);

    if (response.status === 429) {
      return {
        status: 'rate_limited',
        profileInfo: null,
        error: 'Instagram returned HTTP 429 (Too Many Requests / IP Rate Limit)'
      };
    }

    if (response.status === 404) {
      return {
        status: 'not_found',
        profileInfo: null,
        error: 'Account does not exist (HTTP 404)'
      };
    }

    const html = await response.text();

    // Check if redirected to login page or challenge
    if (
      response.url.includes('/accounts/login') ||
      response.url.includes('/challenge/') ||
      html.includes('<title>Login • Instagram</title>') ||
      html.includes('Login • Instagram') ||
      html.includes('"pageID":"CAAIGLoginHomepage"')
    ) {
      return {
        status: 'rate_limited',
        profileInfo: null,
        error: 'Instagram redirected to Login challenge'
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
      error: null
    };
  } catch (err) {
    return {
      status: 'error',
      profileInfo: null,
      error: err.message
    };
  }
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
  checkInstagramProfile
};
