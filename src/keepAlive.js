/**
 * Render & Cloud Host 24/7 Keep-Alive Engine
 * 
 * Prevents Render.com free-tier web services from sleeping after 15 minutes of inactivity
 * by automatically sending periodic HTTP heartbeats to the public endpoint.
 */

require('./dnsPatch');

const db = require('./db');

class KeepAliveService {
  constructor() {
    this.intervalId = null;
    this.intervalMs = 10 * 60 * 1000; // 10 minutes (Render sleeps at 15m)
    this.isRunning = false;
    this.stats = {
      appUrl: null,
      isRender: false,
      pingCount: 0,
      lastPingTime: null,
      lastPingStatus: 'initialized',
      lastPingLatencyMs: null,
      lastError: null,
      startedAt: null
    };
  }

  /**
   * Resolves the public URL for self-pinging.
   * Priority:
   * 1. process.env.RENDER_EXTERNAL_URL (Render automatically injects this)
   * 2. process.env.APP_URL
   * 3. process.env.SERVER_URL
   * 4. db.getSettings().appUrl
   */
  getPublicUrl() {
    const settings = db.getSettings();
    let raw = process.env.RENDER_EXTERNAL_URL ||
              process.env.APP_URL ||
              process.env.SERVER_URL ||
              settings.appUrl ||
              '';

    raw = (raw || '').trim().replace(/\/+$/, '');
    if (raw && !raw.startsWith('http://') && !raw.startsWith('https://')) {
      raw = `https://${raw}`;
    }
    return raw;
  }

  /**
   * Sets or updates the public URL manually (persists in settings)
   */
  setPublicUrl(url) {
    let clean = (url || '').trim().replace(/\/+$/, '');
    if (clean && !clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = `https://${clean}`;
    }
    db.updateSettings({ appUrl: clean });
    this.stats.appUrl = clean;
    return clean;
  }

  /**
   * Starts the periodic keep-alive loop
   */
  start() {
    if (this.isRunning) return;

    this.stats.isRender = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
    this.stats.appUrl = this.getPublicUrl();
    this.stats.startedAt = new Date().toISOString();
    this.isRunning = true;

    if (this.stats.appUrl) {
      console.log(`[KeepAlive] Engine active! Target URL: ${this.stats.appUrl}/health (Pinging every 10m to prevent sleep)`);
      db.addLog(`Keep-Alive active for ${this.stats.appUrl} (10m heartbeat to prevent Render sleep)`, 'info');
      
      // Initial ping after 30 seconds
      setTimeout(() => {
        this.pingNow().catch(() => {});
      }, 30000);
    } else {
      console.log('[KeepAlive] Note: Public URL not yet detected. Set RENDER_EXTERNAL_URL, APP_URL, or configure in settings/bot.');
    }

    // Schedule regular 10-minute heartbeat
    this.intervalId = setInterval(() => {
      this.pingNow().catch(() => {});
    }, this.intervalMs);
  }

  /**
   * Stops the keep-alive loop
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  /**
   * Executes a single self-ping request
   */
  async pingNow() {
    const url = this.getPublicUrl();
    if (!url) {
      this.stats.lastPingStatus = 'no_url_configured';
      return { ok: false, error: 'No public URL configured for keep-alive' };
    }

    const pingTarget = `${url}/health`;
    const t0 = Date.now();

    try {
      const res = await fetch(pingTarget, {
        method: 'GET',
        headers: {
          'User-Agent': 'Render-KeepAlive-Heartbeat/2.0 (+https://github.com/zbsb61676-sketch/instagram-monitor-)',
          'Accept': 'application/json,text/plain,*/*'
        },
        signal: AbortSignal.timeout(15000)
      });

      const latency = Date.now() - t0;
      this.stats.pingCount++;
      this.stats.lastPingTime = new Date().toISOString();
      this.stats.lastPingLatencyMs = latency;

      if (res.ok) {
        this.stats.lastPingStatus = 'success';
        this.stats.lastError = null;
        console.log(`[KeepAlive] Heartbeat succeeded (${latency}ms) -> ${pingTarget} [Render Sleep Timer Reset]`);
        return { ok: true, latency, status: res.status };
      } else {
        this.stats.lastPingStatus = `http_${res.status}`;
        this.stats.lastError = `HTTP ${res.status}`;
        console.warn(`[KeepAlive] Heartbeat returned HTTP ${res.status} from ${pingTarget}`);
        return { ok: false, latency, status: res.status };
      }
    } catch (err) {
      const latency = Date.now() - t0;
      this.stats.lastPingTime = new Date().toISOString();
      this.stats.lastPingStatus = 'failed';
      this.stats.lastError = err.message;
      console.warn(`[KeepAlive] Heartbeat ping failed (${err.message})`);
      return { ok: false, error: err.message, latency };
    }
  }

  /**
   * Returns current keep-alive diagnostics
   */
  getStatus() {
    const url = this.getPublicUrl();
    return {
      active: this.isRunning,
      configuredUrl: url || null,
      isRender: this.stats.isRender,
      pingCount: this.stats.pingCount,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      lastPingTime: this.stats.lastPingTime,
      lastPingStatus: this.stats.lastPingStatus,
      lastPingLatencyMs: this.stats.lastPingLatencyMs,
      lastError: this.stats.lastError,
      startedAt: this.stats.startedAt
    };
  }
}

module.exports = new KeepAliveService();
