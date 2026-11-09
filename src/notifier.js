/**
 * Notifier module for Telegram Bot & Discord Webhooks
 */

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const fs = require('fs');
const path = require('path');
const config = require('./config');
const telegramClient = require('./telegramClient');

/**
 * Send an alert message to a Telegram chat via Bot API
 */
async function sendTelegramAlert({ username, previousStatus, currentStatus, profileInfo, token, chatId }) {
  if (!token || !chatId) {
    return { success: false, error: 'Telegram Bot Token or Chat ID not configured' };
  }

  const profileUrl = `https://www.instagram.com/${username}/`;
  const nameDisplay = profileInfo?.fullName ? ` (${profileInfo.fullName})` : '';
  const verifiedBadge = profileInfo?.isVerified ? ' ✅' : '';
  const isNowPrivate = currentStatus === 'private';

  const alertHeader = isNowPrivate
    ? `🔒 <b>INSTAGRAM PRIVACY ALERT: ACCOUNT IS NOW PRIVATE!</b>`
    : `🚨 <b>INSTAGRAM STATUS ALERT: ACCOUNT IS NOW PUBLIC!</b>`;

  const previousBadge = previousStatus === 'public' ? '🟢 PUBLIC' : (previousStatus === 'private' ? '🔒 PRIVATE' : (previousStatus || 'UNKNOWN').toUpperCase());
  const currentBadge = isNowPrivate ? '🔒 PRIVATE (Locked)' : '🟢 PUBLIC (Unlocked)';

  const message = [
    alertHeader,
    ``,
    `Target: <b>@${username}</b>${nameDisplay}${verifiedBadge}`,
    `Previous State: <b>${previousBadge}</b>`,
    `Current State: <b>${currentBadge}</b>`,
    `Time: <code>${new Date().toUTCString()}</code>`,
    ``,
    isNowPrivate
      ? `⚠️ <i>Target account has locked their profile (switched to PRIVATE). Posts, reels, and stories are no longer visible without following.</i>`
      : `🎉 <i>Target account has unlocked their profile (switched to PUBLIC)! Content archiving has automatically started.</i>`,
    ``,
    `🔗 <a href="${profileUrl}">Open Profile: instagram.com/${username}</a>`
  ].join('\n');

  try {
    const res = await telegramClient.sendMessage(token, chatId, message);
    if (!res.ok) {
      throw new Error(res.data?.description || `HTTP ${res.statusCode}`);
    }
    return { success: true, response: res.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send test alert to Telegram
 */
async function testTelegram(token, chatId) {
  return telegramClient.testConnection(token, chatId);
}

/**
 * Send an alert embed to Discord via Webhook
 */
async function sendDiscordAlert({ username, previousStatus, currentStatus, profileInfo, webhookUrl }) {
  if (!webhookUrl) {
    return { success: false, error: 'Discord Webhook URL not configured' };
  }

  const profileUrl = `https://www.instagram.com/${username}/`;
  const nameDisplay = profileInfo?.fullName ? ` (${profileInfo.fullName})` : '';
  const isNowPrivate = currentStatus === 'private';
  const embedColor = isNowPrivate ? 15105570 : 5763719; // Amber #E67E22 vs Emerald Green #57F287

  const previousBadge = previousStatus === 'public' ? '🟢 PUBLIC' : (previousStatus === 'private' ? '🔒 PRIVATE' : (previousStatus || 'UNKNOWN').toUpperCase());
  const currentBadge = isNowPrivate ? '🔒 PRIVATE (Locked)' : '🟢 PUBLIC (Unlocked)';

  const embed = {
    title: isNowPrivate ? `🔒 @${username} is now PRIVATE!` : `🚨 @${username} is now PUBLIC!`,
    description: isNowPrivate
      ? `Monitored account **@${username}**${nameDisplay} just switched from **PUBLIC** to **PRIVATE** (account locked).`
      : `Monitored account **@${username}**${nameDisplay} changed privacy status to **PUBLIC** (account unlocked).`,
    url: profileUrl,
    color: embedColor,
    fields: [
      { name: 'Target Account', value: `[@${username}](${profileUrl})`, inline: true },
      { name: 'Previous State', value: previousBadge, inline: true },
      { name: 'New State', value: currentBadge, inline: true },
      { name: 'Detected At', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false }
    ],
    footer: {
      text: 'Instagram Privacy Monitor • Instant Alert System'
    },
    timestamp: new Date().toISOString()
  };

  if (profileInfo?.profilePicUrl) {
    embed.thumbnail = { url: profileInfo.profilePicUrl };
  }

  const payload = {
    content: isNowPrivate
      ? `⚠️ **Instagram Privacy Alert:** **@${username}** just switched to **PRIVATE**!`
      : `@everyone 🚨 **Instagram Privacy Alert:** **@${username}** just switched to **PUBLIC**!`,
    embeds: [embed]
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send test alert to Discord Webhook
 */
async function testDiscord(webhookUrl) {
  if (!webhookUrl) {
    return { success: false, error: 'Please enter a Discord Webhook URL' };
  }

  const payload = {
    content: '🔔 **Instagram Privacy Monitor - Test Alert**',
    embeds: [
      {
        title: '✅ Discord Webhook Connected Successfully',
        description: 'You will receive instant alerts here whenever a monitored Instagram account turns public.',
        color: 3447003, // Blue
        fields: [
          { name: 'Status', value: 'Active & Listening', inline: true },
          { name: 'System Time', value: new Date().toISOString(), inline: true }
        ],
        footer: {
          text: 'Instagram Privacy Monitor'
        }
      }
    ]
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return { success: true, message: 'Discord test message sent successfully!' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Trigger all configured alert dispatchers
 */
async function dispatchTransitionAlert(target, previousStatus, currentStatus, settings, db, broadcastFn) {
  const alertInfo = {
    username: target.username,
    previousStatus,
    currentStatus,
    profileInfo: target.profileInfo
  };

  const results = {
    telegram: null,
    discord: null
  };

  db.addLog(
    `🚨 STATUS CHANGE TRIGGERED for @${target.username}: ${previousStatus} ➔ ${currentStatus}!`,
    'alert',
    target.username
  );

  // Broadcast high-priority alert to WebSocket UI
  if (broadcastFn) {
    broadcastFn({
      type: 'ALERT',
      data: {
        username: target.username,
        previousStatus,
        currentStatus,
        profileInfo: target.profileInfo,
        timestamp: new Date().toISOString()
      }
    });
  }

  // 1. Telegram
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      const tgRes = await sendTelegramAlert({
        ...alertInfo,
        token: settings.telegramToken,
        chatId: settings.telegramChatId
      });
      results.telegram = tgRes;
      if (tgRes.success) {
        db.addLog(`Telegram alert sent for @${target.username}`, 'success', target.username);
      } else {
        db.addLog(`Telegram alert failed: ${tgRes.error}`, 'error', target.username);
      }
    } catch (e) {
      db.addLog(`Telegram error: ${e.message}`, 'error', target.username);
    }
  }

  // 2. Discord
  if (settings.discordWebhookUrl) {
    try {
      const dcRes = await sendDiscordAlert({
        ...alertInfo,
        webhookUrl: settings.discordWebhookUrl
      });
      results.discord = dcRes;
      if (dcRes.success) {
        db.addLog(`Discord webhook alert sent for @${target.username}`, 'success', target.username);
      } else {
        db.addLog(`Discord webhook failed: ${dcRes.error}`, 'error', target.username);
      }
    } catch (e) {
      db.addLog(`Discord error: ${e.message}`, 'error', target.username);
    }
  }

  return results;
}

/**
 * Send downloaded photos directly to Telegram as photo or media group
 */
async function sendTelegramMediaPhotos({ username, items, token, chatId }) {
  if (!token || !chatId || !items || items.length === 0) return { success: false };

  // Filter valid local files (up to 3 photos)
  const validPhotos = [];
  for (const item of items) {
    if (item.fileUrl) {
      // Resolve local path from fileUrl (/downloads/username/posts/xxx.jpg)
      const relPath = item.fileUrl.replace(/^\/downloads\//, '');
      const fullPath = path.join(config.DOWNLOADS_DIR, relPath);
      if (fs.existsSync(fullPath) && (fullPath.endsWith('.jpg') || fullPath.endsWith('.png') || fullPath.endsWith('.jpeg'))) {
        validPhotos.push({
          fullPath,
          caption: item.caption || '',
          fileName: path.basename(fullPath)
        });
      }
    }
    if (validPhotos.length >= 3) break;
  }

  if (validPhotos.length === 0) return { success: false, error: 'No image files available to send' };

  try {
    if (validPhotos.length === 1) {
      const photo = validPhotos[0];
      const captionText = `📸 <b>@${username}</b> latest post:\n\n${photo.caption ? photo.caption.slice(0, 300) : 'New public post'}\n\n🔗 <a href="https://www.instagram.com/${username}/">View on Instagram</a>`;
      const res = await telegramClient.sendPhoto(token, chatId, photo.fullPath, captionText);
      return { success: res.ok, data: res.data };
    } else {
      const albumCaption = `📸 <b>@${username}</b> latest media album (${validPhotos.length} photos)\n🔗 <a href="https://www.instagram.com/${username}/">instagram.com/${username}</a>`;
      const res = await telegramClient.sendMediaGroup(token, chatId, validPhotos, albumCaption);
      return { success: res.ok, data: res.data };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send downloaded photo attachment directly to Discord Webhook
 */
async function sendDiscordMediaPhotos({ username, items, webhookUrl }) {
  if (!webhookUrl || !items || items.length === 0) return { success: false };

  // Find first valid image file
  let validPhoto = null;
  for (const item of items) {
    if (item.fileUrl) {
      const relPath = item.fileUrl.replace(/^\/downloads\//, '');
      const fullPath = path.join(config.DOWNLOADS_DIR, relPath);
      if (fs.existsSync(fullPath) && (fullPath.endsWith('.jpg') || fullPath.endsWith('.png') || fullPath.endsWith('.jpeg'))) {
        validPhoto = {
          fullPath,
          caption: item.caption || '',
          fileName: path.basename(fullPath)
        };
        break;
      }
    }
  }

  if (!validPhoto) return { success: false, error: 'No image file found' };

  try {
    const formData = new FormData();
    const payload = {
      content: `📸 **@${username}** just switched to **PUBLIC**! Here is the latest post:`,
      embeds: [
        {
          title: `Latest Post from @${username}`,
          url: `https://www.instagram.com/${username}/`,
          description: validPhoto.caption ? validPhoto.caption.slice(0, 400) : 'Archived latest post.',
          color: 5763719,
          image: { url: `attachment://${validPhoto.fileName}` },
          footer: { text: 'IG Radar • Auto-Media Archive' },
          timestamp: new Date().toISOString()
        }
      ]
    };

    formData.append('payload_json', JSON.stringify(payload));
    const fileBytes = fs.readFileSync(validPhoto.fullPath);
    formData.append('files[0]', new Blob([fileBytes], { type: 'image/jpeg' }), validPhoto.fileName);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(15000)
    });

    return { success: res.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Dispatches downloaded media photos to Telegram and Discord
 */
async function dispatchMediaDownloadedAlert(username, items, settings, db) {
  if (!items || items.length === 0) return;

  // 1. Telegram Photo
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      const tgRes = await sendTelegramMediaPhotos({
        username,
        items,
        token: settings.telegramToken,
        chatId: settings.telegramChatId
      });
      if (tgRes.success) {
        db.addLog(`Sent latest photos directly to Telegram for @${username}`, 'success', username);
      }
    } catch (e) {
      // non-fatal
    }
  }

  // 2. Discord Photo
  if (settings.discordWebhookUrl) {
    try {
      const dcRes = await sendDiscordMediaPhotos({
        username,
        items,
        webhookUrl: settings.discordWebhookUrl
      });
      if (dcRes.success) {
        db.addLog(`Sent latest photo directly to Discord for @${username}`, 'success', username);
      }
    } catch (e) {
      // non-fatal
    }
  }
}

/**
 * Dispatches target activity alerts (New Post, New Story, Bio Change)
 */
async function dispatchActivityAlert(type, data, settings, db, broadcastFn) {
  const { username, postCode, oldBio, newBio } = data;
  let title = '';
  let telegramMsg = '';
  let discordDesc = '';
  let targetUrl = `https://www.instagram.com/${username}/`;

  if (type === 'NEW_POST') {
    title = `📸 NEW INSTAGRAM POST`;
    targetUrl = postCode ? `https://www.instagram.com/p/${postCode}/` : targetUrl;
    telegramMsg = [
      `📸 <b>NEW POST PUBLISHED by @${username}</b>`,
      ``,
      `Target has just uploaded a brand new post!`,
      postCode ? `Post Code: <code>${postCode}</code>` : '',
      `Time: <code>${new Date().toUTCString()}</code>`,
      ``,
      `🔗 <a href="${targetUrl}">View Post on Instagram</a>`
    ].filter(Boolean).join('\n');
    discordDesc = `Target **@${username}** just published a brand new post!\n[View Post on Instagram](${targetUrl})`;
  } else if (type === 'NEW_STORY') {
    title = `⏳ NEW INSTAGRAM STORY`;
    targetUrl = `https://www.instagram.com/stories/${username}/`;
    telegramMsg = [
      `⏳ <b>NEW STORY POSTED by @${username}</b>`,
      ``,
      `Target has just posted a new active story!`,
      `Time: <code>${new Date().toUTCString()}</code>`,
      ``,
      `🔗 <a href="${targetUrl}">Watch Story on Instagram</a>`
    ].join('\n');
    discordDesc = `Target **@${username}** just posted an active story!\n[Watch Story on Instagram](${targetUrl})`;
  } else if (type === 'BIO_CHANGED') {
    title = `📝 BIO UPDATED`;
    telegramMsg = [
      `📝 <b>BIO UPDATED for @${username}</b>`,
      ``,
      `Old Bio:\n<i>${oldBio || '(none)'}</i>`,
      ``,
      `New Bio:\n<b>${newBio || '(none)'}</b>`,
      ``,
      `🔗 <a href="${targetUrl}">Open Profile</a>`
    ].join('\n');
    discordDesc = `Target **@${username}** updated their Instagram biography.\n**New Bio:** ${newBio || '(empty)'}`;
  }

  db.addLog(`${title} detected for @${username}`, 'alert', username);

  if (broadcastFn) {
    broadcastFn({
      type: 'ACTIVITY_ALERT',
      data: {
        activityType: type,
        username,
        title,
        timestamp: new Date().toISOString()
      }
    });
  }

  // 1. Telegram
  if (settings.telegramToken && settings.telegramChatId) {
    try {
      await telegramClient.sendMessage(settings.telegramToken, settings.telegramChatId, telegramMsg);
      db.addLog(`Sent ${type} alert to Telegram for @${username}`, 'success', username);
    } catch (e) {
      // non-fatal
    }
  }

  // 2. Discord
  if (settings.discordWebhookUrl) {
    try {
      await fetch(settings.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🔔 **${title}:** **@${username}**`,
          embeds: [{
            title: `${title} • @${username}`,
            description: discordDesc,
            url: targetUrl,
            color: type === 'NEW_POST' ? 3447003 : (type === 'NEW_STORY' ? 10181046 : 15844367),
            timestamp: new Date().toISOString(),
            footer: { text: 'IG Radar • Realtime Activity Monitor' }
          }]
        }),
        signal: AbortSignal.timeout(20000)
      });
      db.addLog(`Sent ${type} alert to Discord for @${username}`, 'success', username);
    } catch (e) {
      // non-fatal
    }
  }
}

module.exports = {
  sendTelegramAlert,
  testTelegram,
  sendDiscordAlert,
  testDiscord,
  dispatchTransitionAlert,
  sendTelegramMediaPhotos,
  sendDiscordMediaPhotos,
  dispatchMediaDownloadedAlert,
  dispatchActivityAlert
};
