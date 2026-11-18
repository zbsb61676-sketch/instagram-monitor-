/**
 * Ephemeral Cache Manager
 * Manages downloading Instagram media into temporary staging cache,
 * serving cached previews to the UI, handling user selection, and
 * deleting temporary cached items cleanly without disk I/O bottlenecks.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure cache root directory exists
if (!fs.existsSync(config.CACHE_DIR)) {
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
}

function cleanHandle(username) {
  return (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
}

class CacheManager {
  constructor(cacheDir = config.CACHE_DIR) {
    this.cacheDir = cacheDir;
    this.cacheIndex = new Map(); // username -> Array<item>
    this.inspectManifests = new Map(); // username -> { manifest, expiresAt }
    this.flushTimers = new Map(); // username -> NodeJS.Timeout
    this.dirReady = new Set(); // usernames whose subfolders already exist
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    this.init();
  }

  setInspectManifest(username, manifest, ttlMs = config.MAX_CACHE_AGE_MS || 30 * 60 * 1000) {
    const clean = cleanHandle(username);
    if (!clean || !manifest) return null;
    this.inspectManifests.set(clean, {
      manifest,
      expiresAt: Date.now() + ttlMs
    });
    return manifest;
  }

  getInspectManifest(username) {
    const clean = cleanHandle(username);
    if (!clean) return null;
    const entry = this.inspectManifests.get(clean);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.inspectManifests.delete(clean);
      return null;
    }
    return entry.manifest;
  }

  clearInspectManifest(username) {
    const clean = cleanHandle(username);
    if (clean) this.inspectManifests.delete(clean);
  }

  init() {
    try {
      if (fs.existsSync(this.cacheDir)) {
        const users = fs.readdirSync(this.cacheDir);
        for (const u of users) {
          const clean = cleanHandle(u);
          if (!clean) continue;
          const indexPath = path.join(this.cacheDir, clean, 'index.json');
          if (fs.existsSync(indexPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
              if (Array.isArray(data)) {
                this.cacheIndex.set(clean, data);
              }
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  getUserCacheDir(username) {
    const clean = cleanHandle(username);
    const userDir = path.join(this.cacheDir, clean);
    if (!this.dirReady.has(clean) || !fs.existsSync(userDir)) {
      ['posts', 'stories', 'highlights', 'profile'].forEach(sub => {
        const p = path.join(userDir, sub);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      });
      this.dirReady.add(clean);
    }
    return userDir;
  }

  getCachedItems(username) {
    const clean = cleanHandle(username);
    const items = this.cacheIndex.get(clean) || [];
    // Verify files still exist on disk
    return items.filter(item => {
      if (item.filePath && !fs.existsSync(item.filePath)) return false;
      return true;
    });
  }

  /**
   * Atomically persist a user's cache index to disk
   */
  flushUserIndex(username) {
    const clean = cleanHandle(username);
    if (!clean) return;
    if (this.flushTimers.has(clean)) {
      clearTimeout(this.flushTimers.get(clean));
      this.flushTimers.delete(clean);
    }

    const items = this.cacheIndex.get(clean);
    if (!items) return;

    try {
      const userDir = this.getUserCacheDir(clean);
      const indexPath = path.join(userDir, 'index.json');
      const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2), 'utf8');
      fs.renameSync(tmpPath, indexPath);
    } catch (e) {
      // Non-fatal if user cache was cleared mid-flush
    }
  }

  flushAll() {
    for (const clean of Array.from(this.flushTimers.keys())) {
      this.flushUserIndex(clean);
    }
  }

  saveUserIndex(username, items, immediate = false) {
    const clean = cleanHandle(username);
    if (!clean) return;
    this.cacheIndex.set(clean, items);

    if (immediate) {
      this.flushUserIndex(clean);
      return;
    }

    if (!this.flushTimers.has(clean)) {
      const timer = setTimeout(() => {
        this.flushTimers.delete(clean);
        this.flushUserIndex(clean);
      }, 250);
      if (typeof timer.unref === 'function') timer.unref();
      this.flushTimers.set(clean, timer);
    }
  }

  /**
   * Fast O(1)-I/O in-memory recording with debounced atomic index flush.
   * Safe for high-concurrency parallel downloads.
   */
  recordCachedItem(username, item) {
    const clean = cleanHandle(username);
    if (!clean || !item) return item;
    let items = this.cacheIndex.get(clean);
    if (!items) {
      items = [];
      this.cacheIndex.set(clean, items);
    }
    const existingIdx = items.findIndex(i => i.id === item.id);
    if (existingIdx !== -1) {
      items[existingIdx] = { ...items[existingIdx], ...item };
    } else {
      items.push(item);
    }
    this.saveUserIndex(clean, items, false);
    return item;
  }

  deleteCachedItem(username, itemId) {
    const clean = cleanHandle(username);
    const items = this.getCachedItems(clean);
    const target = items.find(i => i.id === itemId);
    if (!target) return false;

    this._unlinkItemFiles(target);

    const remaining = items.filter(i => i.id !== itemId);
    this.saveUserIndex(clean, remaining, true);
    return true;
  }

  deleteCachedItems(username, itemIds = []) {
    const clean = cleanHandle(username);
    if (!clean || !Array.isArray(itemIds) || itemIds.length === 0) return [];
    const idSet = new Set(itemIds);
    const items = this.getCachedItems(clean);
    const deletedIds = [];
    const remaining = [];

    for (const item of items) {
      if (idSet.has(item.id)) {
        this._unlinkItemFiles(item);
        deletedIds.push(item.id);
      } else {
        remaining.push(item);
      }
    }

    if (deletedIds.length > 0) {
      if (remaining.length === 0) {
        this.clearUserCache(clean);
      } else {
        this.saveUserIndex(clean, remaining, true);
      }
    }
    return deletedIds;
  }

  _unlinkItemFiles(target) {
    if (target.filePath && fs.existsSync(target.filePath)) {
      try { fs.unlinkSync(target.filePath); } catch (e) {}
    }
    if (target.thumbnailPath && target.thumbnailPath !== target.filePath && fs.existsSync(target.thumbnailPath)) {
      try { fs.unlinkSync(target.thumbnailPath); } catch (e) {}
    }
    if (target.captionPath && fs.existsSync(target.captionPath)) {
      try { fs.unlinkSync(target.captionPath); } catch (e) {}
    }
  }

  clearUserCache(username) {
    const clean = cleanHandle(username);
    if (!clean) return false;
    if (this.flushTimers.has(clean)) {
      clearTimeout(this.flushTimers.get(clean));
      this.flushTimers.delete(clean);
    }
    this.cacheIndex.delete(clean);
    this.inspectManifests.delete(clean);
    this.dirReady.delete(clean);
    const userDir = path.join(this.cacheDir, clean);
    if (fs.existsSync(userDir)) {
      try {
        fs.rmSync(userDir, { recursive: true, force: true });
      } catch (e) {}
    }
    return true;
  }

  clearAllCache() {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    this.cacheIndex.clear();
    this.inspectManifests.clear();
    this.dirReady.clear();
    if (fs.existsSync(this.cacheDir)) {
      try {
        const users = fs.readdirSync(this.cacheDir);
        for (const u of users) {
          const userDir = path.join(this.cacheDir, u);
          fs.rmSync(userDir, { recursive: true, force: true });
        }
      } catch (e) {}
    }
    return true;
  }
}

const cacheManagerInstance = new CacheManager();
cacheManagerInstance.CacheManager = CacheManager;
module.exports = cacheManagerInstance;
