const path = require('path');

function parsePositiveInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = {
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR: path.join(__dirname, '..', 'data'),
  DOWNLOADS_DIR: path.join(__dirname, '..', 'downloads'),
  CACHE_DIR: path.join(__dirname, '..', 'cache'),
  DB_FILE: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json'),
  DB_BACKUP_FILE: (process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json')) + '.bak',
  DEFAULT_CHECK_INTERVAL_SEC: 1, // Default interval in seconds (true realtime)
  MIN_CHECK_INTERVAL_SEC: 1,     // Minimum interval (can be set to 1s)
  MAX_CONCURRENT_CHECKS: parsePositiveInt(process.env.MAX_CONCURRENT_CHECKS, 3),
  DOWNLOAD_CONCURRENCY: parsePositiveInt(process.env.DOWNLOAD_CONCURRENCY, 6),
  METADATA_CONCURRENCY: parsePositiveInt(process.env.METADATA_CONCURRENCY, 3),
  CIRCUIT_BREAKER_THRESHOLD: parsePositiveInt(process.env.CIRCUIT_BREAKER_THRESHOLD, 5),
  CIRCUIT_BREAKER_COOLDOWN_MS: parsePositiveInt(process.env.CIRCUIT_BREAKER_COOLDOWN_SEC, 60) * 1000,
  ALERT_MAX_RETRIES: parsePositiveInt(process.env.ALERT_MAX_RETRIES, 3),
  MAX_STORAGE_MB: parsePositiveInt(process.env.MAX_STORAGE_MB, 500),
  MAX_CACHE_AGE_MS: parsePositiveInt(process.env.MAX_CACHE_AGE_MIN, 30) * 60 * 1000,
  DASHBOARD_PASSWORD: (process.env.DASHBOARD_PASSWORD || '').trim()
};
