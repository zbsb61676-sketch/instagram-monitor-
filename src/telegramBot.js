/**
 * Telegram Bot Interactive Service
 * Allows users to control monitoring, check accounts, download media,
 * and receive live results directly in their Telegram chat via commands and buttons.
 */

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const db = require('./db');
const config = require('./config');
const telegramClient = require('./telegramClient');
const { checkInstagramProfile } = require('./igChecker');
const { downloadTargetContent, fetchActiveStories } = require('./downloader');
const { dispatchTransitionAlert } = require('./notifier');

class TelegramBotService {
  constructor() {
    this.isRunning = false;
    this.pollingAbort = null;
    this.lastUpdateId = 0;
    this.broadcastFn = null;
    this.monitorService = null;
  }

  setBroadcastFunction(fn) {
    this.broadcastFn = fn;
  }

  setMonitorService(monitor) {
    this.monitorService = monitor;
  }

  broadcast(message) {
    if (typeof this.broadcastFn === 'function') {
      try {
        this.broadcastFn(message);
      } catch (e) {}
    }
  }

  async start() {
    const settings = db.getSettings();
    if (!settings.telegramToken) {
      console.log('[TelegramBot] No Telegram token configured in settings. Bot inactive.');
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[TelegramBot] Starting interactive Telegram bot long-polling engine...');

    // Cold-start protection: acknowledge and skip stale commands sent during downtime
    if (this.lastUpdateId === 0) {
      try {
        const warmup = await telegramClient.getJson(settings.telegramToken, 'getUpdates', { offset: -1, limit: 1 }, 10000);
        if (warmup.ok && Array.isArray(warmup.data?.result) && warmup.data.result.length > 0) {
          this.lastUpdateId = warmup.data.result[0].update_id;
          console.log(`[TelegramBot] Synchronized update offset to ${this.lastUpdateId} (stale backlog skipped).`);
        }
      } catch (e) {}
    }

    this.pollLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.pollingAbort) {
      try {
        this.pollingAbort.abort();
      } catch (e) {}
      this.pollingAbort = null;
    }
    console.log('[TelegramBot] Stopped Telegram bot engine.');
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 1000);
  }

  async pollLoop() {
    while (this.isRunning) {
      const settings = db.getSettings();
      const token = settings.telegramToken;
      if (!token) {
        this.isRunning = false;
        break;
      }

      try {
        const queryParams = {
          offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
          timeout: 20,
          allowed_updates: JSON.stringify(['message', 'callback_query'])
        };

        const res = await telegramClient.getJson(token, 'getUpdates', queryParams, 35000);

        if (res.ok && res.data && Array.isArray(res.data.result)) {
          for (const update of res.data.result) {
            if (update.update_id >= this.lastUpdateId) {
              this.lastUpdateId = update.update_id;
            }
            await this.handleUpdate(update, token, settings);
          }
        } else if (res.statusCode === 409) {
          // Another instance is polling; wait 5s
          await new Promise(r => setTimeout(r, 5000));
        } else if (!res.ok) {
          // Wait briefly before retrying
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        // Brief pause before reconnecting on network error
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  /**
   * Handle incoming message or callback button click
   */
  async handleUpdate(update, token, settings) {
    try {
      if (update.message) {
        await this.handleMessage(update.message, token, settings);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query, token, settings);
      }
    } catch (err) {
      console.error('[TelegramBot] Error handling update:', err.message);
    }
  }

  /**
   * Handle incoming text message / command
   */
  async handleMessage(msg, token, settings) {
    const chatId = msg.chat?.id;
    const text = (msg.text || '').trim();
    if (!chatId || !text) return;

    const configuredChatId = String(settings.telegramChatId || '').trim();

    // Auto-pair on /start if no chatId is configured yet
    if (!configuredChatId && text.startsWith('/start')) {
      db.updateSettings({ telegramChatId: String(chatId) });
      db.addLog(`Auto-paired Telegram chat ID: ${chatId}`, 'info');
      settings.telegramChatId = String(chatId);
    }

    // Access control: only permit authorized user
    if (configuredChatId && String(chatId) !== configuredChatId) {
      await this.sendMessage(token, chatId, '🔒 <b>Access Denied:</b> This bot is paired with another user. To pair with this account, enter your Chat ID in the Dashboard settings.');
      return;
    }

    // Command parser
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1] ? parts[1].replace(/^@/, '') : '';
    const arg2 = parts[2];

    if (cmd === '/start' || cmd === '/help') {
      return this.sendHelpMessage(token, chatId);
    }

    if (cmd === '/list' || cmd === '/status' || cmd === '/targets') {
      return this.sendTargetsList(token, chatId);
    }

    if (cmd === '/media' || cmd === '/menu') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/media instagram</code>');
      }
      return this.handleMediaMenuCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/check') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/check instagram</code>');
      }
      return this.handleCheckCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/download' || cmd === '/dl' || cmd === '/posts' || cmd === '/post') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/posts instagram</code>');
      }
      return this.handleDownloadCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/stories' || cmd === '/story') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/stories instagram</code>');
      }
      return this.handleStoriesCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/reels' || cmd === '/reel') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/reels instagram</code>');
      }
      return this.handleReelsCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/zip' || cmd === '/archive') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/zip instagram</code>');
      }
      return this.handleZipCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/avatar' || cmd === '/pfp') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/avatar instagram</code>');
      }
      return this.handleAvatarCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/add') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/add yam.wzzz [seconds]</code>');
      }
      return this.handleAddCommand(token, chatId, arg1, arg2);
    }

    if (cmd === '/remove' || cmd === '/delete' || cmd === '/rm') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/remove yam.wzzz</code>');
      }
      return this.handleRemoveCommand(token, chatId, arg1);
    }

    if (cmd === '/pause' || cmd === '/resume') {
      if (!arg1) {
        return this.sendMessage(token, chatId, `⚠️ Please provide a username:\nUsage: <code>${cmd} yam.wzzz</code>`);
      }
      return this.handleToggleCommand(token, chatId, arg1);
    }

    if (cmd === '/flip' || cmd === '/testflip') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username to test flip:\nUsage: <code>/flip _m_r_aawara__</code>');
      }
      return this.handleFlipCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/stats' || cmd === '/info') {
      return this.sendStatsMessage(token, chatId);
    }

    // Natural text: If user sends an Instagram handle directly (e.g. "@yam.wzzz" or "yam.wzzz")
    const cleanHandle = text.replace(/^@/, '').trim();
    if (/^[a-zA-Z0-9._]{1,30}$/.test(cleanHandle) && !cleanHandle.includes(' ')) {
      return this.handleCheckCommand(token, chatId, cleanHandle, settings);
    }

    // Unknown command
    await this.sendMessage(token, chatId, `❓ Unrecognized command <code>${escapeHtml(text)}</code>\nSend /help to view all available features.`);
  }

  /**
   * Handle interactive button clicks
   */
  async handleCallbackQuery(cb, token, settings) {
    const cbId = cb.id;
    const chatId = cb.message?.chat?.id;
    const data = cb.data || '';

    await this.answerCallbackQuery(token, cbId);
    if (!chatId || !data) return;

    const configuredChatId = String(settings.telegramChatId || '').trim();
    if (configuredChatId && String(chatId) !== configuredChatId) return;

    if (data.startsWith('media:')) {
      const username = data.split(':')[1];
      return this.handleMediaMenuCommand(token, chatId, username, settings);
    }

    if (data.startsWith('check:')) {
      const username = data.split(':')[1];
      return this.handleCheckCommand(token, chatId, username, settings);
    }

    if (data.startsWith('dl:') || data.startsWith('posts:')) {
      const username = data.split(':')[1];
      return this.handleDownloadCommand(token, chatId, username, settings);
    }

    if (data.startsWith('stories:')) {
      const username = data.split(':')[1];
      return this.handleStoriesCommand(token, chatId, username, settings);
    }

    if (data.startsWith('reels:')) {
      const username = data.split(':')[1];
      return this.handleReelsCommand(token, chatId, username, settings);
    }

    if (data.startsWith('zip:')) {
      const username = data.split(':')[1];
      return this.handleZipCommand(token, chatId, username, settings);
    }

    if (data.startsWith('avatar:')) {
      const username = data.split(':')[1];
      return this.handleAvatarCommand(token, chatId, username, settings);
    }

    if (data.startsWith('add:')) {
      const username = data.split(':')[1];
      return this.handleAddCommand(token, chatId, username, 3);
    }

    if (data.startsWith('flip:')) {
      const username = data.split(':')[1];
      return this.handleFlipCommand(token, chatId, username, settings);
    }
  }

  // --- Command Implementations ---

  async sendHelpMessage(token, chatId) {
    const helpText = [
      `🚀 <b>Instagram Privacy & Content Bot</b>`,
      `Control your monitoring server and access all media directly from Telegram!`,
      ``,
      `📂 <b>Media Access & Downloads:</b>`,
      `• <code>/media &lt;username&gt;</code> - Interactive media control center`,
      `• <code>/stories &lt;username&gt;</code> - Play active stories (photos & videos)`,
      `• <code>/reels &lt;username&gt;</code> - Stream & play reels directly in chat`,
      `• <code>/posts &lt;username&gt;</code> - Download posts, carousels & photo albums`,
      `• <code>/zip &lt;username&gt;</code> - Download full media archive as a ZIP file`,
      `• <code>/avatar &lt;username&gt;</code> - Get HD profile picture`,
      ``,
      `🔍 <b>Instant Inspection:</b>`,
      `• <code>/check &lt;username&gt;</code> - Check Public ⇄ Private status & statistics`,
      ``,
      `⚡ <b>Real-Time Monitoring:</b>`,
      `• <code>/add &lt;username&gt; [sec]</code> - Track account in real time`,
      `• <code>/list</code> - View all monitored targets`,
      `• <code>/remove &lt;username&gt;</code> - Remove account from monitor`,
      `• <code>/pause &lt;username&gt;</code> - Pause monitoring`,
      `• <code>/resume &lt;username&gt;</code> - Resume monitoring`,
      ``,
      `🧪 <b>Testing Tools:</b>`,
      `• <code>/flip &lt;username&gt;</code> - Test Public ⇄ Private siren alert with media buttons`,
      `• <code>/stats</code> - Server uptime & statistics`,
      ``,
      `💡 <i>Tip: You can also just type any username (e.g. <code>@yam.wzzz</code>) to inspect it instantly!</i>`
    ].join('\n');

    await this.sendMessage(token, chatId, helpText);
  }

  async sendTargetsList(token, chatId) {
    const targets = db.getTargets();
    if (targets.length === 0) {
      return this.sendMessage(token, chatId, '📭 <b>No accounts currently tracked.</b>\nAdd one using: <code>/add &lt;username&gt;</code>');
    }

    const lines = [
      `📋 <b>Active Monitored Targets (${targets.length}):</b>`,
      ``
    ];

    for (const t of targets) {
      const statusIcon = t.status === 'public' ? '🟢' : (t.status === 'private' ? '🔒' : '⚠️');
      const stateBadge = t.status.toUpperCase();
      const interval = t.intervalSec || 3;
      const pauseIcon = t.isMonitoring ? '' : '⏸️ [PAUSED] ';
      lines.push(`${statusIcon} <b>@${t.username}</b> ${pauseIcon}- <b>${stateBadge}</b> (every ${interval}s)`);
      if (t.profileInfo?.fullName) {
        lines.push(`   └ Name: ${escapeHtml(t.profileInfo.fullName)}`);
      }
    }

    lines.push(``);
    lines.push(`<i>Send /check &lt;username&gt; or /download &lt;username&gt; for actions.</i>`);

    await this.sendMessage(token, chatId, lines.join('\n'));
  }

  async handleCheckCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendChatAction(token, chatId, 'typing');

    try {
      const result = await checkInstagramProfile(clean, {
        sessionCookie: settings.sessionCookie,
        proxyUrl: settings.proxyUrl
      });

      if (result.status === 'not_found') {
        return this.sendMessage(token, chatId, `❌ <b>Account @${clean} not found</b> (HTTP 404 or removed).`);
      }

      if (result.status === 'rate_limited') {
        return this.sendMessage(token, chatId, `⚠️ <b>Rate Limited by Instagram</b> when checking @${clean}. Ensure session cookie is active.`);
      }

      if (result.status === 'error') {
        return this.sendMessage(token, chatId, `⚠️ <b>Error checking @${clean}:</b> ${result.error}`);
      }

      const isPrivate = result.status === 'private';
      const statusBadge = isPrivate ? '🔒 <b>PRIVATE (Locked)</b>' : '🟢 <b>PUBLIC (Unlocked)</b>';
      const info = result.profileInfo || {};

      const lines = [
        `👤 <b>Instagram Profile Info:</b>`,
        ``,
        `Handle: <b>@${clean}</b>${info.isVerified ? ' ✅' : ''}`,
        `Status: ${statusBadge}`,
        info.fullName ? `Name: <b>${escapeHtml(info.fullName)}</b>` : null,
        info.biography ? `Bio: <i>${escapeHtml(info.biography)}</i>` : null,
        ``,
        `📊 <b>Statistics:</b>`,
        `• Followers: <b>${info.followerCount || 'N/A'}</b>`,
        `• Following: <b>${info.followingCount || 'N/A'}</b>`,
        `• Posts: <b>${info.postsCount || '0'}</b>`,
        ``,
        `🔗 <a href="https://www.instagram.com/${clean}/">instagram.com/${clean}</a>`
      ].filter(Boolean).join('\n');

      const buttons = [
        [
          { text: '📂 Media Menu', callback_data: `media:${clean}` },
          { text: '📱 Stories', callback_data: `stories:${clean}` }
        ],
        [
          { text: '🎬 Reels', callback_data: `reels:${clean}` },
          { text: '📸 Posts', callback_data: `posts:${clean}` }
        ],
        [
          { text: '📦 Full ZIP', callback_data: `zip:${clean}` },
          { text: '➕ Add Monitor', callback_data: `add:${clean}` }
        ]
      ];

      if (info.profilePicUrl) {
        await this.sendPhoto(token, chatId, info.profilePicUrl, lines, {
          reply_markup: { inline_keyboard: buttons }
        });
      } else {
        await this.sendMessage(token, chatId, lines, {
          reply_markup: { inline_keyboard: buttons }
        });
      }
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Failed checking @${clean}: ${err.message}`);
    }
  }

  async handleDownloadCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendMessage(token, chatId, `⏳ <b>Fetching media for @${clean}...</b>\nLoading posts, slides and videos directly to chat.`);
    await this.sendChatAction(token, chatId, 'upload_photo');

    try {
      let itemsToSend = db.getDownloadedMedia(clean);
      if (itemsToSend.length === 0) {
        const summary = await downloadTargetContent(clean, {
          sessionCookie: settings.sessionCookie,
          proxyUrl: settings.proxyUrl
        });

        this.broadcast({
          type: 'MEDIA_DOWNLOADED',
          data: { username: clean, summary }
        });

        itemsToSend = summary.downloadedItems || db.getDownloadedMedia(clean);
      }

      if (itemsToSend.length === 0) {
        return this.sendMessage(token, chatId, `ℹ️ No media found on Instagram server for <b>@${clean}</b> (account may have 0 posts or be private).`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📱 Check Stories', callback_data: `stories:${clean}` },
                { text: '🔍 Check Profile', callback_data: `check:${clean}` }
              ]
            ]
          }
        });
      }

      await this.sendMessage(token, chatId, `✅ <b>Media Ready:</b> Found ${itemsToSend.length} media items for <b>@${clean}</b>. Sending albums below...`);
      await this.sendPhotoAlbum(token, chatId, itemsToSend, clean);

      const buttons = [
        [
          { text: '📦 Download Full ZIP Archive', callback_data: `zip:${clean}` }
        ],
        [
          { text: '📱 Active Stories', callback_data: `stories:${clean}` },
          { text: '🎬 Reels & Videos', callback_data: `reels:${clean}` }
        ],
        [
          { text: '📂 Media Menu', callback_data: `media:${clean}` }
        ]
      ];

      await this.sendMessage(token, chatId, `✨ All posts delivered for <b>@${clean}</b>!`, {
        reply_markup: { inline_keyboard: buttons }
      });
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Download failed for @${clean}: ${err.message}`);
    }
  }

  async sendPhotoAlbum(token, chatId, items, username) {
    const validPhotos = [];
    const validVideos = [];

    for (const it of items) {
      const fPath = resolveLocalMediaPath(it, username);
      if (fPath && fs.existsSync(fPath)) {
        const ext = path.extname(fPath).toLowerCase();
        if (ext === '.jpg' || ext === '.png' || ext === '.jpeg' || ext === '.webp') {
          validPhotos.push({
            fullPath: fPath,
            fileName: path.basename(fPath),
            caption: it.caption || ''
          });
        } else if (ext === '.mp4') {
          validVideos.push({
            fullPath: fPath,
            fileName: path.basename(fPath),
            caption: it.caption || ''
          });
        }
      }
    }

    if (validPhotos.length === 0 && validVideos.length === 0) return false;

    // 1. Send photos
    if (validPhotos.length === 1) {
      const p = validPhotos[0];
      await this.sendLocalPhoto(token, chatId, p.fullPath, `📸 <b>@${username}</b>\n${escapeHtml(p.caption)}`);
    } else if (validPhotos.length > 1) {
      // Send up to 20 photos in albums of 10
      for (let i = 0; i < Math.min(validPhotos.length, 20); i += 10) {
        const chunk = validPhotos.slice(i, i + 10);
        const albumCaption = i === 0 ? `📸 <b>@${username}</b> posts (${validPhotos.length} photos)\n🔗 <a href="https://www.instagram.com/${username}/">instagram.com/${username}</a>` : '';
        try {
          await telegramClient.sendMediaGroup(token, chatId, chunk, albumCaption);
        } catch (err) {
          console.error('[TelegramBot] sendMediaGroup error:', err.message);
          for (const p of chunk.slice(0, 3)) {
            await this.sendLocalPhoto(token, chatId, p.fullPath, `📸 <b>@${username}</b>: ${escapeHtml(p.caption)}`);
          }
        }
      }
    }

    // 2. Send video posts if any
    for (const v of validVideos.slice(0, 4)) {
      await this.sendLocalVideo(token, chatId, v.fullPath, `🎬 <b>@${username} Video Post</b>\n${escapeHtml(v.caption || '')}`);
    }

    return true;
  }

  async handleStoriesCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendMessage(token, chatId, `⏳ <b>Checking active stories for @${clean}...</b>\nFetching latest 24h stories directly from Instagram server.`);
    await this.sendChatAction(token, chatId, 'upload_photo');

    try {
      const result = await fetchActiveStories(clean, {
        sessionCookie: settings.sessionCookie,
        proxyUrl: settings.proxyUrl
      });

      let stories = result.items || [];
      if (stories.length === 0) {
        stories = db.getDownloadedMedia(clean).filter(m => m.type?.includes('story'));
      }

      // Resolve valid local files
      const validStories = [];
      const seenPaths = new Set();
      for (const s of stories) {
        const p = resolveLocalMediaPath(s, clean);
        if (p && fs.existsSync(p) && !seenPaths.has(p)) {
          seenPaths.add(p);
          const isVideo = s.type?.includes('video') || p.endsWith('.mp4');
          validStories.push({
            ...s,
            fullPath: p,
            fileName: path.basename(p),
            isVideo
          });
        }
      }

      if (validStories.length === 0) {
        return this.sendMessage(token, chatId, `ℹ️ <b>@${clean}</b> has no active stories currently posted.\n💡 <i>Stories automatically expire after 24 hours. When @${clean} posts a new story, you can access it here immediately!</i>`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🎬 View Reels', callback_data: `reels:${clean}` },
                { text: '📸 View Posts', callback_data: `posts:${clean}` }
              ],
              [
                { text: '📂 Media Menu', callback_data: `media:${clean}` }
              ]
            ]
          }
        });
      }

      const photoStories = validStories.filter(s => !s.isVideo);
      const videoStories = validStories.filter(s => s.isVideo);

      await this.sendMessage(token, chatId, `🎉 Found <b>${validStories.length} active stories</b> for <b>@${clean}</b> (${photoStories.length} photos, ${videoStories.length} playable videos)! Delivering below:`);

      // 1. Send photo stories
      if (photoStories.length > 0) {
        if (photoStories.length === 1) {
          await this.sendLocalPhoto(token, chatId, photoStories[0].fullPath, `📱 Story Photo: <b>@${clean}</b>`);
        } else {
          for (let i = 0; i < photoStories.length; i += 10) {
            const chunk = photoStories.slice(i, i + 10);
            await telegramClient.sendMediaGroup(token, chatId, chunk, `📱 <b>@${clean}</b> active story photos`);
          }
        }
      }

      // 2. Send video stories (MP4 playable inline)
      const maxVideos = Math.min(videoStories.length, 8);
      for (let i = 0; i < maxVideos; i++) {
        const v = videoStories[i];
        const caption = `📱 <b>@${clean} Story Video</b> (${i + 1}/${videoStories.length})\n⏰ ${escapeHtml(v.caption || 'Active Story')}`;
        await this.sendLocalVideo(token, chatId, v.fullPath, caption);
      }

      if (videoStories.length > maxVideos) {
        await this.sendMessage(token, chatId, `ℹ️ <i>Delivered ${maxVideos} of ${videoStories.length} story videos to chat. Tap below to download the full archive with all stories & media!</i>`);
      }

      const bottomButtons = [
        [
          { text: `📦 Download All (${validStories.length}) as ZIP`, callback_data: `zip:${clean}` }
        ],
        [
          { text: '🎬 View Reels', callback_data: `reels:${clean}` },
          { text: '📸 View Posts', callback_data: `posts:${clean}` }
        ],
        [
          { text: '📂 Media Menu', callback_data: `media:${clean}` }
        ]
      ];

      await this.sendMessage(token, chatId, `✨ All stories delivered for <b>@${clean}</b>!`, {
        reply_markup: { inline_keyboard: bottomButtons }
      });
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Failed fetching stories for @${clean}: ${err.message}`);
    }
  }

  async handleReelsCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendMessage(token, chatId, `⏳ <b>Fetching reels & video posts for @${clean}...</b>`);
    await this.sendChatAction(token, chatId, 'upload_video');

    try {
      let allMedia = db.getDownloadedMedia(clean);
      let reels = allMedia.filter(m => m.type === 'video_post' || m.type === 'reel' || (m.fileName && m.fileName.endsWith('.mp4') && !m.type?.includes('story')));

      const postsDir = path.join(config.DOWNLOADS_DIR, clean, 'posts');
      if (fs.existsSync(postsDir)) {
        const mp4Files = fs.readdirSync(postsDir).filter(f => f.endsWith('.mp4'));
        for (const file of mp4Files) {
          const filePath = path.join(postsDir, file);
          if (!reels.some(r => r.fileName === file || r.filePath === filePath)) {
            reels.push({
              type: 'video_post',
              fileName: file,
              filePath,
              caption: `Reel / Video Post (${file})`
            });
          }
        }
      }

      if (reels.length === 0) {
        await this.sendMessage(token, chatId, `🔍 Searching & downloading latest reels for <b>@${clean}</b>...`);
        await downloadTargetContent(clean, {
          sessionCookie: settings.sessionCookie,
          proxyUrl: settings.proxyUrl
        });
        allMedia = db.getDownloadedMedia(clean);
        reels = allMedia.filter(m => m.type === 'video_post' || m.type === 'reel' || (m.fileName && m.fileName.endsWith('.mp4') && !m.type?.includes('story')));
      }

      const validReels = [];
      const seen = new Set();
      for (const r of reels) {
        const p = resolveLocalMediaPath(r, clean);
        if (p && fs.existsSync(p) && !seen.has(p)) {
          seen.add(p);
          validReels.push({ ...r, fullPath: p });
        }
      }

      if (validReels.length === 0) {
        return this.sendMessage(token, chatId, `ℹ️ No playable video reels found for <b>@${clean}</b> (account may only have photo posts or be private).`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📸 View Photos', callback_data: `posts:${clean}` },
                { text: '📱 View Stories', callback_data: `stories:${clean}` }
              ],
              [
                { text: '📂 Media Menu', callback_data: `media:${clean}` }
              ]
            ]
          }
        });
      }

      await this.sendMessage(token, chatId, `🎬 Found <b>${validReels.length} reels/videos</b> for <b>@${clean}</b>! Sending below:`);

      const maxToSend = Math.min(validReels.length, 6);
      for (let i = 0; i < maxToSend; i++) {
        const r = validReels[i];
        const caption = `🎬 <b>@${clean} Reel</b> (${i + 1}/${validReels.length})\n${escapeHtml(r.caption || '')}`;
        await this.sendLocalVideo(token, chatId, r.fullPath, caption);
      }

      const buttons = [
        [
          { text: `📦 Download All (${validReels.length}) as ZIP`, callback_data: `zip:${clean}` }
        ],
        [
          { text: '📸 View Posts', callback_data: `posts:${clean}` },
          { text: '📱 View Stories', callback_data: `stories:${clean}` }
        ],
        [
          { text: '📂 Media Menu', callback_data: `media:${clean}` }
        ]
      ];

      await this.sendMessage(token, chatId, `✨ Reels delivered for <b>@${clean}</b>!`, {
        reply_markup: { inline_keyboard: buttons }
      });
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Failed retrieving reels for @${clean}: ${err.message}`);
    }
  }

  async handleZipCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const userDir = path.join(config.DOWNLOADS_DIR, clean);

    if (!fs.existsSync(userDir) || fs.readdirSync(userDir).length === 0) {
      await this.sendMessage(token, chatId, `⏳ No saved media found for <b>@${clean}</b> yet. Downloading content from Instagram first...`);
      await this.sendChatAction(token, chatId, 'upload_document');
      try {
        await downloadTargetContent(clean, {
          sessionCookie: settings.sessionCookie,
          proxyUrl: settings.proxyUrl
        });
      } catch (e) {}
    }

    if (!fs.existsSync(userDir) || fs.readdirSync(userDir).length === 0) {
      return this.sendMessage(token, chatId, `ℹ️ No downloadable media found for <b>@${clean}</b>.`);
    }

    await this.sendMessage(token, chatId, `⏳ <b>Packaging complete media archive for @${clean}...</b>\nCreating ZIP archive with all posts, stories, reels, highlights and profile avatar...`);
    await this.sendChatAction(token, chatId, 'upload_document');

    let zipPath = null;
    try {
      zipPath = await buildTargetZip(clean);
      if (!zipPath || !fs.existsSync(zipPath)) {
        return this.sendMessage(token, chatId, `❌ Failed to build ZIP archive for @${clean}.`);
      }

      const stat = fs.statSync(zipPath);
      const sizeStr = formatBytes(stat.size);

      // Telegram Bot API document limit is 50MB
      if (stat.size <= 50 * 1024 * 1024) {
        const caption = [
          `📦 <b>@${clean} Instagram Media Archive</b>`,
          `Size: <b>${sizeStr}</b>`,
          `Contains posts, active stories, reels, and HD avatar.`,
          `Delivered via direct IPv4 Telegram Bot.`
        ].join('\n');

        const buttons = [
          [
            { text: '📱 View Stories', callback_data: `stories:${clean}` },
            { text: '🎬 View Reels', callback_data: `reels:${clean}` }
          ],
          [
            { text: '📂 Media Menu', callback_data: `media:${clean}` }
          ]
        ];

        await this.sendDocument(token, chatId, zipPath, caption, {
          reply_markup: { inline_keyboard: buttons }
        });
      } else {
        await this.sendMessage(token, chatId, `📦 <b>Archive Ready (${sizeStr})</b>\n\nNotice: This archive exceeds Telegram's 50MB file size limit for bots.\nYou can download it directly from your web dashboard server at:\n<code>http://localhost:3000/api/download-zip/${clean}</code>`);
      }
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ ZIP generation error: ${err.message}`);
    } finally {
      if (zipPath && fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath);
        } catch (e) {}
      }
    }
  }

  async handleMediaMenuCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendChatAction(token, chatId, 'typing');

    const allMedia = db.getDownloadedMedia(clean);
    const userDir = path.join(config.DOWNLOADS_DIR, clean);

    let storiesCount = allMedia.filter(m => m.type?.includes('story')).length;
    let reelsCount = allMedia.filter(m => m.type === 'video_post' || m.type === 'reel' || (m.fileName && m.fileName.endsWith('.mp4') && !m.type?.includes('story'))).length;
    let postsCount = allMedia.filter(m => m.type === 'carousel_slide' || m.type === 'photo_post').length;
    let highlightsCount = allMedia.filter(m => m.type === 'highlight').length;

    let totalDiskBytes = 0;
    if (fs.existsSync(userDir)) {
      function getDirStats(dir) {
        let size = 0;
        try {
          const files = fs.readdirSync(dir, { withFileTypes: true });
          for (const f of files) {
            const p = path.join(dir, f.name);
            if (f.isDirectory()) size += getDirStats(p);
            else if (f.isFile()) size += fs.statSync(p).size;
          }
        } catch (e) {}
        return size;
      }
      totalDiskBytes = getDirStats(userDir);

      const storiesDir = path.join(userDir, 'stories');
      if (fs.existsSync(storiesDir) && storiesCount === 0) {
        storiesCount = fs.readdirSync(storiesDir).filter(f => !f.includes('_thumb') && (f.endsWith('.jpg') || f.endsWith('.mp4'))).length;
      }
      const postsDir = path.join(userDir, 'posts');
      if (fs.existsSync(postsDir) && postsCount === 0 && reelsCount === 0) {
        const pFiles = fs.readdirSync(postsDir);
        reelsCount = pFiles.filter(f => f.endsWith('.mp4')).length;
        postsCount = pFiles.filter(f => f.endsWith('.jpg') || f.endsWith('.png')).length;
      }
    }

    const totalItems = storiesCount + reelsCount + postsCount + highlightsCount;
    const sizeStr = formatBytes(totalDiskBytes);

    const menuText = [
      `📂 <b>Media Library Hub: @${clean}</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📱 <b>Active Stories:</b> <code>${storiesCount} items</code>`,
      `🎬 <b>Reels & Videos:</b> <code>${reelsCount} items</code>`,
      `📸 <b>Posts & Slides:</b> <code>${postsCount} items</code>`,
      highlightsCount > 0 ? `✨ <b>Highlights:</b> <code>${highlightsCount} items</code>` : null,
      `💾 <b>Total Archive Size:</b> <code>${sizeStr}</code> (${totalItems} files)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `<i>Tap any button below to view, stream, or download directly in Telegram:</i>`
    ].filter(Boolean).join('\n');

    const buttons = [
      [
        { text: `📱 Stories (${storiesCount})`, callback_data: `stories:${clean}` },
        { text: `🎬 Reels (${reelsCount})`, callback_data: `reels:${clean}` }
      ],
      [
        { text: `📸 Posts (${postsCount})`, callback_data: `posts:${clean}` },
        { text: `🖼️ HD Avatar`, callback_data: `avatar:${clean}` }
      ],
      [
        { text: `📦 Download All as ZIP (${sizeStr})`, callback_data: `zip:${clean}` }
      ],
      [
        { text: `🔍 Check Live Status`, callback_data: `check:${clean}` },
        { text: `⚡ Test Siren Alert`, callback_data: `flip:${clean}` }
      ]
    ];

    await this.sendMessage(token, chatId, menuText, {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  async handleAvatarCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendChatAction(token, chatId, 'upload_photo');

    try {
      const result = await checkInstagramProfile(clean, {
        sessionCookie: settings.sessionCookie,
        proxyUrl: settings.proxyUrl
      });

      const avatarUrl = result.profileInfo?.profilePicUrl;
      if (!avatarUrl) {
        return this.sendMessage(token, chatId, `❌ Could not find avatar for @${clean}.`);
      }

      const caption = `🖼️ <b>HD Avatar for @${clean}</b>\n${result.profileInfo?.fullName ? escapeHtml(result.profileInfo.fullName) : ''}`;
      await this.sendPhoto(token, chatId, avatarUrl, caption);
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Avatar lookup failed: ${err.message}`);
    }
  }

  async handleAddCommand(token, chatId, username, intervalSec) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const interval = Math.max(config.MIN_CHECK_INTERVAL_SEC, parseInt(intervalSec, 10) || 3);

    try {
      let target = db.getTarget(clean);
      if (target) {
        return this.sendMessage(token, chatId, `ℹ️ <b>@${clean}</b> is already being monitored (checking every ${target.intervalSec}s).`);
      }

      target = db.addTarget(clean, interval);
      if (this.monitorService) {
        this.monitorService.onTargetAdded(target);
      }
      this.broadcast({ type: 'TARGET_ADDED', data: target });

      await this.sendMessage(
        token,
        chatId,
        `✅ <b>Target Added:</b> Now monitoring <b>@${clean}</b> in real time (every ${interval}s).\nYou will receive instant alerts if privacy flips between Public & Private.`
      );
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Failed adding target: ${err.message}`);
    }
  }

  async handleRemoveCommand(token, chatId, username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const target = db.getTarget(clean);
    if (!target) {
      return this.sendMessage(token, chatId, `ℹ️ <b>@${clean}</b> is not currently in the monitor list.`);
    }

    db.deleteTarget(target.id);
    if (this.monitorService) {
      this.monitorService.onTargetDeleted(target.id);
    }
    this.broadcast({ type: 'TARGET_DELETED', data: { id: target.id } });

    await this.sendMessage(token, chatId, `🗑️ <b>Target Removed:</b> Stopped tracking <b>@${clean}</b>.`);
  }

  async handleToggleCommand(token, chatId, username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const target = db.getTarget(clean);
    if (!target) {
      return this.sendMessage(token, chatId, `ℹ️ <b>@${clean}</b> is not in the monitor list.`);
    }

    const updated = db.toggleTargetMonitoring(target.id);
    if (this.monitorService) {
      this.monitorService.onTargetUpdated(updated);
    }
    this.broadcast({ type: 'TARGET_UPDATED', data: updated });

    const statusText = updated.isMonitoring ? '▶️ <b>RESUMED</b>' : '⏸️ <b>PAUSED</b>';
    await this.sendMessage(token, chatId, `${statusText} monitoring for <b>@${clean}</b>.`);
  }

  async handleFlipCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    let target = db.getTarget(clean);
    if (!target) {
      target = db.addTarget(clean, 3);
      if (this.monitorService) this.monitorService.onTargetAdded(target);
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

    // Trigger alert pipeline
    await dispatchTransitionAlert(
      updated,
      current,
      newStatus,
      settings,
      db,
      (msg) => this.broadcast(msg)
    );

    this.broadcast({ type: 'TARGET_UPDATED', data: updated });

    await this.sendMessage(
      token,
      chatId,
      `⚡ <b>Test Transition Dispatched!</b>\n@${clean}: <b>${current.toUpperCase()}</b> ➔ <b>${newStatus.toUpperCase()}</b>\nAudio siren + alerts fired!`
    );
  }

  async sendStatsMessage(token, chatId) {
    const targets = db.getTargets();
    const settings = db.getSettings();
    const publicCount = targets.filter(t => t.status === 'public').length;
    const privateCount = targets.filter(t => t.status === 'private').length;
    const monitoringCount = targets.filter(t => t.isMonitoring).length;

    const stats = [
      `📊 <b>Instagram Privacy Monitor Statistics</b>`,
      ``,
      `• Total Targets: <b>${targets.length}</b>`,
      `• Active Monitoring: <b>${monitoringCount}</b>`,
      `• Public Accounts: 🟢 <b>${publicCount}</b>`,
      `• Private Accounts: 🔒 <b>${privateCount}</b>`,
      `• Session Cookie: <b>${settings.sessionCookie ? '✅ Active' : '❌ Missing'}</b>`,
      `• Auto-Download: <b>${settings.autoDownloadOnPublic !== false ? '✅ Enabled' : '❌ Disabled'}</b>`,
      `• Server Time: <code>${new Date().toUTCString()}</code>`
    ].join('\n');

    await this.sendMessage(token, chatId, stats);
  }

  // --- Telegram API Helpers (Direct IPv4) ---

  async sendMessage(token, chatId, text, options = {}) {
    try {
      const res = await telegramClient.sendMessage(token, chatId, text, options);
      return res.data;
    } catch (e) {
      console.error('[TelegramBot] sendMessage error:', e.message);
    }
  }

  async sendPhoto(token, chatId, photoUrl, caption = '', options = {}) {
    try {
      const res = await telegramClient.sendPhoto(token, chatId, photoUrl, caption, options);
      return res.data;
    } catch (e) {
      return this.sendMessage(token, chatId, caption);
    }
  }

  async sendLocalPhoto(token, chatId, filePath, caption = '') {
    try {
      const res = await telegramClient.sendPhoto(token, chatId, filePath, caption);
      return res.data;
    } catch (e) {
      console.error('[TelegramBot] sendLocalPhoto error:', e.message);
    }
  }

  async sendLocalVideo(token, chatId, filePath, caption = '') {
    try {
      const res = await telegramClient.sendVideo(token, chatId, filePath, caption);
      return res.data;
    } catch (e) {
      console.error('[TelegramBot] sendLocalVideo error:', e.message);
    }
  }

  async sendDocument(token, chatId, documentPath, caption = '', options = {}) {
    try {
      const res = await telegramClient.sendDocument(token, chatId, documentPath, caption, options);
      return res.data;
    } catch (e) {
      console.error('[TelegramBot] sendDocument error:', e.message);
    }
  }

  async sendChatAction(token, chatId, action = 'typing') {
    try {
      await telegramClient.sendChatAction(token, chatId, action);
    } catch (e) {}
  }

  async answerCallbackQuery(token, callbackQueryId, text = '') {
    try {
      await telegramClient.answerCallbackQuery(token, callbackQueryId, text);
    } catch (e) {}
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function resolveLocalMediaPath(item, defaultUser = '') {
  if (!item) return null;
  if (item.filePath && fs.existsSync(item.filePath)) {
    return item.filePath;
  }
  if (item.fileUrl) {
    const rel = item.fileUrl.replace(/^\/(downloads|cache)\//, '');
    const p1 = path.join(config.DOWNLOADS_DIR, rel);
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(config.CACHE_DIR, rel);
    if (fs.existsSync(p2)) return p2;
  }
  if (item.fileName && defaultUser) {
    const subdirs = ['stories', 'posts', 'profile', 'highlights', ''];
    for (const sub of subdirs) {
      const p = path.join(config.DOWNLOADS_DIR, defaultUser, sub, item.fileName);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function buildTargetZip(username) {
  return new Promise((resolve, reject) => {
    const clean = (username || '').toLowerCase().trim().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
    const targetDir = path.join(config.DOWNLOADS_DIR, clean);
    if (!fs.existsSync(targetDir)) return resolve(null);

    const files = fs.readdirSync(targetDir);
    if (files.length === 0) return resolve(null);

    const tmpDir = path.join(config.DOWNLOADS_DIR, '.tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const zipPath = path.join(tmpDir, `${clean}_instagram_archive_${Date.now()}.zip`);
    const output = fs.createWriteStream(zipPath);

    let archive;
    try {
      if (typeof archiver === 'function') {
        archive = archiver('zip', { store: true });
      } else if (archiver && archiver.ZipArchive) {
        archive = new archiver.ZipArchive({ store: true });
      } else {
        return reject(new Error('Archiver library not loaded'));
      }
    } catch (e) {
      return reject(e);
    }

    output.on('close', () => resolve(zipPath));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.directory(targetDir, false);
    archive.finalize();
  });
}

module.exports = new TelegramBotService();
