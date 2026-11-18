const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure storage folders exist
for (const dir of [config.DATA_DIR, config.DOWNLOADS_DIR, config.CACHE_DIR]) {
  if (dir && !fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }
}

const defaultState = {
  settings: {
    telegramToken: process.env.TELEGRAM_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    defaultIntervalSec: parseInt(process.env.DEFAULT_INTERVAL_SEC || '3', 10),
    proxyUrl: process.env.PROXY_URL || '',
    sessionCookie: process.env.IG_SESSION_COOKIE || '',
    appUrl: process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '',
    soundAlertEnabled: true,
    autoDownloadOnPublic: true
  },
  targets: [],
  logs: [],
  downloadedMedia: {}
};

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._]{0,28}[a-z0-9])?$|^[a-z0-9]$/;

function sanitizeUsername(username) {
  return String(username || '').toLowerCase().trim().replace(/^@/, '');
}

function validateUsername(username) {
  const clean = sanitizeUsername(username);
  if (!clean) throw new Error('Username cannot be empty');
  if (clean.length > 30) throw new Error('Instagram usernames must be 30 characters or fewer');
  if (!/^[a-z0-9._]+$/.test(clean) || clean.includes('..')) {
    throw new Error('Invalid Instagram username format');
  }
  return clean;
}

class Database {
  constructor(filePath = config.DB_FILE) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.saveTimer = null;
    this.isDirty = false;
    this.recoveredFromBackup = false;
    this.data = this.load();
  }

  _parseState(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Database root must be a JSON object');
    }

    // Merge loaded settings with default/environment settings
    const mergedSettings = { ...defaultState.settings };
    if (parsed.settings && typeof parsed.settings === 'object') {
      for (const [key, val] of Object.entries(parsed.settings)) {
        if (val !== undefined && val !== null && val !== '') {
          mergedSettings[key] = val;
        }
      }
    }

    return {
      settings: mergedSettings,
      targets: Array.isArray(parsed.targets) ? parsed.targets : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      downloadedMedia: parsed.downloadedMedia && typeof parsed.downloadedMedia === 'object' ? parsed.downloadedMedia : {}
    };
  }

  load() {
    // 1. Try primary database file
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return this._parseState(raw);
      } catch (err) {
        console.error('[DB] Primary db.json is corrupted:', err.message);
      }
    }

    // 2. Fallback to rolling backup file if primary is missing or corrupted
    if (fs.existsSync(this.backupPath)) {
      try {
        const backupRaw = fs.readFileSync(this.backupPath, 'utf-8');
        const recovered = this._parseState(backupRaw);
        this.recoveredFromBackup = true;
        console.warn('[DB] Recovered state automatically from rolling backup (db.json.bak).');
        this.flushSync(recovered);
        return recovered;
      } catch (bakErr) {
        console.error('[DB] Backup db.json.bak also unreadable, initializing fresh defaults:', bakErr.message);
      }
    }

    const fresh = JSON.parse(JSON.stringify(defaultState));
    this.flushSync(fresh);
    return fresh;
  }

  /**
   * Save database with 500ms debouncing to minimize synchronous disk I/O.
   * If immediate is true, writes immediately to disk.
   */
  save(dataToSave = null, immediate = false) {
    if (dataToSave) {
      this.data = dataToSave;
    }
    this.isDirty = true;

    if (immediate) {
      this.flushSync();
      return;
    }

    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        if (this.isDirty) {
          this.flushSync();
        }
      }, 500);
      if (typeof this.saveTimer.unref === 'function') {
        this.saveTimer.unref();
      }
    }
  }

  /**
   * Atomic synchronous flush to disk with rolling backup preservation
   */
  flushSync(dataToSave = null) {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = dataToSave || this.data;
      const serialized = JSON.stringify(data, null, 2);

      // Preserve last-known-good file as .bak before replacing
      if (fs.existsSync(this.filePath)) {
        try {
          const existing = fs.readFileSync(this.filePath, 'utf-8');
          JSON.parse(existing); // Only back up if current file is valid JSON
          fs.copyFileSync(this.filePath, this.backupPath);
        } catch (e) {
          // Do not overwrite a good backup with a corrupted primary file
        }
      }

      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      fs.writeFileSync(tempPath, serialized, 'utf-8');
      fs.renameSync(tempPath, this.filePath);
      this.isDirty = false;
    } catch (err) {
      console.error('[DB] Failed to save database:', err.message);
    }
  }

  // --- Settings ---
  getSettings() {
    return { ...this.data.settings };
  }

  updateSettings(newSettings) {
    this.data.settings = { ...this.data.settings, ...newSettings };
    this.save();
    return this.data.settings;
  }

  // --- Targets ---
  getTargets() {
    return [...this.data.targets];
  }

  getTarget(idOrUsername) {
    if (!idOrUsername) return null;
    const raw = String(idOrUsername);
    const clean = raw.toLowerCase().trim().replace(/^@/, '');
    return this.data.targets.find(t => t.id === raw || t.username.toLowerCase() === clean);
  }

  addTarget(username, intervalSec = null) {
    const cleanUsername = validateUsername(username);

    const existing = this.getTarget(cleanUsername);
    if (existing) {
      throw new Error(`Target @${cleanUsername} is already being tracked`);
    }

    const parsedInterval = intervalSec !== null && intervalSec !== undefined ? parseInt(intervalSec, 10) : NaN;
    const interval = Math.max(
      config.MIN_CHECK_INTERVAL_SEC,
      Number.isFinite(parsedInterval) ? parsedInterval : (this.data.settings.defaultIntervalSec || 3)
    );

    const newTarget = {
      id: 'tgt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      username: cleanUsername,
      intervalSec: interval,
      status: 'pending',        // pending, private, public, rate_limited, not_found, error
      previousStatus: null,
      isMonitoring: true,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastChangedAt: null,
      consecutiveErrors: 0,
      totalChecks: 0,
      successfulChecks: 0,
      avgLatencyMs: null,
      profileInfo: {
        fullName: '',
        isVerified: false,
        biography: '',
        profilePicUrl: ''
      },
      createdAt: new Date().toISOString()
    };

    this.data.targets.push(newTarget);
    this.save();
    this.addLog(`Added target @${cleanUsername} with ${interval}s interval`, 'info', cleanUsername);
    return newTarget;
  }

  enrichTarget(target) {
    if (!target) return null;
    const allMedia = this.getDownloadedMedia(target.username);
    const diversePreviews = [];
    const seenCodes = new Set();

    for (const m of allMedia) {
      if (m.type === 'profile_pic') continue;
      const key = m.code || m.id;
      if (!seenCodes.has(key)) {
        seenCodes.add(key);
        diversePreviews.push(m);
      }
      if (diversePreviews.length >= 4) break;
    }

    return {
      ...target,
      downloadedCount: allMedia.length,
      recentMedia: diversePreviews
    };
  }

  getEnrichedTargets() {
    return this.data.targets.map(t => this.enrichTarget(t));
  }

  getEnrichedTarget(idOrUsername) {
    const t = this.getTarget(idOrUsername);
    return this.enrichTarget(t);
  }

  updateTarget(id, updates) {
    const target = this.data.targets.find(t => t.id === id);
    if (!target) return null;

    Object.assign(target, updates);
    this.save();
    return this.enrichTarget(target);
  }

  deleteTarget(id) {
    const idx = this.data.targets.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const removed = this.data.targets.splice(idx, 1)[0];
    this.save();
    this.addLog(`Removed target @${removed.username}`, 'info', removed.username);
    return true;
  }

  toggleTargetMonitoring(id, shouldMonitor = null) {
    const target = this.data.targets.find(t => t.id === id);
    if (!target) return null;
    target.isMonitoring = shouldMonitor !== null ? shouldMonitor : !target.isMonitoring;
    this.save();
    this.addLog(
      `${target.isMonitoring ? 'Resumed' : 'Paused'} monitoring for @${target.username}`,
      'info',
      target.username
    );
    return this.enrichTarget(target);
  }

  // --- Logs ---
  getLogs(limit = 100) {
    return this.data.logs.slice(-limit).reverse();
  }

  addLog(message, level = 'info', username = null) {
    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      timestamp: new Date().toISOString(),
      message,
      level, // info, success, warning, error, alert
      username
    };
    this.data.logs.push(entry);

    // Keep maximum 200 logs
    if (this.data.logs.length > 200) {
      this.data.logs.splice(0, this.data.logs.length - 200);
    }
    this.save();
    return entry;
  }

  clearLogs() {
    this.data.logs = [];
    this.save();
  }

  // --- Downloaded Media Registry & Deduplication ---
  isMediaDownloaded(username, mediaId) {
    const clean = username.toLowerCase().trim().replace(/^@/, '');
    if (!this.data.downloadedMedia) this.data.downloadedMedia = {};
    const userMedia = this.data.downloadedMedia[clean] || [];
    const targetId = String(mediaId);
    return userMedia.some(item => item.id === targetId || (item.code === targetId && !item.type?.includes('slide')));
  }

  recordDownloadedMedia(username, mediaItem) {
    const clean = username.toLowerCase().trim().replace(/^@/, '');
    if (!this.data.downloadedMedia) this.data.downloadedMedia = {};
    if (!this.data.downloadedMedia[clean]) this.data.downloadedMedia[clean] = [];

    const record = {
      id: String(mediaItem.id || mediaItem.code),
      code: mediaItem.code || '',
      type: mediaItem.type || 'photo', // photo, video, story, profile_pic, highlight_video, highlight_photo
      fileName: mediaItem.fileName || '',
      filePath: mediaItem.filePath || '',
      fileUrl: mediaItem.fileUrl || '',
      thumbnailUrl: mediaItem.thumbnailUrl || mediaItem.fileUrl || '',
      thumbnailPath: mediaItem.thumbnailPath || mediaItem.filePath || '',
      highlightId: mediaItem.highlightId || '',
      highlightTitle: mediaItem.highlightTitle || '',
      caption: mediaItem.caption || '',
      downloadedAt: new Date().toISOString()
    };

    // Prevent duplicates in registry
    const exists = this.data.downloadedMedia[clean].some(m => m.id === record.id);
    if (!exists) {
      this.data.downloadedMedia[clean].push(record);
      this.save();
    }
    return record;
  }

  getDownloadedMedia(username) {
    if (!this.data.downloadedMedia) this.data.downloadedMedia = {};
    if (!username) {
      return Object.values(this.data.downloadedMedia).flat();
    }
    const clean = String(username).toLowerCase().trim().replace(/^@/, '');
    return this.data.downloadedMedia[clean] || [];
  }

  getDownloadedMediaCount(username) {
    return this.getDownloadedMedia(username).length;
  }
}

const dbInstance = new Database();
dbInstance.Database = Database;
dbInstance.validateUsername = validateUsername;
module.exports = dbInstance;
