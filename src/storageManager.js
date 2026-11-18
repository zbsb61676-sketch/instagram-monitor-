/**
 * Storage & Disk Quota Manager
 * Prevents unbounded disk growth on cloud containers (Render / Railway / Docker)
 * by sweeping expired temporary cache directories and enforcing a configurable
 * maximum disk budget for archived downloads.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

class StorageManager {
  constructor(options = {}) {
    this.downloadsDir = options.downloadsDir || config.DOWNLOADS_DIR;
    this.cacheDir = options.cacheDir || config.CACHE_DIR;
    this.maxStorageBytes = (options.maxStorageMb || config.MAX_STORAGE_MB || 500) * 1024 * 1024;
    this.maxCacheAgeMs = options.maxCacheAgeMs || config.MAX_CACHE_AGE_MS || (30 * 60 * 1000);
    this.intervalId = null;
    this.lastPruneAt = null;
    this.totalPrunedFiles = 0;
  }

  /**
   * Recursively collect files with size and mtime metadata
   */
  listFiles(dir, collected = []) {
    if (!dir || !fs.existsSync(dir)) return collected;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return collected;
    }

    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        this.listFiles(fullPath, collected);
      } else if (ent.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          collected.push({
            path: fullPath,
            name: ent.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs
          });
        } catch (e) {
          // file may have been removed concurrently
        }
      }
    }
    return collected;
  }

  /**
   * Remove empty subdirectories under a root directory (never removes root itself)
   */
  removeEmptyDirs(dir, isRoot = true) {
    if (!dir || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const ent of entries) {
      if (ent.isDirectory()) {
        this.removeEmptyDirs(path.join(dir, ent.name), false);
      }
    }

    if (!isRoot) {
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch (e) {}
    }
  }

  /**
   * Sweep expired cache directories older than maxCacheAgeMs
   */
  pruneExpiredCache(nowMs = Date.now()) {
    if (!this.cacheDir || !fs.existsSync(this.cacheDir)) {
      return { removedDirs: 0, freedBytes: 0 };
    }

    let removedDirs = 0;
    let freedBytes = 0;
    let entries;
    try {
      entries = fs.readdirSync(this.cacheDir, { withFileTypes: true });
    } catch (e) {
      return { removedDirs: 0, freedBytes: 0 };
    }

    for (const ent of entries) {
      const fullPath = path.join(this.cacheDir, ent.name);
      if (!ent.isDirectory()) continue;

      const files = this.listFiles(fullPath);
      let newestMtime = 0;
      let dirBytes = 0;
      for (const f of files) {
        dirBytes += f.size;
        if (f.mtimeMs > newestMtime) newestMtime = f.mtimeMs;
      }

      if (newestMtime === 0) {
        try {
          newestMtime = fs.statSync(fullPath).mtimeMs;
        } catch (e) {}
      }

      if (nowMs - newestMtime > this.maxCacheAgeMs) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedDirs++;
          freedBytes += dirBytes;
        } catch (e) {}
      }
    }

    return { removedDirs, freedBytes };
  }

  /**
   * Enforce disk quota on downloads directory by evicting oldest files first
   */
  enforceDownloadQuota() {
    if (!this.downloadsDir || !fs.existsSync(this.downloadsDir)) {
      return { evictedFiles: 0, freedBytes: 0 };
    }

    const files = this.listFiles(this.downloadsDir).filter(f => !f.name.endsWith('.tmp'));
    let totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    if (totalBytes <= this.maxStorageBytes) {
      return { evictedFiles: 0, freedBytes: 0 };
    }

    // Oldest files evicted first until below 85% of quota to avoid thrashing
    const targetBytes = Math.floor(this.maxStorageBytes * 0.85);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let evictedFiles = 0;
    let freedBytes = 0;

    for (const file of files) {
      if (totalBytes <= targetBytes) break;
      try {
        fs.unlinkSync(file.path);
        totalBytes -= file.size;
        freedBytes += file.size;
        evictedFiles++;
        this.totalPrunedFiles++;
      } catch (e) {}
    }

    if (evictedFiles > 0) {
      this.removeEmptyDirs(this.downloadsDir, true);
    }

    return { evictedFiles, freedBytes };
  }

  /**
   * Run full maintenance sweep
   */
  runMaintenance() {
    this.lastPruneAt = new Date().toISOString();
    const cacheResult = this.pruneExpiredCache();
    const quotaResult = this.enforceDownloadQuota();
    if (cacheResult.removedDirs > 0 || quotaResult.evictedFiles > 0) {
      console.log(
        `[Storage] Maintenance complete: removed ${cacheResult.removedDirs} stale cache dir(s), evicted ${quotaResult.evictedFiles} old download file(s).`
      );
    }
    return { cacheResult, quotaResult };
  }

  /**
   * Start periodic background maintenance (every 5 minutes)
   */
  start(intervalMs = 5 * 60 * 1000) {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      try {
        this.runMaintenance();
      } catch (e) {
        console.error('[Storage] Maintenance error:', e.message);
      }
    }, intervalMs);
    if (typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Return current storage diagnostics
   */
  getStats() {
    const downloadFiles = this.listFiles(this.downloadsDir);
    const cacheFiles = this.listFiles(this.cacheDir);
    const downloadsBytes = downloadFiles.reduce((s, f) => s + f.size, 0);
    const cacheBytes = cacheFiles.reduce((s, f) => s + f.size, 0);

    return {
      downloadsBytes,
      downloadsMB: Number((downloadsBytes / (1024 * 1024)).toFixed(2)),
      downloadsFileCount: downloadFiles.length,
      cacheBytes,
      cacheMB: Number((cacheBytes / (1024 * 1024)).toFixed(2)),
      cacheFileCount: cacheFiles.length,
      maxStorageMB: Math.round(this.maxStorageBytes / (1024 * 1024)),
      usagePercent: this.maxStorageBytes > 0 ? Number(((downloadsBytes / this.maxStorageBytes) * 100).toFixed(1)) : 0,
      totalPrunedFiles: this.totalPrunedFiles,
      lastPruneAt: this.lastPruneAt
    };
  }
}

const storageManager = new StorageManager();
storageManager.StorageManager = StorageManager;
module.exports = storageManager;
