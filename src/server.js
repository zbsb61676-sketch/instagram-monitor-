require('./dnsPatch');

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const monitor = require('./monitor');
const { testTelegram, testDiscord, dispatchTransitionAlert } = require('./notifier');
const { downloadTargetContent } = require('./downloader');
const proxyManager = require('./proxyManager');
const cacheManager = require('./cacheManager');
const telegramBot = require('./telegramBot');
const keepAlive = require('./keepAlive');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/downloads', express.static(config.DOWNLOADS_DIR));
app.use('/cache', express.static(config.CACHE_DIR));

// Clean up any stale cache from prior runs on boot
cacheManager.clearAllCache();

// Strict username sanitization preventing path traversal
function cleanHandle(username) {
  return (username || '').trim().toLowerCase().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
}

// Active client tracking for session-based temporary cache lifecycle
const activeClientSessions = new Map(); // ws -> Set<username>
const userCleanupTimers = new Map(); // username -> NodeJS.Timeout

function registerUserViewingCache(ws, username) {
  const clean = cleanHandle(username);
  if (!clean) return;
  if (!activeClientSessions.has(ws)) {
    activeClientSessions.set(ws, new Set());
  }
  activeClientSessions.get(ws).add(clean);

  // Cancel any scheduled cleanup timer for this user
  if (userCleanupTimers.has(clean)) {
    clearTimeout(userCleanupTimers.get(clean));
    userCleanupTimers.delete(clean);
  }
}

function scheduleUserCacheCleanup(username, delayMs = 15000) {
  const clean = cleanHandle(username);
  if (!clean) return;
  if (userCleanupTimers.has(clean)) {
    clearTimeout(userCleanupTimers.get(clean));
  }

  const timer = setTimeout(() => {
    userCleanupTimers.delete(clean);
    // Verify no remaining client is connected and viewing this profile
    let stillActive = false;
    for (const [clientWs, userSet] of activeClientSessions.entries()) {
      if (clientWs.readyState === 1 && userSet.has(clean)) {
        stillActive = true;
        break;
      }
    }

    if (!stillActive) {
      cacheManager.clearUserCache(clean);
      db.addLog(`User left the site: automatically cleared temporary cache for @${clean}`, 'info', clean);
      broadcast({ type: 'CACHE_CLEARED', data: { username: clean, reason: 'SESSION_CLOSED' } });
    }
  }, delayMs);

  userCleanupTimers.set(clean, timer);
}

// WebSocket broadcast helper
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(data);
    }
  }
}

// Hook monitor broadcast
monitor.setBroadcastFunction((msg) => {
  broadcast(msg);
});

// Broadcast db logs when added
const originalAddLog = db.addLog.bind(db);
db.addLog = function(message, level = 'info', username = null) {
  const logEntry = originalAddLog(message, level, username);
  broadcast({
    type: 'LOG_ADDED',
    data: logEntry
  });
  return logEntry;
};

// --- WebSocket Connection with 30s Zombie Cleanup Heartbeat ---
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Send initial state upon connection
  ws.send(JSON.stringify({
    type: 'INIT',
    data: {
      targets: db.getEnrichedTargets(),
      settings: db.getSettings(),
      logs: db.getLogs(50),
      serverTime: new Date().toISOString()
    }
  }));

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'PING') {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: 'PONG' }));
      } else if (parsed.type === 'VIEWING_CACHE' && parsed.username) {
        registerUserViewingCache(ws, parsed.username);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    const userSet = activeClientSessions.get(ws);
    activeClientSessions.delete(ws);
    if (userSet) {
      for (const username of userSet) {
        scheduleUserCacheCleanup(username, 15000);
      }
    }
  });
});

// Periodic heartbeat to terminate abandoned or zombie sockets
const wsHeartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
    } else {
      client.isAlive = false;
      client.ping();
    }
  }
}, 30000);

// --- REST API Endpoints ---

// Health & Ping Endpoints (Render.com 24/7 Anti-Sleep Keep-Alive)
app.get(['/health', '/ping', '/api/ping'], (req, res) => {
  const keepAliveStatus = keepAlive.getStatus();
  res.json({
    status: 'ok',
    service: 'instagram-privacy-monitor',
    uptime: process.uptime(),
    keepAlive: {
      active: keepAliveStatus.active,
      pingCount: keepAliveStatus.pingCount,
      lastPing: keepAliveStatus.lastPingTime,
      url: keepAliveStatus.configuredUrl
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/keepalive', (req, res) => {
  res.json(keepAlive.getStatus());
});

app.post('/api/keepalive/ping', async (req, res) => {
  const result = await keepAlive.pingNow();
  res.json(result);
});

app.get('/api/status', (req, res) => {
  const targets = db.getTargets();
  const activeCount = targets.filter(t => t.isMonitoring).length;
  res.json({
    status: 'online',
    uptime: process.uptime(),
    targetsCount: targets.length,
    activeMonitoringCount: activeCount,
    serverTime: new Date().toISOString()
  });
});

// IG Session Health Check
app.get('/api/session/status', async (req, res) => {
  const settings = db.getSettings();
  const cookieStr = settings.sessionCookie || '';
  if (!cookieStr) {
    return res.json({
      configured: false,
      valid: false,
      userId: null,
      message: 'No Instagram session cookie configured'
    });
  }

  const userIdMatch = cookieStr.match(/ds_user_id=([^;]+)/);
  const userId = userIdMatch ? userIdMatch[1] : null;

  try {
    const checkRes = await fetch('https://www.instagram.com/accounts/edit/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Cookie': cookieStr,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(6000)
    });

    const isValid = checkRes.status === 200 && (!checkRes.headers.get('location') || !checkRes.headers.get('location').includes('login'));
    res.json({
      configured: true,
      valid: isValid,
      status: checkRes.status,
      userId: userId || 'active',
      message: isValid ? `Active session for ID: ${userId || 'active'}` : `Session expired or invalid (HTTP ${checkRes.status})`
    });
  } catch (err) {
    res.json({
      configured: true,
      valid: false,
      error: err.message,
      userId: userId || null,
      message: `Error verifying session: ${err.message}`
    });
  }
});

// Proxy Pool Health & Rotation Status
app.get('/api/proxies/status', (req, res) => {
  res.json(proxyManager.getStats());
});

// Targets CRUD
app.get('/api/targets', (req, res) => {
  res.json(db.getEnrichedTargets());
});

app.post('/api/targets', (req, res) => {
  try {
    const { username, intervalSec } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    const newTarget = db.addTarget(username, intervalSec);
    monitor.onTargetUpdated(newTarget);
    broadcast({ type: 'TARGET_ADDED', data: db.enrichTarget(newTarget) });
    res.status(201).json(db.enrichTarget(newTarget));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/targets/:id', (req, res) => {
  try {
    const { intervalSec, isMonitoring } = req.body;
    const target = db.getTarget(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Target not found' });
    }

    const updates = {};
    if (intervalSec !== undefined) {
      updates.intervalSec = Math.max(config.MIN_CHECK_INTERVAL_SEC, parseInt(intervalSec, 10));
    }
    if (isMonitoring !== undefined) {
      updates.isMonitoring = Boolean(isMonitoring);
    }

    const updated = db.updateTarget(req.params.id, updates);
    monitor.onTargetUpdated(updated);
    broadcast({ type: 'TARGET_UPDATED', data: updated });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/targets/:id/toggle', (req, res) => {
  const target = db.getTarget(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Target not found' });
  }

  const updated = db.toggleTargetMonitoring(req.params.id);
  monitor.onTargetUpdated(updated);
  broadcast({ type: 'TARGET_UPDATED', data: updated });
  res.json(updated);
});

app.post('/api/targets/:id/check', async (req, res) => {
  try {
    const updated = await monitor.checkNow(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/targets/:id/simulate-transition', async (req, res) => {
  try {
    const target = db.getTarget(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Target not found' });
    }
    const current = (target.lastKnownPrivacyState || (target.status === 'public' ? 'public' : 'private'));
    const newStatus = current === 'public' ? 'private' : 'public';
    const now = new Date().toISOString();

    const updates = {
      status: newStatus,
      previousStatus: current,
      lastKnownPrivacyState: newStatus,
      lastChangedAt: now
    };

    const updated = db.updateTarget(target.id, updates);
    const settings = db.getSettings();

    // Trigger full transition alert (Telegram, Discord, Web Audio Siren, Banner)
    await dispatchTransitionAlert(
      updated,
      current,
      newStatus,
      settings,
      db,
      (msg) => broadcast(msg)
    );

    // If flipped to public and auto-download enabled, trigger auto-download
    if (newStatus === 'public' && settings.autoDownloadOnPublic !== false) {
      downloadTargetContent(target.username, {
        proxyUrl: settings.proxyUrl,
        sessionCookie: settings.sessionCookie
      }).catch(err => {
        console.error('[Simulate] Auto download error:', err.message);
      });
    }

    broadcast({ type: 'TARGET_UPDATED', data: updated });
    res.json({ success: true, from: current, to: newStatus, target: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/targets/:id', (req, res) => {
  const id = req.params.id;
  const target = db.getTarget(id);
  if (!target) {
    return res.status(404).json({ error: 'Target not found' });
  }

  monitor.onTargetDeleted(id);
  db.deleteTarget(id);
  broadcast({ type: 'TARGET_DELETED', data: { id } });
  res.json({ success: true, id });
});

// Download Content Endpoints
app.post('/api/targets/:id/download', async (req, res) => {
  const target = db.getTarget(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Target not found' });
  }

  const settings = db.getSettings();
  try {
    const summary = await downloadTargetContent(target.username, {
      proxyUrl: settings.proxyUrl,
      sessionCookie: settings.sessionCookie
    });

    const updatedMedia = db.getDownloadedMedia(target.username);
    broadcast({
      type: 'MEDIA_DOWNLOADED',
      data: {
        targetId: target.id,
        username: target.username,
        summary,
        totalDownloaded: updatedMedia.length
      }
    });

    res.json({
      success: true,
      summary,
      totalDownloaded: updatedMedia.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/targets/:id/downloads', (req, res) => {
  const target = db.getTarget(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Target not found' });
  }

  const media = db.getDownloadedMedia(target.username);
  res.json({
    username: target.username,
    count: media.length,
    items: media
  });
});

// Ephemeral Cache: Inspect & Cache Profile Media (Real-Time Live Download)
app.post(['/api/cache/inspect', '/api/download-live'], async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const clean = cleanHandle(username);
  if (!clean) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
  const settings = db.getSettings();

  // Clear previous cache for this user to ensure fresh, real-time data from Instagram
  cacheManager.clearUserCache(clean);

  broadcast({
    type: 'LIVE_DOWNLOAD_STARTED',
    data: { username: clean, timestamp: new Date().toISOString() }
  });

  try {
    const summary = await downloadTargetContent(clean, {
      proxyUrl: settings.proxyUrl,
      sessionCookie: settings.sessionCookie,
      isCache: true
    }, (progressEvent) => {
      broadcast({
        type: 'LIVE_ITEM_DOWNLOADED',
        data: {
          username: clean,
          item: progressEvent.item,
          current: progressEvent.current,
          total: progressEvent.total
        }
      });
    });

    const cachedItems = cacheManager.getCachedItems(clean);
    broadcast({
      type: 'LIVE_DOWNLOAD_COMPLETED',
      data: {
        username: clean,
        summary,
        totalItems: cachedItems.length,
        items: cachedItems
      }
    });

    res.json({
      success: true,
      summary,
      items: cachedItems
    });
  } catch (err) {
    broadcast({
      type: 'LIVE_DOWNLOAD_FAILED',
      data: { username: clean, error: err.message }
    });
    res.status(500).json({ error: err.message });
  }
});

// Get current cached items for a user
app.get('/api/cache/:username', (req, res) => {
  const clean = cleanHandle(req.params.username);
  const items = cacheManager.getCachedItems(clean);
  res.json({ username: clean, count: items.length, items });
});

// Download single cached item (preserved on server while user is on site)
app.get('/api/cache/download/:username/:itemId', (req, res) => {
  const clean = cleanHandle(req.params.username);
  const itemId = req.params.itemId;
  const items = cacheManager.getCachedItems(clean);
  const target = items.find(i => i.id === itemId);

  if (!target || !target.filePath || !fs.existsSync(target.filePath)) {
    return res.status(404).send('Cached media not found');
  }

  // Stream file to client; media remains in server cache while user is browsing the site
  res.download(target.filePath, target.fileName);
});

// Download selected cached items as ZIP (preserved on server while user is on site)
app.post('/api/cache/download-selected', (req, res) => {
  const { username, itemIds } = req.body;
  if (!username || !Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'Username and itemIds array are required' });
  }

  const clean = cleanHandle(username);
  if (!clean) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
  const allItems = cacheManager.getCachedItems(clean);
  const selectedItems = allItems.filter(i => itemIds.includes(i.id) && i.filePath && fs.existsSync(i.filePath));

  if (selectedItems.length === 0) {
    return res.status(404).json({ error: 'No matching files found in cache' });
  }

  // Fast store mode (no re-compression, instant streaming, avoids OOM RAM spikes)
  const archive = createZipArchive({ store: true });
  const zipFilename = `${clean}_selected_${selectedItems.length}_files_${Date.now()}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  archive.on('error', (err) => {
    console.error(`[ZIP] Error creating selected archive for @${clean}:`, err);
    if (!res.headersSent) {
      res.status(500).send('Error creating ZIP archive');
    }
  });

  archive.pipe(res);

  for (const item of selectedItems) {
    archive.file(item.filePath, { name: item.fileName });
    if (item.code) {
      const userDir = path.join(config.CACHE_DIR, clean);
      const captionPath = path.join(userDir, 'posts', `${item.code}_caption.txt`);
      if (fs.existsSync(captionPath)) {
        archive.file(captionPath, { name: `${item.code}_caption.txt` });
      }
    }
  }

  archive.finalize();
});

// Session cleanup beacon when user closes browser tab or navigates away from site
app.post('/api/cache/session-cleanup', express.text({ type: '*/*' }), (req, res) => {
  try {
    let username = '';
    if (typeof req.body === 'string') {
      try { username = JSON.parse(req.body).username; } catch (e) { username = req.body; }
    } else if (req.body && req.body.username) {
      username = req.body.username;
    }

    if (username) {
      const clean = cleanHandle(username);
  if (!clean) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
      scheduleUserCacheCleanup(clean, 4000); // Purge within 4 seconds of leaving
    }
  } catch (e) {}
  res.status(200).send('OK');
});

// Clear cache for a user
app.delete('/api/cache/:username', (req, res) => {
  const clean = cleanHandle(req.params.username);
  if (!clean) return res.status(400).json({ error: 'Invalid username' });
  cacheManager.clearUserCache(clean);
  broadcast({
    type: 'CACHE_CLEARED',
    data: { username: clean }
  });
  res.json({ success: true, message: `Cache cleared for @${clean}` });
});

function createZipArchive(options = {}) {
  if (typeof archiver === 'function') {
    return archiver('zip', options);
  }
  if (archiver && archiver.ZipArchive) {
    return new archiver.ZipArchive(options);
  }
  throw new Error('Unsupported archiver module format');
}

// Download Target Archive as a single ZIP file
app.get('/api/targets/:id/download-zip', (req, res) => {
  const target = db.getTarget(req.params.id);
  if (!target) {
    return res.status(404).send('Target not found');
  }

  const clean = cleanHandle(target.username);
  sendTargetZip(clean, res);
});

// Download Any Profile Archive as a single ZIP file by username
app.get('/api/download-zip/:username', (req, res) => {
  const clean = cleanHandle(req.params.username);
  if (!clean) return res.status(400).send('Invalid username');
  sendTargetZip(clean, res);
});

function sendTargetZip(clean, res) {
  const targetDir = path.join(config.DOWNLOADS_DIR, clean);

  if (!fs.existsSync(targetDir)) {
    return res.status(404).send(`No downloaded media found for @${clean}`);
  }

  // Fast store mode (near 0% CPU, no OOM RAM spikes on already compressed media)
  const archive = createZipArchive({ store: true });

  const zipFilename = `${clean}_instagram_archive_${new Date().toISOString().slice(0, 10)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  archive.on('error', (err) => {
    console.error(`[ZIP] Archive error for @${clean}:`, err);
    if (!res.headersSent) {
      res.status(500).send('Error creating ZIP archive');
    }
  });

  archive.pipe(res);
  archive.directory(targetDir, false);
  archive.finalize();
}

// In-App Anonymous Backup Viewer Proxy (Allows AnonyIG to run directly inside our dashboard)
app.get('/api/backup-viewer/:username', async (req, res) => {
  const clean = cleanHandle(req.params.username);
  if (!clean) return res.status(400).send('Invalid username');

  try {
    const upstreamUrl = `https://anonyig.com/en2/?url=${encodeURIComponent(clean)}`;
    const upstreamRes = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send(`Backup provider returned HTTP ${upstreamRes.status}`);
    }

    let html = await upstreamRes.text();

    // Inject <base href="https://anonyig.com/"> so all relative assets, CSS, and JS load properly
    html = html.replace('<head>', '<head><base href="https://anonyig.com/">');

    // Inject fallback banner in case browser blocks cross-origin requests
    const directUrl = `https://anonyig.com/en2/?url=${encodeURIComponent(clean)}`;
    const topBanner = `
      <div style="background:#0f172a; border-bottom:1px solid #334155; padding:8px 16px; display:flex; justify-content:space-between; align-items:center; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-size:12px; z-index:999999; position:sticky; top:0;">
        <span>🛡️ <b>Anonymous Story & Highlight Viewer:</b> If stories or highlights take long to load in this frame:</span>
        <a href="${directUrl}" target="_blank" rel="noopener noreferrer" style="background:#06b6d4; color:#fff; font-weight:700; padding:5px 14px; border-radius:6px; text-decoration:none; margin-left:12px; white-space:nowrap; display:inline-flex; align-items:center; gap:6px;">Open Direct Tab (Fast Download) &rarr;</a>
      </div>
    `;
    html = html.replace(/<body[^>]*>/i, `$&${topBanner}`);

    // Strip frame-ancestors and X-Frame-Options to allow seamless in-app embedding
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');

    res.send(html);
  } catch (err) {
    res.status(502).send(`Failed to load in-app backup viewer: ${err.message}`);
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  const settings = db.getSettings();
  const rawCookie = settings.sessionCookie || '';
  const sessionMatch = rawCookie.match(/sessionid=([^;]+)/);
  const maskedCookie = sessionMatch
    ? `sessionid=${sessionMatch[1].slice(0, 8)}...***`
    : (rawCookie ? `${rawCookie.slice(0, 10)}...***` : '');

  // Mask sensitive token & cookie for security
  const masked = {
    ...settings,
    sessionCookie: maskedCookie,
    telegramTokenMasked: settings.telegramToken ? `${settings.telegramToken.slice(0, 6)}...${settings.telegramToken.slice(-4)}` : '',
    hasSessionCookie: Boolean(rawCookie)
  };
  res.json(masked);
});

app.put('/api/settings', (req, res) => {
  try {
    const allowed = [
      'telegramToken',
      'telegramChatId',
      'discordWebhookUrl',
      'defaultIntervalSec',
      'proxyUrl',
      'sessionCookie',
      'appUrl',
      'soundAlertEnabled',
      'autoDownloadOnPublic'
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // If incoming sessionCookie or telegramToken is the masked placeholder, do not overwrite the real secret
        if (key === 'sessionCookie' && typeof req.body[key] === 'string' && req.body[key].includes('...***')) {
          continue;
        }
        if (key === 'telegramToken' && typeof req.body[key] === 'string' && req.body[key].includes('...')) {
          continue;
        }
        updates[key] = req.body[key];
      }
    }
    const updated = db.updateSettings(updates);
    if (updates.appUrl !== undefined) {
      keepAlive.setPublicUrl(updates.appUrl);
    }
    db.addLog('System settings updated', 'info');
    telegramBot.restart();
    broadcast({ type: 'SETTINGS_UPDATED', data: updated });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Test Notification Endpoints
app.post('/api/settings/test-telegram', async (req, res) => {
  const currentSettings = db.getSettings();
  const token = req.body.token || currentSettings.telegramToken;
  const chatId = req.body.chatId || currentSettings.telegramChatId;

  const result = await testTelegram(token, chatId);
  if (result.success) {
    db.addLog('Sent test notification to Telegram', 'success');
    return res.json(result);
  } else {
    db.addLog(`Failed to send Telegram test notification: ${result.error}`, 'error');
    return res.status(400).json(result);
  }
});

app.post('/api/settings/test-discord', async (req, res) => {
  const currentSettings = db.getSettings();
  const webhookUrl = req.body.webhookUrl || currentSettings.discordWebhookUrl;

  const result = await testDiscord(webhookUrl);
  if (result.success) {
    db.addLog('Sent test notification to Discord', 'success');
    return res.json(result);
  } else {
    db.addLog(`Failed to send Discord test notification: ${result.error}`, 'error');
    return res.status(400).json(result);
  }
});

// Logs
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  res.json(db.getLogs(limit));
});

app.delete('/api/logs', (req, res) => {
  db.clearLogs();
  broadcast({ type: 'LOGS_CLEARED' });
  res.json({ success: true });
});

// Fallback to index.html for SPA routing
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start Server
server.listen(config.PORT, config.HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 Instagram Privacy Status Monitor is Running!`);
  console.log(`🌐 Local Web Dashboard: http://localhost:${config.PORT}`);
  console.log(`====================================================`);
  monitor.start();
  telegramBot.setBroadcastFunction(broadcast);
  telegramBot.setMonitorService(monitor);
  telegramBot.start();
  keepAlive.start();
});

// Graceful shutdown on SIGINT & SIGTERM (Render / Railway / Docker / Kubernetes)
const handleShutdown = (signal) => {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  if (typeof wsHeartbeatInterval !== 'undefined') {
    clearInterval(wsHeartbeatInterval);
  }
  keepAlive.stop();
  monitor.stop();
  telegramBot.stop();
  db.flushSync(); // Ensure all debounced database changes are written to disk
  server.close(() => {
    console.log('[Server] HTTP and WebSocket servers closed. Exiting.');
    process.exit(0);
  });
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
