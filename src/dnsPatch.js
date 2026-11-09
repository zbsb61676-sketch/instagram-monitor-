/**
 * Universal High-Reliability DNS Resolver
 * 
 * Bypasses restrictive/unreliable ISP & hotspot DNS gateways (NXDOMAIN on CDN CNAMEs)
 * by routing lookups through Google DNS (8.8.8.8) and Cloudflare DNS (1.1.1.1) over IPv4.
 */

const dns = require('dns');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
} catch (e) {}

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const origLookup = dns.lookup;

dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  // Never intercept localhost or IP addresses
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return origLookup.call(dns, hostname, options, callback);
  }

  dns.resolve4(hostname, (err, addresses) => {
    if (!err && addresses && addresses.length > 0) {
      if (options && options.all) {
        return callback(null, addresses.map(a => ({ address: a, family: 4 })));
      }
      return callback(null, addresses[0], 4);
    }
    origLookup.call(dns, hostname, options, callback);
  });
};

module.exports = { dns };
