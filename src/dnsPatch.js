/**
 * Universal High-Reliability DNS Resolver Configuration
 * 
 * Sets Node.js DNS result order to 'ipv4first'.
 * On local Windows development environments, provides fallback to public DNS.
 * On cloud container environments (Render, Linux, Docker, Heroku), preserves the container's
 * internal managed DNS resolver (/etc/resolv.conf) to prevent firewall connection drops.
 */

const dns = require('dns');

if (typeof dns.setDefaultResultOrder === 'function') {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch (e) {}
}

const isCloudOrLinux = Boolean(
  process.env.RENDER ||
  process.env.NODE_ENV === 'production' ||
  process.platform === 'linux' ||
  (process.env.PORT && !process.env.USERPROFILE)
);

if (!isCloudOrLinux) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']);
  } catch (e) {}
}

module.exports = { dns };
