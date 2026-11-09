/**
 * Telegram API Client with Strict IPv4 Forcing
 * 
 * Resolves ISP IPv6 black holes on Indian networks (Jio / Airtel)
 * by forcing AF_INET (IPv4) at the socket level.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Reusable IPv4 Agent with Keep-Alive
const ipv4Agent = new https.Agent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 20
});

/**
 * Base HTTP request over pure IPv4
 */
function request(options, postBuffer = null, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'api.telegram.org',
      port: 443,
      method: options.method || 'GET',
      path: options.path,
      headers: options.headers || {},
      agent: ipv4Agent,
      family: 4,
      timeout: timeoutMs
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          const parsed = JSON.parse(raw);
          resolve({
            statusCode: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false,
            data: parsed
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            data: { ok: false, description: raw || `HTTP ${res.statusCode}` }
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Telegram request timed out after ${timeoutMs / 1000}s`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postBuffer) {
      req.write(postBuffer);
    }
    req.end();
  });
}

/**
 * Post JSON payload to Telegram API
 */
async function postJson(token, method, payload, timeoutMs = 20000) {
  const jsonStr = JSON.stringify(payload);
  const buffer = Buffer.from(jsonStr, 'utf-8');

  return request({
    method: 'POST',
    path: `/bot${token}/${method}`,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': buffer.length
    }
  }, buffer, timeoutMs);
}

/**
 * Get request to Telegram API (e.g. getUpdates, getMe)
 */
async function getJson(token, method, queryParams = {}, timeoutMs = 35000) {
  const query = new URLSearchParams(queryParams).toString();
  const pathWithQuery = `/bot${token}/${method}${query ? '?' + query : ''}`;

  return request({
    method: 'GET',
    path: pathWithQuery
  }, null, timeoutMs);
}

/**
 * Build multipart/form-data buffer for file uploads
 */
function buildMultipart(fields, files) {
  const boundary = '----TGClient' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  const parts = [];

  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null) continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
    ));
  }

  for (const [fieldName, file] of Object.entries(files)) {
    if (!file) continue;
    let fileBuffer;
    let filename;
    let mime = file.mime || 'application/octet-stream';

    if (file.path && fs.existsSync(file.path)) {
      fileBuffer = fs.readFileSync(file.path);
      filename = file.filename || path.basename(file.path);
    } else if (file.buffer) {
      fileBuffer = file.buffer;
      filename = file.filename || 'file.bin';
    } else {
      continue;
    }

    if (!mime || mime === 'application/octet-stream') {
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.png') mime = 'image/png';
      else if (ext === '.mp4') mime = 'video/mp4';
      else if (ext === '.webp') mime = 'image/webp';
    }

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    ));
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const bodyBuffer = Buffer.concat(parts);

  return {
    buffer: bodyBuffer,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

/**
 * Post multipart payload to Telegram API
 */
async function postMultipart(token, method, fields, files, timeoutMs = 35000) {
  const { buffer, contentType } = buildMultipart(fields, files);

  return request({
    method: 'POST',
    path: `/bot${token}/${method}`,
    headers: {
      'Content-Type': contentType,
      'Content-Length': buffer.length
    }
  }, buffer, timeoutMs);
}

/**
 * Send a text message
 */
async function sendMessage(token, chatId, text, options = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...options
  };
  return postJson(token, 'sendMessage', payload, 20000);
}

/**
 * Send a single photo (remote URL or local filePath)
 */
async function sendPhoto(token, chatId, photoSource, caption = '', options = {}) {
  const isLocalFile = typeof photoSource === 'string' && fs.existsSync(photoSource);

  if (isLocalFile) {
    const fields = {
      chat_id: String(chatId),
      caption,
      parse_mode: 'HTML',
      ...options
    };
    return postMultipart(token, 'sendPhoto', fields, {
      photo: { path: photoSource }
    }, 30000);
  } else {
    // URL or file_id
    const payload = {
      chat_id: chatId,
      photo: photoSource,
      caption,
      parse_mode: 'HTML',
      ...options
    };
    return postJson(token, 'sendPhoto', payload, 20000);
  }
}

/**
 * Send a single video (remote URL or local filePath)
 */
async function sendVideo(token, chatId, videoSource, caption = '', options = {}) {
  const isLocalFile = typeof photoSource === 'string' && fs.existsSync(videoSource);

  if (isLocalFile) {
    const fields = {
      chat_id: String(chatId),
      caption,
      parse_mode: 'HTML',
      ...options
    };
    return postMultipart(token, 'sendVideo', fields, {
      video: { path: videoSource }
    }, 45000);
  } else {
    const payload = {
      chat_id: chatId,
      video: videoSource,
      caption,
      parse_mode: 'HTML',
      ...options
    };
    return postJson(token, 'sendVideo', payload, 30000);
  }
}

/**
 * Send media group (Photo / Video album)
 * Accepts array of items: { fullPath: string, caption: string, fileName?: string, type?: 'photo'|'video' }
 */
async function sendMediaGroup(token, chatId, items = [], mainCaption = '') {
  if (!items || items.length === 0) return { ok: false, description: 'No items' };

  // Filter only existing local files
  const valid = items.filter(it => it.fullPath && fs.existsSync(it.fullPath)).slice(0, 10);
  if (valid.length === 0) return { ok: false, description: 'No valid local files found' };

  // If only 1 photo, send via sendPhoto
  if (valid.length === 1) {
    const p = valid[0];
    const caption = mainCaption || p.caption || '';
    return sendPhoto(token, chatId, p.fullPath, caption);
  }

  const mediaArray = [];
  const files = {};

  valid.forEach((item, idx) => {
    const fieldName = `media_${idx}`;
    const isVideo = item.type === 'video' || (item.fileName && item.fileName.endsWith('.mp4'));

    mediaArray.push({
      type: isVideo ? 'video' : 'photo',
      media: `attach://${fieldName}`,
      caption: idx === 0 ? (mainCaption || item.caption || '') : '',
      parse_mode: 'HTML'
    });

    files[fieldName] = {
      path: item.fullPath,
      filename: item.fileName || path.basename(item.fullPath)
    };
  });

  const fields = {
    chat_id: String(chatId),
    media: JSON.stringify(mediaArray)
  };

  return postMultipart(token, 'sendMediaGroup', fields, files, 40000);
}

/**
 * Send chat action (e.g. typing, upload_photo, upload_video)
 */
async function sendChatAction(token, chatId, action = 'typing') {
  return postJson(token, 'sendChatAction', { chat_id: chatId, action }, 10000);
}

/**
 * Answer callback query for inline buttons
 */
async function answerCallbackQuery(token, callbackQueryId, text = '') {
  return postJson(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || undefined
  }, 10000);
}

/**
 * Test Telegram Bot connection and send test message
 */
async function testConnection(token, chatId) {
  if (!token || !chatId) {
    return { success: false, error: 'Please enter both Telegram Bot Token and Chat ID' };
  }

  const testMessage = [
    `🔔 <b>Instagram Monitor Test Message</b>`,
    ``,
    `✅ <b>Direct IPv4 Connection:</b> Active & Verified`,
    `Your Telegram notification channel is successfully connected!`,
    `You will receive instant alerts here whenever a monitored account switches from Private to Public.`,
    `Server Time: <code>${new Date().toISOString()}</code>`
  ].join('\n');

  try {
    const res = await sendMessage(token, chatId, testMessage);
    if (!res.ok) {
      const errMsg = res.data?.description || `HTTP ${res.statusCode}`;
      return { success: false, error: errMsg };
    }
    return { success: true, message: 'Telegram test message sent successfully!' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  request,
  postJson,
  getJson,
  postMultipart,
  sendMessage,
  sendPhoto,
  sendVideo,
  sendMediaGroup,
  sendChatAction,
  answerCallbackQuery,
  testConnection
};
