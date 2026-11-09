/**
 * Rotating Proxy Pool Manager
 * Handles single or multiple proxy URLs (newline or comma-separated) with round-robin rotation & cooldowns.
 */

const db = require('./db');

class ProxyManager {
  constructor() {
    this.currentIndex = 0;
    this.failedProxies = new Map(); // proxyUrl -> cooldownUntil timestamp
  }

  getProxyList() {
    const settings = db.getSettings();
    const raw = (settings.proxyUrl || '').trim();
    if (!raw) return [];

    return raw
      .split(/[\r\n,]+/)
      .map(p => p.trim())
      .filter(p => p.length > 0 && (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('socks5://') || p.startsWith('socks4://')));
  }

  getNextProxy() {
    const list = this.getProxyList();
    if (list.length === 0) return null;

    const now = Date.now();
    // Filter out proxies in cooldown (failed recently)
    const available = list.filter(p => {
      const cooldownUntil = this.failedProxies.get(p) || 0;
      return now > cooldownUntil;
    });

    const candidatePool = available.length > 0 ? available : list;
    this.currentIndex = (this.currentIndex + 1) % candidatePool.length;
    return candidatePool[this.currentIndex];
  }

  markProxyFailed(proxyUrl, cooldownSec = 60) {
    if (!proxyUrl) return;
    this.failedProxies.set(proxyUrl, Date.now() + cooldownSec * 1000);
  }

  markProxyHealthy(proxyUrl) {
    if (!proxyUrl) return;
    this.failedProxies.delete(proxyUrl);
  }

  getStats() {
    const list = this.getProxyList();
    const now = Date.now();
    const active = list.filter(p => (this.failedProxies.get(p) || 0) <= now).length;
    return {
      total: list.length,
      active,
      coolingDown: list.length - active
    };
  }
}

module.exports = new ProxyManager();
