/**
 * Ephemeral Cache Manager
 * Manages downloading Instagram media into temporary staging cache,
 * serving cached previews to the UI, handling user selection, and
 * deleting cached items in real time as soon as downloaded.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure cache root directory exists
if (!fs.existsSync(config.CACHE_DIR)) {
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
}

class CacheManager {
  constructor() {
    this.cacheIndex = new Map(); // username -> Array<item>
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(config.CACHE_DIR)) {
        const users = fs.readdirSync(config.CACHE_DIR);
        for (const u of users) {
          const indexPath = path.join(config.CACHE_DIR, u, 'index.json');
          if (fs.existsSync(indexPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
              this.cacheIndex.set(u, data);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  getUserCacheDir(username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const userDir = path.join(config.CACHE_DIR, clean);
    ['posts', 'stories', 'highlights', 'profile'].forEach(sub => {
      const p = path.join(userDir, sub);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });
    return userDir;
  }

  getCachedItems(username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const items = this.cacheIndex.get(clean) || [];
    // Verify files still exist on disk
    return items.filter(item => {
      if (item.filePath && !fs.existsSync(item.filePath)) return false;
      return true;
    });
  }

  saveUserIndex(username, items) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    this.cacheIndex.set(clean, items);
    const userDir = this.getUserCacheDir(clean);
    fs.writeFileSync(path.join(userDir, 'index.json'), JSON.stringify(items, null, 2), 'utf8');
  }

  recordCachedItem(username, item) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    let items = this.getCachedItems(clean);
    const existingIdx = items.findIndex(i => i.id === item.id);
    if (existingIdx !== -1) {
      items[existingIdx] = { ...items[existingIdx], ...item };
    } else {
      items.push(item);
    }
    this.saveUserIndex(clean, items);
    return item;
  }

  deleteCachedItem(username, itemId) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const items = this.getCachedItems(clean);
    const target = items.find(i => i.id === itemId);
    if (!target) return false;

    // Delete media file
    if (target.filePath && fs.existsSync(target.filePath)) {
      try { fs.unlinkSync(target.filePath); } catch (e) {}
    }
    // Delete thumbnail if present
    if (target.thumbnailPath && fs.existsSync(target.thumbnailPath)) {
      try { fs.unlinkSync(target.thumbnailPath); } catch (e) {}
    }
    // Delete caption file if present
    if (target.captionPath && fs.existsSync(target.captionPath)) {
      try { fs.unlinkSync(target.captionPath); } catch (e) {}
    }

    const remaining = items.filter(i => i.id !== itemId);
    this.saveUserIndex(clean, remaining);
    return true;
  }

  clearUserCache(username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const userDir = path.join(config.CACHE_DIR, clean);
    this.cacheIndex.delete(clean);
    if (fs.existsSync(userDir)) {
      try {
        fs.rmSync(userDir, { recursive: true, force: true });
      } catch (e) {}
    }
    return true;
  }

  clearAllCache() {
    this.cacheIndex.clear();
    if (fs.existsSync(config.CACHE_DIR)) {
      try {
        const users = fs.readdirSync(config.CACHE_DIR);
        for (const u of users) {
          const userDir = path.join(config.CACHE_DIR, u);
          fs.rmSync(userDir, { recursive: true, force: true });
        }
      } catch (e) {}
    }
    return true;
  }
}

module.exports = new CacheManager();
