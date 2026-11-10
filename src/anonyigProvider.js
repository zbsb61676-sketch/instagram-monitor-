/**
 * AnonyIG & Anonymous Instagram Media Mirror Provider
 * 
 * Provides anonymous story, highlight, and media download capabilities
 * without requiring any Instagram login or session cookies, keeping accounts 100% safe.
 */

const https = require('https');

class AnonyigProvider {
  constructor() {
    this.baseUrl = 'https://anonyig.com';
    this.mirrorUrls = {
      anonyig: 'https://anonyig.com/en2/?url=',
      fastdl: 'https://fastdl.app/en?url=',
      snapinsta: 'https://snapinsta.app/?url=',
      greatfon: 'https://greatfon.com/v/'
    };
  }

  /**
   * Generates a direct AnonyIG web viewer URL for a target username
   */
  getAnonyigUrl(username) {
    const clean = (username || '').trim().toLowerCase().replace(/^@/, '');
    return `https://anonyig.com/en2/?url=${encodeURIComponent(clean)}`;
  }

  /**
   * Generates direct mirror URLs for all major anonymous Instagram viewers
   */
  getMirrorUrls(username) {
    const clean = (username || '').trim().toLowerCase().replace(/^@/, '');
    return {
      anonyig: `https://anonyig.com/en2/?url=${encodeURIComponent(clean)}`,
      greatfon: `https://greatfon.com/v/${encodeURIComponent(clean)}`,
      fastdl: `https://fastdl.app/en?url=${encodeURIComponent(`https://www.instagram.com/${clean}/`)}`,
      snapinsta: `https://snapinsta.app/?url=${encodeURIComponent(`https://www.instagram.com/${clean}/`)}`
    };
  }

  /**
   * Generates direct media URL for posts / reels
   */
  getMediaConvertUrl(instagramUrl) {
    const cleanUrl = (instagramUrl || '').trim();
    return {
      anonyig: `https://anonyig.com/en2/?url=${encodeURIComponent(cleanUrl)}`,
      fastdl: `https://fastdl.app/en?url=${encodeURIComponent(cleanUrl)}`
    };
  }

  /**
   * Attempts to scrape public stories/media from anonymous public HTML mirrors (like Greatfon / Dumpor)
   */
  async fetchPublicMirrorMedia(username) {
    const clean = (username || '').trim().toLowerCase().replace(/^@/, '');
    if (!clean) return { success: false, items: [] };

    try {
      const mirrorUrl = `https://greatfon.com/v/${clean}`;
      const res = await fetch(mirrorUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        return { success: false, items: [], error: `Mirror HTTP ${res.status}` };
      }

      const html = await res.text();
      const items = [];

      // Extract post images & videos from mirror HTML
      const imgRegex = /<img[^>]+src=["'](https:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["'][^>]*>/gi;
      let match;
      while ((match = imgRegex.exec(html)) !== null) {
        const src = match[1];
        if (!src.includes('logo') && !src.includes('icon') && !src.includes('avatar')) {
          items.push({
            type: 'photo',
            url: src,
            provider: 'greatfon'
          });
        }
      }

      return {
        success: items.length > 0,
        provider: 'greatfon',
        items: items.slice(0, 20),
        anonyigUrl: this.getAnonyigUrl(clean)
      };
    } catch (err) {
      return {
        success: false,
        items: [],
        error: err.message,
        anonyigUrl: this.getAnonyigUrl(clean)
      };
    }
  }
}

module.exports = new AnonyigProvider();
