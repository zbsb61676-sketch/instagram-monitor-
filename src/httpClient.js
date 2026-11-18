/**
 * Unified HTTP Fetch Client with Safe Keep-Alive Pooling & Proxy Support
 *
 * Always pairs undici's Agent / ProxyAgent with undici.fetch from the exact
 * same module instance to prevent cross-version dispatcher errors across
 * Node.js 18, 20, 22, and 26.
 */

const proxyManager = require('./proxyManager');

let undiciModule = null;
let keepAliveAgent = null;
const proxyAgentCache = new Map();

try {
  undiciModule = require('undici');
  if (typeof undiciModule.Agent === 'function') {
    keepAliveAgent = new undiciModule.Agent({
      connections: 16,
      keepAliveTimeout: 15000,
      keepAliveMaxTimeout: 60000,
      pipelining: 1
    });
  }
} catch (e) {
  undiciModule = null;
}

function getProxyAgent(proxyUrl) {
  if (!proxyUrl || !undiciModule || typeof undiciModule.ProxyAgent !== 'function') {
    return null;
  }
  if (!proxyAgentCache.has(proxyUrl)) {
    try {
      proxyAgentCache.set(proxyUrl, new undiciModule.ProxyAgent(proxyUrl));
    } catch (e) {
      return null;
    }
  }
  return proxyAgentCache.get(proxyUrl);
}

/**
 * Perform an HTTP fetch using undici.fetch when a keep-alive Agent or ProxyAgent
 * dispatcher is attached, falling back cleanly to globalThis.fetch otherwise.
 */
async function httpFetch(url, options = {}, { proxyUrl = null, useKeepAlive = false } = {}) {
  const fetchOptions = { ...options };
  const activeProxy = proxyManager.getNextProxy(proxyUrl);

  if (undiciModule && typeof undiciModule.fetch === 'function') {
    if (activeProxy) {
      const agent = getProxyAgent(activeProxy);
      if (agent) {
        fetchOptions.dispatcher = agent;
      }
    } else if (useKeepAlive && keepAliveAgent) {
      fetchOptions.dispatcher = keepAliveAgent;
    }
    return {
      response: await undiciModule.fetch(url, fetchOptions),
      activeProxy
    };
  }

  return {
    response: await globalThis.fetch(url, fetchOptions),
    activeProxy
  };
}

module.exports = {
  httpFetch,
  getProxyAgent
};
