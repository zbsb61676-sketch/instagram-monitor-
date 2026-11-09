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

    if (cmd === '/check') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/check instagram</code>');
      }
      return this.handleCheckCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/download' || cmd === '/dl') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/download instagram</code>');
      }
      return this.handleDownloadCommand(token, chatId, arg1, settings);
    }

    if (cmd === '/stories' || cmd === '/story') {
      if (!arg1) {
        return this.sendMessage(token, chatId, '⚠️ Please provide a username:\nUsage: <code>/stories instagram</code>');
      }
      return this.handleStoriesCommand(token, chatId, arg1, settings);
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

    if (data.startsWith('check:')) {
      const username = data.split(':')[1];
      return this.handleCheckCommand(token, chatId, username, settings);
    }

    if (data.startsWith('dl:')) {
      const username = data.split(':')[1];
      return this.handleDownloadCommand(token, chatId, username, settings);
    }

    if (data.startsWith('stories:')) {
      const username = data.split(':')[1];
      return this.handleStoriesCommand(token, chatId, username, settings);
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
      `Control your monitoring server and request anything directly from Telegram!`,
      ``,
      `🔍 <b>Instant Account Inspection:</b>`,
      `• <code>/check &lt;username&gt;</code> - Check if account is Public or Private`,
      `• <code>/avatar &lt;username&gt;</code> - Get HD profile picture`,
      `• <code>/stories &lt;username&gt;</code> - Fetch & view active stories`,
      ``,
      `📥 <b>Media Downloader:</b>`,
      `• <code>/download &lt;username&gt;</code> - Download posts, reels & send to chat`,
      ``,
      `⚡ <b>Real-Time Monitoring:</b>`,
      `• <code>/add &lt;username&gt; [sec]</code> - Add account to background monitor`,
      `• <code>/list</code> - View all currently tracked targets`,
      `• <code>/remove &lt;username&gt;</code> - Remove account from monitor`,
      `• <code>/pause &lt;username&gt;</code> - Pause monitoring`,
      `• <code>/resume &lt;username&gt;</code> - Resume monitoring`,
      ``,
      `🧪 <b>Testing Tools:</b>`,
      `• <code>/flip &lt;username&gt;</code> - Test Public ⇄ Private transition siren & alert`,
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
          { text: '📥 Download Media', callback_data: `dl:${clean}` },
          { text: '📸 Stories', callback_data: `stories:${clean}` }
        ],
        [
          { text: '➕ Add to Monitor', callback_data: `add:${clean}` },
          { text: '⚡ Test Flip', callback_data: `flip:${clean}` }
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
    await this.sendMessage(token, chatId, `⏳ <b>Downloading content for @${clean}...</b>\nFetching latest posts, avatar & reels fresh from Instagram server.`);
    await this.sendChatAction(token, chatId, 'upload_photo');

    try {
      const summary = await downloadTargetContent(clean, {
        sessionCookie: settings.sessionCookie,
        proxyUrl: settings.proxyUrl
      });

      this.broadcast({
        type: 'MEDIA_DOWNLOADED',
        data: { username: clean, summary }
      });

      let itemsToSend = summary.downloadedItems || [];
      if (itemsToSend.length === 0) {
        itemsToSend = db.getDownloadedMedia(clean);
      }

      if (itemsToSend.length === 0) {
        return this.sendMessage(token, chatId, `ℹ️ No media found on Instagram server for <b>@${clean}</b> (account may have 0 posts or be private).`);
      }

      await this.sendMessage(token, chatId, `✅ <b>Media Ready:</b> Found ${itemsToSend.length} media items for <b>@${clean}</b>. Sending photos to chat below...`);
      await this.sendPhotoAlbum(token, chatId, itemsToSend, clean);
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Download failed for @${clean}: ${err.message}`);
    }
  }

  async sendPhotoAlbum(token, chatId, items, username) {
    const validPhotos = [];
    for (const it of items) {
      const fPath = it.filePath || (it.fileUrl ? path.join(config.DOWNLOADS_DIR, it.fileUrl.replace(/^\/downloads\//, '')) : null);
      if (fPath && fs.existsSync(fPath)) {
        const ext = path.extname(fPath).toLowerCase();
        if (ext === '.jpg' || ext === '.png' || ext === '.jpeg') {
          validPhotos.push({
            fullPath: fPath,
            fileName: path.basename(fPath),
            caption: it.caption || ''
          });
        }
      }
      if (validPhotos.length >= 6) break;
    }

    if (validPhotos.length === 0) return false;

    if (validPhotos.length === 1) {
      const p = validPhotos[0];
      await this.sendLocalPhoto(token, chatId, p.fullPath, `📸 <b>@${username}</b>\n${escapeHtml(p.caption)}`);
      return true;
    }

    // Send album via direct IPv4 telegramClient
    try {
      const albumCaption = `📸 <b>@${username}</b> media album (${validPhotos.length} photos)\n🔗 <a href="https://www.instagram.com/${username}/">instagram.com/${username}</a>`;
      const res = await telegramClient.sendMediaGroup(token, chatId, validPhotos, albumCaption);
      return res.ok;
    } catch (err) {
      console.error('[TelegramBot] sendMediaGroup error:', err.message);
      // Fallback: send single photos
      for (const p of validPhotos.slice(0, 3)) {
        await this.sendLocalPhoto(token, chatId, p.fullPath, `📸 <b>@${username}</b>: ${escapeHtml(p.caption)}`);
      }
      return true;
    }
  }

  async handleStoriesCommand(token, chatId, username, settings) {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    await this.sendMessage(token, chatId, `⏳ Checking active stories for <b>@${clean}</b>...`);
    await this.sendChatAction(token, chatId, 'upload_photo');

    try {
      const result = await fetchActiveStories(clean, {
        sessionCookie: settings.sessionCookie,
        proxyUrl: settings.proxyUrl
      });

      const stories = result.items || [];
      if (stories.length === 0) {
        return this.sendMessage(token, chatId, `ℹ️ <b>@${clean}</b> has no active stories currently posted.`);
      }

      await this.sendMessage(token, chatId, `🎉 Found <b>${stories.length} active stories</b> for <b>@${clean}</b>! Sending below:`);

      for (const s of stories.slice(0, 5)) {
        if (s.filePath && fs.existsSync(s.filePath)) {
          const isVideo = s.type?.includes('video');
          const caption = `📱 Story by <b>@${clean}</b> (${s.caption || 'Active Story'})`;
          if (!isVideo) {
            await this.sendLocalPhoto(token, chatId, s.filePath, caption);
          } else {
            await this.sendLocalVideo(token, chatId, s.filePath, caption);
          }
        }
      }
    } catch (err) {
      await this.sendMessage(token, chatId, `❌ Failed fetching stories for @${clean}: ${err.message}`);
    }
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

module.exports = new TelegramBotService();
