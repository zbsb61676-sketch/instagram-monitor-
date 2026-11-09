const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR: path.join(__dirname, '..', 'data'),
  DOWNLOADS_DIR: path.join(__dirname, '..', 'downloads'),
  CACHE_DIR: path.join(__dirname, '..', 'cache'),
  DB_FILE: path.join(__dirname, '..', 'data', 'db.json'),
  DEFAULT_CHECK_INTERVAL_SEC: 1, // Default interval in seconds (true realtime)
  MIN_CHECK_INTERVAL_SEC: 1,     // Minimum interval (can be set to 1s)
};
