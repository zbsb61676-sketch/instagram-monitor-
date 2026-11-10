/**
 * IG Radar - Realtime Instagram Privacy Monitor Frontend App
 */

// Global State
const state = {
  targets: [],
  settings: {},
  logs: [],
  wsConnected: false,
  soundEnabled: true
};

// Web Audio API Sound Synthesizer (No external mp3 required)
class SoundEffects {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.ctx = new AudioContext();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playAlert() {
    if (!state.soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      // Play 3 rapid urgent alert beeps
      const freqs = [880, 1174.66, 1760]; // A5, D6, A6

      freqs.forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.15);

        gain.gain.setValueAtTime(0.3, now + idx * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.15 + 0.18);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now + idx * 0.15);
        osc.stop(now + idx * 0.15 + 0.2);
      });
    } catch (e) {
      console.warn('Audio playback failed:', e);
    }
  }

  playBeep() {
    if (!state.soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.1);
    } catch (e) {
      // ignore
    }
  }
}

const sounds = new SoundEffects();

// DOM Elements
const connectionBadge = document.getElementById('connectionStatusBadge');
const connectionText = document.getElementById('connectionStatusText');
const soundToggleBtn = document.getElementById('soundToggleBtn');
const soundIcon = document.getElementById('soundIcon');
const testAudioBtn = document.getElementById('testAudioBtn');

const statTotal = document.getElementById('statTotal');
const statActive = document.getElementById('statActive');
const statPrivate = document.getElementById('statPrivate');
const statPublic = document.getElementById('statPublic');
const targetCountBadge = document.getElementById('targetCountBadge');

const addTargetForm = document.getElementById('addTargetForm');
const targetUsernameInput = document.getElementById('targetUsername');
const targetIntervalInput = document.getElementById('targetInterval');
const addTargetBtn = document.getElementById('addTargetBtn');

const targetsGrid = document.getElementById('targetsGrid');
const noTargetsPlaceholder = document.getElementById('noTargetsPlaceholder');

const logsContainer = document.getElementById('logsContainer');
const clearLogsBtn = document.getElementById('clearLogsBtn');

const settingsModal = document.getElementById('settingsModal');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
const settingsForm = document.getElementById('settingsForm');

const cfgTelegramToken = document.getElementById('cfgTelegramToken');
const cfgTelegramChatId = document.getElementById('cfgTelegramChatId');
const cfgDiscordWebhook = document.getElementById('cfgDiscordWebhook');
const cfgProxyUrl = document.getElementById('cfgProxyUrl');
const cfgSessionCookie = document.getElementById('cfgSessionCookie');
const cfgAutoDownload = document.getElementById('cfgAutoDownload');
const cfgAppUrl = document.getElementById('cfgAppUrl');
const testKeepAliveBtn = document.getElementById('testKeepAliveBtn');
const keepAliveBadge = document.getElementById('keepAliveBadge');
const keepAliveFeedback = document.getElementById('keepAliveFeedback');

// Gallery Modal Elements
const mediaGalleryModal = document.getElementById('mediaGalleryModal');
const closeGalleryBtn = document.getElementById('closeGalleryBtn');
const closeGalleryBottomBtn = document.getElementById('closeGalleryBottomBtn');
const refreshGalleryBtn = document.getElementById('refreshGalleryBtn');
let currentGalleryTarget = null;

// Live Downloader Elements
const liveDownloadForm = document.getElementById('liveDownloadForm');
const liveDownloadUsername = document.getElementById('liveDownloadUsername');
const startLiveDownloadBtn = document.getElementById('startLiveDownloadBtn');
const liveDownloadStatusBox = document.getElementById('liveDownloadStatusBox');
const liveStatusText = document.getElementById('liveStatusText');
const liveItemCounter = document.getElementById('liveItemCounter');
const livePulseIndicator = document.getElementById('livePulseIndicator');
const liveDownloadZipBtn = document.getElementById('liveDownloadZipBtn');
const downloadSelectedZipBtn = document.getElementById('downloadSelectedZipBtn');
const downloadSelectedText = document.getElementById('downloadSelectedText');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const selectionSummaryText = document.getElementById('selectionSummaryText');
const liveMediaStreamGrid = document.getElementById('liveMediaStreamGrid');
const sessionDot = document.getElementById('sessionDot');
const sessionStatusText = document.getElementById('sessionStatusText');

// Cache State
let activeCacheUsername = '';
let cachedMediaItems = [];
let selectedMediaIds = new Set();

const testTelegramBtn = document.getElementById('testTelegramBtn');
const telegramFeedback = document.getElementById('telegramFeedback');
const testDiscordBtn = document.getElementById('testDiscordBtn');
const discordFeedback = document.getElementById('discordFeedback');

const transitionAlertBanner = document.getElementById('transitionAlertBanner');
const transitionAlertDetails = document.getElementById('transitionAlertDetails');
const transitionAlertLink = document.getElementById('transitionAlertLink');
const dismissAlertBtn = document.getElementById('dismissAlertBtn');

// --- WebSocket Connection ---
let socket = null;
let reconnectTimer = null;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    state.wsConnected = true;
    updateConnectionBadge(true);
    clearTimeout(reconnectTimer);
    if (activeCacheUsername) {
      notifyViewingCache(activeCacheUsername);
    }
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleSocketMessage(msg);
    } catch (e) {
      console.error('Socket message parse error:', e);
    }
  };

  socket.onclose = () => {
    state.wsConnected = false;
    updateConnectionBadge(false);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  socket.onerror = () => {
    state.wsConnected = false;
    updateConnectionBadge(false);
  };
}

function updateConnectionBadge(connected) {
  if (connected) {
    connectionBadge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
    connectionText.textContent = 'Live Connected';
  } else {
    connectionBadge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20';
    connectionText.textContent = 'Reconnecting...';
  }
}

function handleSocketMessage(msg) {
  switch (msg.type) {
    case 'INIT':
      state.targets = msg.data.targets || [];
      state.settings = msg.data.settings || {};
      state.logs = msg.data.logs || [];
      renderAll();
      break;

    case 'TARGET_ADDED':
      state.targets.push(msg.data);
      renderTargets();
      renderStats();
      showToast(`Added @${msg.data.username} to monitoring`, 'success');
      break;

    case 'TARGET_UPDATED':
      {
        const idx = state.targets.findIndex(t => t.id === msg.data.id);
        if (idx !== -1) {
          state.targets[idx] = {
            ...state.targets[idx],
            ...msg.data,
            downloadedCount: msg.data.downloadedCount !== undefined ? msg.data.downloadedCount : state.targets[idx].downloadedCount,
            recentMedia: (msg.data.recentMedia && msg.data.recentMedia.length > 0) ? msg.data.recentMedia : state.targets[idx].recentMedia
          };
        } else {
          state.targets.push(msg.data);
        }
        renderTargets();
        renderStats();
      }
      break;

    case 'TARGET_DELETED':
      state.targets = state.targets.filter(t => t.id !== msg.data.id);
      renderTargets();
      renderStats();
      break;

    case 'LOG_ADDED':
      appendLog(msg.data);
      break;

    case 'LOGS_CLEARED':
      state.logs = [];
      logsContainer.innerHTML = '<p class="text-gray-500 italic">No activity logs recorded yet.</p>';
      break;

    case 'SETTINGS_UPDATED':
      state.settings = { ...state.settings, ...msg.data };
      showToast('Settings saved successfully', 'success');
      break;

    case 'MEDIA_DOWNLOADED':
      {
        const tgt = state.targets.find(t => t.username === msg.data.username || t.id === msg.data.targetId);
        if (tgt) {
          tgt.downloadedCount = msg.data.totalDownloaded || ((tgt.downloadedCount || 0) + (msg.data.summary?.newlyDownloaded || 0));
          renderTargets();
        }
        const newly = msg.data.summary?.newlyDownloaded || 0;
        const skipped = msg.data.summary?.skipped || 0;
        showToast(`📥 @${msg.data.username}: Downloaded ${newly} new items (${skipped} duplicates skipped)`, 'success');
      }
      break;

    case 'ALERT':
      handleTransitionAlert(msg.data);
      break;

    case 'LIVE_DOWNLOAD_STARTED':
      activeCacheUsername = msg.data.username;
      cachedMediaItems = [];
      selectedMediaIds.clear();
      updateSelectionUI();
      if (liveDownloadStatusBox) {
        liveDownloadStatusBox.classList.remove('hidden');
        liveMediaStreamGrid.innerHTML = '';
        liveStatusText.textContent = `Extracting & downloading @${msg.data.username} into cache...`;
        liveItemCounter.textContent = '0 items';
        if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
      }
      break;

    case 'LIVE_ITEM_DOWNLOADED':
      appendLiveMediaCard(msg.data);
      break;

    case 'LIVE_DOWNLOAD_COMPLETED':
      if (liveDownloadStatusBox) {
        liveStatusText.textContent = `✅ Ready: ${msg.data.totalItems} items cached for @${msg.data.username}`;
        liveItemCounter.textContent = `${msg.data.totalItems} items`;
        if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
      }
      showToast(`✅ Profile @${msg.data.username} cached! Select items below to download.`, 'success');
      break;

    case 'LIVE_DOWNLOAD_FAILED':
      if (liveStatusText) {
        liveStatusText.textContent = `❌ Error: ${msg.data.error}`;
      }
      if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
      showToast(`Download failed: ${msg.data.error}`, 'error');
      break;

    case 'CACHE_ITEM_DELETED':
      if (msg.data && msg.data.itemId) {
        removeCachedCardFromGrid(msg.data.itemId);
      }
      break;

    case 'CACHE_ITEMS_DELETED':
      if (msg.data && Array.isArray(msg.data.itemIds)) {
        msg.data.itemIds.forEach(id => removeCachedCardFromGrid(id));
        showToast(`🗑️ Download complete: ${msg.data.itemIds.length} files removed from cache.`, 'info');
      }
      break;

    case 'CACHE_CLEARED':
      if (msg.data && msg.data.username === activeCacheUsername) {
        cachedMediaItems = [];
        selectedMediaIds.clear();
        updateSelectionUI();
        if (liveMediaStreamGrid) {
          liveMediaStreamGrid.innerHTML = `
            <div class="col-span-full py-8 text-center text-gray-500">
              <i class="fa-solid fa-trash-can text-3xl mb-2 text-gray-600"></i>
              <p class="text-sm font-semibold text-gray-400">Cache Cleared</p>
              <p class="text-xs text-gray-600 mt-1">All temporary media files have been purged from the server.</p>
            </div>
          `;
        }
        if (liveStatusText) liveStatusText.textContent = `Cache cleared for @${activeCacheUsername}`;
        if (liveItemCounter) liveItemCounter.textContent = '0 items';
      }
      break;
  }
}

// --- Audio & Alert Handler ---
function handleTransitionAlert(alertData) {
  sounds.playAlert();

  // Show prominent alert banner
  transitionAlertBanner.classList.remove('hidden');
  const isPrivate = alertData.currentStatus === 'private';

  if (isPrivate) {
    transitionAlertDetails.textContent = `@${alertData.username} changed from PUBLIC to 🔒 PRIVATE (Account Locked)!`;
    showToast(`🔒 ALERT: @${alertData.username} is now PRIVATE!`, 'alert');
  } else {
    transitionAlertDetails.textContent = `@${alertData.username} changed from ${alertData.previousStatus?.toUpperCase() || 'PRIVATE'} to 🟢 PUBLIC!`;
    showToast(`🚨 ALERT: @${alertData.username} is now PUBLIC!`, 'alert');
  }

  transitionAlertLink.href = `https://www.instagram.com/${alertData.username}/`;
}

dismissAlertBtn.addEventListener('click', () => {
  transitionAlertBanner.classList.add('hidden');
});

// Sound Toggle
soundToggleBtn.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  if (state.soundEnabled) {
    soundIcon.className = 'fa-solid fa-volume-high text-emerald-400';
    showToast('Alert sound enabled', 'info');
  } else {
    soundIcon.className = 'fa-solid fa-volume-xmark text-gray-500';
    showToast('Alert sound muted', 'info');
  }
});

testAudioBtn.addEventListener('click', () => {
  sounds.init();
  sounds.playAlert();
  showToast('Playing alert chime test', 'info');
});

// --- Render UI Components ---
function renderAll() {
  renderStats();
  renderTargets();
  renderLogs();
  updateSessionIndicator();
}

function updateSessionIndicator() {
  if (!sessionDot || !sessionStatusText) return;
  if (state.settings?.sessionCookie) {
    sessionDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    sessionStatusText.textContent = 'Session Cookie Active';
    sessionStatusText.className = 'text-emerald-400 font-bold';
  } else {
    sessionDot.className = 'w-2 h-2 rounded-full bg-gray-500';
    sessionStatusText.textContent = 'Public Access Only';
    sessionStatusText.className = 'text-gray-400';
  }
}

function renderStats() {
  const total = state.targets.length;
  const active = state.targets.filter(t => t.isMonitoring).length;
  const priv = state.targets.filter(t => t.status === 'private').length;
  const pub = state.targets.filter(t => t.status === 'public').length;

  statTotal.textContent = total;
  statActive.textContent = active;
  statPrivate.textContent = priv;
  statPublic.textContent = pub;
  targetCountBadge.textContent = total;
}

function renderTargets() {
  targetsGrid.innerHTML = '';

  if (state.targets.length === 0) {
    targetsGrid.appendChild(noTargetsPlaceholder);
    return;
  }

  for (const target of state.targets) {
    const card = createTargetCard(target);
    targetsGrid.appendChild(card);
  }
}

function createTargetCard(target) {
  const card = document.createElement('div');
  card.className = 'bg-dark-850 rounded-2xl border border-gray-800 p-5 shadow-lg flex flex-col justify-between hover:border-gray-700 transition relative overflow-hidden group';

  // Top status indicator bar
  const statusBarColor = getStatusBarColor(target.status);
  const statusBadge = getStatusBadgeHtml(target.status);

  const relativeTime = formatRelativeTime(target.lastCheckedAt);
  const isPaused = !target.isMonitoring;

  card.innerHTML = `
    <div class="absolute top-0 left-0 right-0 h-1 ${statusBarColor}"></div>

    <div>
      <!-- Header row: Avatar, Handle, Status -->
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center space-x-3">
          <div class="w-12 h-12 rounded-full overflow-hidden bg-gray-800 flex items-center justify-center border border-gray-700 flex-shrink-0">
            ${target.profileInfo?.profilePicUrl 
              ? `<img src="${escapeHtml(target.profileInfo.profilePicUrl)}" alt="${escapeHtml(target.username)}" class="w-full h-full object-cover" onerror="this.src=''; this.parentElement.innerHTML='<i class=\\'fa-brands fa-instagram text-xl text-gray-500\\'></i>'" />`
              : `<i class="fa-brands fa-instagram text-xl text-gray-500"></i>`
            }
          </div>
          <div class="min-w-0">
            <div class="flex items-center space-x-1.5">
              <a href="https://www.instagram.com/${escapeHtml(target.username)}/" target="_blank" class="font-bold text-white hover:text-pink-400 text-sm truncate flex items-center space-x-1">
                <span>@${escapeHtml(target.username)}</span>
                <i class="fa-solid fa-arrow-up-right-from-square text-[10px] text-gray-500"></i>
              </a>
              ${target.profileInfo?.isVerified ? '<span title="Verified" class="text-sky-400 text-xs">✓</span>' : ''}
            </div>
            <p class="text-xs text-gray-400 truncate">${escapeHtml(target.profileInfo?.fullName || 'Instagram Account')}</p>
          </div>
        </div>
        <div>
          ${statusBadge}
        </div>
      </div>

      <!-- Monitoring Info / Intervals -->
      <div class="mt-4 pt-3 border-t border-gray-800/80 grid grid-cols-2 gap-2 text-xs">
        <div>
          <span class="text-gray-500 block">Frequency:</span>
          <span class="font-semibold text-gray-300">Every ${target.intervalSec || 3}s</span>
        </div>
        <div>
          <span class="text-gray-500 block">Last Check:</span>
          <span class="font-semibold text-gray-300 relative-time" data-timestamp="${target.lastCheckedAt || ''}">
            ${relativeTime}
          </span>
        </div>
      </div>

      <!-- Downloaded Content Status & Gallery Link -->
      <div class="mt-3 pt-2 border-t border-gray-800/50 flex items-center justify-between text-xs">
        <div class="flex items-center space-x-1.5 text-gray-400">
          <i class="fa-solid fa-cloud-arrow-down text-[11px] text-pink-400"></i>
          <span>Downloaded:</span>
          <span class="font-bold text-white bg-gray-900 border border-gray-800 px-2 py-0.5 rounded-full text-[11px]">${target.downloadedCount || 0}</span>
        </div>
        ${(target.downloadedCount > 0) ? `
          <button onclick="openGallery('${target.id}', '${escapeHtml(target.username)}')" class="text-xs text-pink-400 hover:text-pink-300 font-semibold underline flex items-center space-x-1">
            <i class="fa-solid fa-images text-[11px]"></i>
            <span>View All (${target.downloadedCount})</span>
          </button>
        ` : ''}
      </div>

      ${(target.recentMedia && target.recentMedia.length > 0) ? `
        <div class="mt-3 pt-2 border-t border-gray-800/60">
          <div class="flex items-center justify-between text-[11px] text-gray-400 font-semibold mb-2">
            <span>Recent Posts (${target.downloadedCount})</span>
            <button onclick="openGallery('${target.id}', '${escapeHtml(target.username)}')" class="text-pink-400 hover:underline text-[10px]">Open Gallery &rarr;</button>
          </div>
          <div class="grid grid-cols-4 gap-2 rounded-xl bg-gray-950 p-2 border border-gray-800">
            ${target.recentMedia.map(m => `
              <div onclick="openGallery('${target.id}', '${escapeHtml(target.username)}')" class="aspect-square rounded-lg overflow-hidden bg-gray-900 border border-gray-800 hover:border-pink-500/50 transition cursor-pointer relative group">
                <img src="${escapeHtml(m.fileUrl)}" alt="preview" class="w-full h-full object-cover group-hover:scale-105 transition" onerror="this.style.display='none'" />
                ${m.type?.includes('video') ? '<span class="absolute bottom-1 right-1 text-[8px] bg-black/80 text-white px-1 py-0.5 rounded"><i class="fa-solid fa-play"></i></span>' : ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${target.consecutiveErrors > 0 && target.status === 'rate_limited' ? `
        <div class="mt-2 text-[11px] text-amber-400/90 bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
          ⚠️ Rate limited. Add a proxy in Settings to continue 1s checks.
        </div>
      ` : ''}
    </div>

    <!-- Actions Toolbar -->
    <div class="mt-4 pt-3 border-t border-gray-800 flex items-center justify-between gap-1">
      <div class="flex items-center space-x-1.5 flex-wrap gap-y-1">
        <button
          onclick="triggerCheckNow('${target.id}', this)"
          title="Check status immediately"
          class="px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs font-semibold transition flex items-center space-x-1"
        >
          <i class="fa-solid fa-rotate"></i>
          <span>Check</span>
        </button>

        <button
          onclick="triggerSimulateFlip('${target.id}', this)"
          title="Test Privacy Flip (Public ⇄ Private) to test siren, Telegram & Discord alerts"
          class="px-2 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 text-xs font-semibold transition flex items-center space-x-1"
        >
          <i class="fa-solid fa-bolt"></i>
          <span>Test Flip</span>
        </button>

        <button
          onclick="triggerDownload('${target.id}', this)"
          title="Download all available posts, photos & stories"
          class="px-2 py-1.5 rounded-lg bg-pink-500/10 hover:bg-pink-500/20 text-pink-400 border border-pink-500/20 text-xs font-semibold transition flex items-center space-x-1"
        >
          <i class="fa-solid fa-cloud-arrow-down"></i>
          <span>Download</span>
        </button>

        ${(target.downloadedCount > 0) ? `
          <a
            href="/api/targets/${target.id}/download-zip"
            download
            title="Download all media as a ZIP file"
            class="px-2 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 text-xs font-semibold transition flex items-center space-x-1"
          >
            <i class="fa-solid fa-file-zipper"></i>
            <span>ZIP</span>
          </a>
        ` : ''}

        <a
          href="https://anonyig.com/en2/?url=${encodeURIComponent(target.username)}"
          target="_blank"
          rel="noopener noreferrer"
          title="Open 100% anonymous story & highlight viewer (no Instagram login needed)"
          class="px-2 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 text-xs font-semibold transition flex items-center space-x-1"
        >
          <i class="fa-solid fa-shield-halved"></i>
          <span>AnonyIG</span>
        </a>

        <button
          onclick="toggleMonitoring('${target.id}')"
          title="${isPaused ? 'Resume monitoring' : 'Pause monitoring'}"
          class="px-2 py-1.5 rounded-lg ${isPaused ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30' : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white'} text-xs font-semibold transition flex items-center space-x-1"
        >
          <i class="fa-solid ${isPaused ? 'fa-play' : 'fa-pause'}"></i>
          <span>${isPaused ? 'Resume' : 'Pause'}</span>
        </button>
      </div>

      <button
        onclick="deleteTarget('${target.id}', '${escapeHtml(target.username)}')"
        title="Stop and remove"
        class="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition text-xs"
      >
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `;

  return card;
}

function getStatusBarColor(status) {
  switch (status) {
    case 'public': return 'bg-emerald-500 shadow-lg shadow-emerald-500/50';
    case 'private': return 'bg-amber-500';
    case 'rate_limited': return 'bg-red-500';
    case 'not_found': return 'bg-gray-600';
    default: return 'bg-indigo-500';
  }
}

function getStatusBadgeHtml(status) {
  switch (status) {
    case 'public':
      return `
        <span class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-extrabold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-md shadow-emerald-500/20 animate-pulse-fast">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>PUBLIC</span>
        </span>
      `;
    case 'private':
      return `
        <span class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <i class="fa-solid fa-lock text-[10px]"></i>
          <span>PRIVATE</span>
        </span>
      `;
    case 'rate_limited':
      return `
        <span class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
          <i class="fa-solid fa-hand text-[10px]"></i>
          <span>BLOCKED</span>
        </span>
      `;
    case 'not_found':
      return `
        <span class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-700/50 text-gray-400 border border-gray-600">
          <span>NOT FOUND</span>
        </span>
      `;
    default:
      return `
        <span class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
          <i class="fa-solid fa-spinner fa-spin text-[10px]"></i>
          <span>CHECKING</span>
        </span>
      `;
  }
}

// --- Live Activity Stream ---
function renderLogs() {
  logsContainer.innerHTML = '';
  if (!state.logs || state.logs.length === 0) {
    logsContainer.innerHTML = '<p class="text-gray-500 italic">No activity logs recorded yet.</p>';
    return;
  }
  for (const log of state.logs) {
    appendLog(log, false);
  }
}

function appendLog(log, prepend = true) {
  // Clear placeholder if present
  if (logsContainer.children.length === 1 && logsContainer.children[0].tagName === 'P') {
    logsContainer.innerHTML = '';
  }

  const el = document.createElement('div');
  const levelClass = getLogLevelClass(log.level);
  const time = new Date(log.timestamp).toLocaleTimeString();

  el.className = `flex items-start space-x-2 py-1 px-2 rounded hover:bg-gray-900/60 transition ${levelClass}`;
  el.innerHTML = `
    <span class="text-gray-500 select-none">[${time}]</span>
    <span class="font-medium">${escapeHtml(log.message)}</span>
  `;

  if (prepend) {
    logsContainer.insertBefore(el, logsContainer.firstChild);
    // Keep max 100 in DOM
    if (logsContainer.children.length > 100) {
      logsContainer.removeChild(logsContainer.lastChild);
    }
  } else {
    logsContainer.appendChild(el);
  }
}

function getLogLevelClass(level) {
  switch (level) {
    case 'alert': return 'text-pink-400 font-bold bg-pink-500/10 border-l-2 border-pink-500 pl-2';
    case 'success': return 'text-emerald-400';
    case 'warning': return 'text-amber-400';
    case 'error': return 'text-red-400';
    default: return 'text-gray-300';
  }
}

clearLogsBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logs', { method: 'DELETE' });
    showToast('Activity logs cleared', 'info');
  } catch (err) {
    showToast('Failed to clear logs', 'error');
  }
});

// --- Target Actions ---
addTargetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = targetUsernameInput.value.trim().replace(/^@/, '');
  const intervalSec = parseInt(targetIntervalInput.value, 10);

  if (!username) return;

  addTargetBtn.disabled = true;
  addTargetBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Adding...';

  try {
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, intervalSec })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to add target');
    }

    targetUsernameInput.value = '';
    sounds.playBeep();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    addTargetBtn.disabled = false;
    addTargetBtn.innerHTML = '<i class="fa-solid fa-radar"></i> <span>Track Target</span>';
  }
});

window.triggerCheckNow = async (id, btn) => {
  try {
    btn.classList.add('opacity-50', 'pointer-events-none');
    const icon = btn.querySelector('i');
    if (icon) icon.classList.add('fa-spin');

    const res = await fetch(`/api/targets/${id}/check`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed check');

    if (data.status === 'public' || data.status === 'private') {
      showToast(`Checked @${data.username}: ${data.status.toUpperCase()}`, 'success');
    } else if (data.status === 'rate_limited') {
      showToast(`⚠️ @${data.username}: Rate limited by Instagram. Using mirror backup.`, 'warning');
    } else {
      showToast(`⚠️ @${data.username}: Temporary check error (${data.status}). Retrying...`, 'warning');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('opacity-50', 'pointer-events-none');
    const icon = btn.querySelector('i');
    if (icon) icon.classList.remove('fa-spin');
  }
};

window.triggerSimulateFlip = async (id, btn) => {
  try {
    btn.classList.add('opacity-50', 'pointer-events-none');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin';

    const res = await fetch(`/api/targets/${id}/simulate-transition`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed transition simulation');

    showToast(`⚡ Flipped @${data.target.username}: ${data.from.toUpperCase()} ➔ ${data.to.toUpperCase()}! Siren & notifications dispatched.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('opacity-50', 'pointer-events-none');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-bolt';
  }
};

window.toggleMonitoring = async (id) => {
  try {
    const res = await fetch(`/api/targets/${id}/toggle`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed toggle');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteTarget = async (id, username) => {
  if (!confirm(`Are you sure you want to stop monitoring @${username}?`)) return;

  try {
    const res = await fetch(`/api/targets/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete target');
    showToast(`Removed @${username}`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// --- Live Cache Downloader Form & Stream Card Renderer ---
function updateSelectionUI() {
  const total = cachedMediaItems.length;
  const selectedCount = selectedMediaIds.size;

  if (selectionSummaryText) {
    selectionSummaryText.textContent = `${selectedCount} of ${total} selected`;
  }

  if (downloadSelectedZipBtn) {
    downloadSelectedZipBtn.disabled = selectedCount === 0;
  }

  if (downloadSelectedText) {
    downloadSelectedText.textContent = `Download Selected (${selectedCount}) as .ZIP`;
  }

  if (selectAllCheckbox) {
    selectAllCheckbox.checked = total > 0 && selectedCount === total;
    selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < total;
  }

  if (liveItemCounter) {
    liveItemCounter.textContent = `${total} items in cache`;
  }
}

function removeCachedCardFromGrid(itemId) {
  const card = document.querySelector(`.media-stream-card[data-id="${itemId}"]`);
  if (card) {
    card.classList.add('transition-all', 'duration-500', 'opacity-0', 'scale-90', 'pointer-events-none');
    setTimeout(() => {
      if (card.parentNode) card.remove();
    }, 450);
  }

  cachedMediaItems = cachedMediaItems.filter(i => i.id !== itemId);
  selectedMediaIds.delete(itemId);
  updateSelectionUI();

  if (cachedMediaItems.length === 0 && liveMediaStreamGrid) {
    setTimeout(() => {
      if (cachedMediaItems.length === 0) {
        liveMediaStreamGrid.innerHTML = `
          <div class="col-span-full py-8 text-center text-gray-500">
            <i class="fa-solid fa-circle-check text-3xl mb-2 text-emerald-500"></i>
            <p class="text-sm font-semibold text-gray-300">All media downloaded!</p>
            <p class="text-xs text-gray-500 mt-1">Cache has been completely cleared in real time.</p>
          </div>
        `;
        if (liveStatusText) liveStatusText.textContent = `All media downloaded and cache cleared for @${activeCacheUsername}`;
      }
    }, 500);
  }
}

async function downloadSingleCachedItem(username, itemId) {
  const targetItem = cachedMediaItems.find(i => i.id === itemId);
  const card = document.querySelector(`.media-stream-card[data-id="${itemId}"]`);
  const btn = card?.querySelector('.single-download-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Downloading...</span>';
  }

  try {
    const downloadUrl = `/api/cache/download/${encodeURIComponent(username)}/${encodeURIComponent(itemId)}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = targetItem?.fileName || 'media';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast(`Downloading ${targetItem?.fileName || 'media file'}...`, 'info');

    // Keep media file and card available while user is on the site
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.className = 'single-download-btn w-full py-1 text-center rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold transition flex items-center justify-center space-x-1';
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> <span>Downloaded</span>';
      }
    }, 600);
  } catch (err) {
    showToast(`Download failed: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-download"></i> <span>Download</span>';
    }
  }
}

async function downloadSelectedCachedItems() {
  if (selectedMediaIds.size === 0 || !activeCacheUsername) return;

  const count = selectedMediaIds.size;
  const ids = Array.from(selectedMediaIds);

  if (downloadSelectedZipBtn) {
    downloadSelectedZipBtn.disabled = true;
    downloadSelectedZipBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Creating ZIP...</span>';
  }

  try {
    showToast(`Packaging ${count} selected media files into ZIP...`, 'info');

    const res = await fetch('/api/cache/download-selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: activeCacheUsername,
        itemIds: ids
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'ZIP creation failed' }));
      throw new Error(err.error || 'Failed to download selected ZIP');
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCacheUsername}_selected_${count}_files.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    // Keep all cards on screen; mark them with green Downloaded state
    ids.forEach(id => {
      const card = document.querySelector(`.media-stream-card[data-id="${id}"]`);
      const btn = card?.querySelector('.single-download-btn');
      if (btn) {
        btn.className = 'single-download-btn w-full py-1 text-center rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold transition flex items-center justify-center space-x-1';
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> <span>Downloaded</span>';
      }
    });

    showToast(`✅ Downloaded ${count} items! Media remains accessible while you are on site.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (downloadSelectedZipBtn) {
      downloadSelectedZipBtn.disabled = selectedMediaIds.size === 0;
      downloadSelectedZipBtn.innerHTML = '<i class="fa-solid fa-file-zipper"></i> <span id="downloadSelectedText">Download Selected (0) as .ZIP</span>';
    }
    updateSelectionUI();
  }
}

if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener('change', (e) => {
    const checkAll = e.target.checked;
    if (checkAll) {
      cachedMediaItems.forEach(i => selectedMediaIds.add(i.id));
    } else {
      selectedMediaIds.clear();
    }
    document.querySelectorAll('.media-select-checkbox').forEach(cb => {
      cb.checked = checkAll;
    });
    document.querySelectorAll('.media-stream-card').forEach(c => {
      if (checkAll) c.classList.add('ring-2', 'ring-amber-400');
      else c.classList.remove('ring-2', 'ring-amber-400');
    });
    updateSelectionUI();
  });
}

if (downloadSelectedZipBtn) {
  downloadSelectedZipBtn.addEventListener('click', downloadSelectedCachedItems);
}

if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    if (!activeCacheUsername) return;
    if (!confirm(`Purge all temporary cached media for @${activeCacheUsername}?`)) return;

    try {
      await fetch(`/api/cache/${encodeURIComponent(activeCacheUsername)}`, { method: 'DELETE' });
      cachedMediaItems = [];
      selectedMediaIds.clear();
      updateSelectionUI();
      if (liveMediaStreamGrid) {
        liveMediaStreamGrid.innerHTML = `
          <div class="col-span-full py-8 text-center text-gray-500">
            <i class="fa-solid fa-trash-can text-3xl mb-2 text-gray-600"></i>
            <p class="text-sm font-semibold text-gray-400">Cache Cleared</p>
          </div>
        `;
      }
      showToast(`Cache cleared for @${activeCacheUsername}`, 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

if (liveDownloadForm) {
  liveDownloadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = liveDownloadUsername.value.trim().replace(/^@/, '');
    if (!username) return;

    activeCacheUsername = username;
    cachedMediaItems = [];
    selectedMediaIds.clear();
    updateSelectionUI();
    notifyViewingCache(username);

    startLiveDownloadBtn.disabled = true;
    startLiveDownloadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Downloading to Cache...';
    liveDownloadStatusBox.classList.remove('hidden');
    liveMediaStreamGrid.innerHTML = '';
    liveStatusText.textContent = `Connecting to Instagram and downloading @${username} into cache...`;
    liveItemCounter.textContent = '0 items';
    if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';

    try {
      const res = await fetch('/api/cache/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Live download failed');

      if (data.items && data.items.length > 0) {
        liveMediaStreamGrid.innerHTML = '';
        cachedMediaItems = [...data.items];
        let idx = 0;
        const total = data.items.length;
        liveStatusText.textContent = `⚡ Ready: ${total} items cached for @${username}. Select items below to download:`;
        if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
        
        // Smooth stream animation into grid
        const streamTimer = setInterval(() => {
          if (idx >= total) {
            clearInterval(streamTimer);
            updateSelectionUI();
            return;
          }
          const item = data.items[idx];
          appendLiveMediaCard({ item, username, current: idx + 1, total }, false, false);
          idx++;
        }, 15);
      } else {
        liveMediaStreamGrid.innerHTML = `
          <div class="col-span-full py-8 text-center text-gray-400">
            <i class="fa-solid fa-camera text-3xl mb-2 text-gray-600"></i>
            <p class="text-sm font-semibold text-gray-300">No media found for @${escapeHtml(username)}</p>
            <p class="text-xs text-gray-500 mt-1">This account currently has 0 posts, highlights, or active stories.</p>
          </div>
        `;
        liveStatusText.textContent = `@${username} has no available media`;
        if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-gray-500';
      }
    } catch (err) {
      showToast(err.message, 'error');
      liveStatusText.textContent = `❌ ${err.message}`;
      if (livePulseIndicator) livePulseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    } finally {
      startLiveDownloadBtn.disabled = false;
      startLiveDownloadBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> <span>Live Download Profile</span>';
    }
  });
}

function appendLiveMediaCard(data, prepend = false, addToState = true) {
  const item = data.item;
  if (!item || !liveMediaStreamGrid) return;

  if (addToState && !cachedMediaItems.some(i => i.id === item.id)) {
    cachedMediaItems.push(item);
    updateSelectionUI();
  }

  // Avoid duplicate card in grid
  const existingCard = document.querySelector(`.media-stream-card[data-id="${item.id}"]`);
  if (existingCard) return;

  const card = document.createElement('div');
  card.dataset.id = item.id;
  card.className = 'media-stream-card relative bg-gray-950 border border-gray-800 rounded-xl overflow-hidden flex flex-col hover:border-amber-400/50 transition transform';

  const isVideo = item.type?.includes('video');
  const isHighlight = item.type === 'highlight';
  const isStory = item.type?.includes('story');
  const isSlide = item.type?.includes('slide');
  const fileUrl = item.fileUrl;
  const previewThumb = item.thumbnailUrl || (isVideo ? null : fileUrl);

  let badgeText = isStory ? 'Story' : (isHighlight ? 'Highlight' : (isSlide ? `Slide ${item.slideIndex || ''}` : (isVideo ? 'Video' : 'Photo')));
  let badgeColor = isHighlight ? 'bg-amber-500 text-black font-extrabold' : (isSlide ? 'bg-blue-600 text-white' : (isStory ? 'bg-purple-600 text-white' : 'bg-black/80 text-white'));

  card.innerHTML = `
    <!-- Top Right Checkbox for Selection -->
    <label class="absolute top-1.5 right-1.5 z-20 p-1 rounded-md bg-black/70 backdrop-blur-md cursor-pointer flex items-center justify-center hover:bg-black transition border border-white/10" onclick="event.stopPropagation()">
      <input type="checkbox" data-id="${item.id}" class="media-select-checkbox w-4 h-4 rounded text-amber-500 bg-gray-900 border-gray-600 focus:ring-amber-400 cursor-pointer" ${selectedMediaIds.has(item.id) ? 'checked' : ''} />
    </label>

    <div class="relative aspect-square bg-black flex items-center justify-center overflow-hidden cursor-pointer group">
      ${previewThumb ? `
        <img src="${previewThumb}" alt="preview" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" onerror="this.onerror=null; this.src='${fileUrl}';" />
        ${isVideo ? `
          <div class="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition">
            <i class="fa-solid fa-play text-white text-xl group-hover:scale-110 transition-transform"></i>
          </div>
        ` : ''}
      ` : (isVideo ? `
        <video src="${fileUrl}" class="w-full h-full object-cover" preload="auto" muted playsinline onloadeddata="if(this.currentTime===0)this.currentTime=0.1;"></video>
        <div class="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition">
          <i class="fa-solid fa-play text-white text-xl group-hover:scale-110 transition-transform"></i>
        </div>
      ` : `
        <img src="${fileUrl}" alt="media" class="w-full h-full object-cover group-hover:scale-105 transition" onerror="this.parentElement.innerHTML='<div class=\\'text-gray-600 text-xs p-2 text-center\\'>Media File</div>'" />
      `)}
      <span class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase backdrop-blur-sm ${badgeColor}">
        ${badgeText}
      </span>
      <div class="absolute inset-0 bg-pink-500/0 group-hover:bg-pink-500/10 transition-colors pointer-events-none"></div>
    </div>
    <div class="p-2 flex-1 flex flex-col justify-between space-y-1.5 bg-gray-950">
      <p class="text-[10px] text-gray-300 line-clamp-1 cursor-pointer hover:text-white" title="${escapeHtml(item.caption || item.title || '')}">
        ${escapeHtml(item.caption || item.title || item.code || 'Media Item')}
      </p>
      <button data-id="${item.id}" class="single-download-btn w-full py-1 text-center rounded bg-amber-500/10 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 text-[10px] font-bold transition flex items-center justify-center space-x-1">
        <i class="fa-solid fa-download"></i>
        <span>Download</span>
      </button>
    </div>
  `;

  // Checkbox Event
  const cb = card.querySelector('.media-select-checkbox');
  if (cb) {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) {
        selectedMediaIds.add(item.id);
        card.classList.add('ring-2', 'ring-amber-400');
      } else {
        selectedMediaIds.delete(item.id);
        card.classList.remove('ring-2', 'ring-amber-400');
      }
      updateSelectionUI();
    });
  }

  // Click to open preview Lightbox
  const thumb = card.querySelector('.relative.aspect-square');
  if (thumb) {
    thumb.addEventListener('click', () => {
      window.openSingleItemLightbox(item, data.username || activeCacheUsername);
    });
  }

  // Hover video play
  const vid = card.querySelector('video');
  if (vid) {
    card.addEventListener('mouseenter', () => { vid.play().catch(()=>{}); });
    card.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });
  }

  // Single Download & Clear button
  const singleBtn = card.querySelector('.single-download-btn');
  if (singleBtn) {
    singleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSingleCachedItem(data.username || activeCacheUsername, item.id);
    });
  }

  if (prepend && liveMediaStreamGrid.firstChild) {
    liveMediaStreamGrid.insertBefore(card, liveMediaStreamGrid.firstChild);
  } else {
    liveMediaStreamGrid.appendChild(card);
  }
}

// --- Settings & Tests ---
openSettingsBtn.addEventListener('click', () => {
  loadSettingsIntoModal();
  settingsModal.classList.remove('hidden');
});

closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
cancelSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

function loadSettingsIntoModal() {
  cfgTelegramToken.value = state.settings.telegramToken || '';
  cfgTelegramChatId.value = state.settings.telegramChatId || '';
  cfgDiscordWebhook.value = state.settings.discordWebhookUrl || '';
  cfgProxyUrl.value = state.settings.proxyUrl || '';
  cfgSessionCookie.value = state.settings.sessionCookie || '';
  if (cfgAppUrl) {
    cfgAppUrl.value = state.settings.appUrl || '';
  }
  if (cfgAutoDownload) {
    cfgAutoDownload.checked = state.settings.autoDownloadOnPublic !== false;
  }

  telegramFeedback.classList.add('hidden');
  discordFeedback.classList.add('hidden');

  // Check Keep-Alive status
  fetchKeepAliveStatus();
}

async function fetchKeepAliveStatus() {
  if (!keepAliveBadge) return;
  try {
    const res = await fetch('/api/keepalive');
    const data = await res.json();
    if (data.active && data.configuredUrl) {
      keepAliveBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
      keepAliveBadge.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i> 24/7 Active (${data.pingCount} pings)`;
      if (keepAliveFeedback) {
        keepAliveFeedback.innerHTML = `Active target: <code class="text-emerald-400">${data.configuredUrl}/health</code> • Pinging every 10m`;
      }
      if (cfgAppUrl && !cfgAppUrl.value) {
        cfgAppUrl.value = data.configuredUrl;
      }
    } else {
      keepAliveBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30';
      keepAliveBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> URL Needed`;
      if (keepAliveFeedback) {
        keepAliveFeedback.innerHTML = `Enter your Render app URL above so the server auto-pings every 10m to prevent sleeping.`;
      }
    }
  } catch (e) {
    keepAliveBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-gray-800 text-gray-400 border border-gray-700';
    keepAliveBadge.innerText = 'Offline';
  }
}

if (testKeepAliveBtn) {
  testKeepAliveBtn.addEventListener('click', async () => {
    testKeepAliveBtn.disabled = true;
    testKeepAliveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Pinging...';
    try {
      // First save URL if changed
      if (cfgAppUrl && cfgAppUrl.value.trim()) {
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appUrl: cfgAppUrl.value.trim() })
        });
      }
      const res = await fetch('/api/keepalive/ping', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast(`Keep-Alive ping succeeded! (${data.latency}ms)`, 'success');
        fetchKeepAliveStatus();
      } else {
        showToast(`Ping failed: ${data.error || 'Check URL'}`, 'error');
      }
    } catch (e) {
      showToast(`Ping error: ${e.message}`, 'error');
    } finally {
      testKeepAliveBtn.disabled = false;
      testKeepAliveBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> <span>Test Ping</span>';
    }
  });
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    telegramToken: cfgTelegramToken.value.trim(),
    telegramChatId: cfgTelegramChatId.value.trim(),
    discordWebhookUrl: cfgDiscordWebhook.value.trim(),
    proxyUrl: cfgProxyUrl.value.trim(),
    sessionCookie: cfgSessionCookie.value.trim(),
    appUrl: cfgAppUrl ? cfgAppUrl.value.trim() : '',
    autoDownloadOnPublic: cfgAutoDownload ? cfgAutoDownload.checked : true
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to update settings');
    settingsModal.classList.add('hidden');
    showToast('Settings saved successfully', 'success');
    updateSessionHealthBadge();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Test Telegram
testTelegramBtn.addEventListener('click', async () => {
  const token = cfgTelegramToken.value.trim();
  const chatId = cfgTelegramChatId.value.trim();

  telegramFeedback.className = 'text-xs font-medium text-sky-400 block';
  telegramFeedback.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Sending test notification to Telegram...';

  try {
    const res = await fetch('/api/settings/test-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, chatId })
    });
    const data = await res.json();
    if (res.ok) {
      telegramFeedback.className = 'text-xs font-semibold text-emerald-400 block';
      telegramFeedback.innerHTML = '✅ Success: Test message arrived in your Telegram!';
    } else {
      telegramFeedback.className = 'text-xs font-semibold text-red-400 block';
      telegramFeedback.innerHTML = `❌ Error: ${data.error || 'Failed to send'}`;
    }
  } catch (err) {
    telegramFeedback.className = 'text-xs font-semibold text-red-400 block';
    telegramFeedback.innerHTML = `❌ Connection error: ${err.message}`;
  }
});

// Test Discord
testDiscordBtn.addEventListener('click', async () => {
  const webhookUrl = cfgDiscordWebhook.value.trim();

  discordFeedback.className = 'text-xs font-medium text-indigo-400 block';
  discordFeedback.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Sending test notification to Discord...';

  try {
    const res = await fetch('/api/settings/test-discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl })
    });
    const data = await res.json();
    if (res.ok) {
      discordFeedback.className = 'text-xs font-semibold text-emerald-400 block';
      discordFeedback.innerHTML = '✅ Success: Test embed arrived in your Discord channel!';
    } else {
      discordFeedback.className = 'text-xs font-semibold text-red-400 block';
      discordFeedback.innerHTML = `❌ Error: ${data.error || 'Failed to send'}`;
    }
  } catch (err) {
    discordFeedback.className = 'text-xs font-semibold text-red-400 block';
    discordFeedback.innerHTML = `❌ Connection error: ${err.message}`;
  }
});

// --- Toast Notifications ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');

  let bgClass = 'bg-gray-800 text-gray-200 border-gray-700';
  let icon = 'fa-info-circle text-blue-400';

  if (type === 'success') {
    bgClass = 'bg-emerald-950/90 text-emerald-200 border-emerald-800';
    icon = 'fa-check-circle text-emerald-400';
  } else if (type === 'error') {
    bgClass = 'bg-red-950/90 text-red-200 border-red-800';
    icon = 'fa-circle-exclamation text-red-400';
  } else if (type === 'alert') {
    bgClass = 'bg-pink-950 text-white border-pink-700 shadow-xl shadow-pink-900/50';
    icon = 'fa-bell text-pink-400 animate-bounce';
  }

  toast.className = `flex items-center space-x-2.5 px-4 py-3 rounded-xl border text-xs font-medium shadow-2xl backdrop-blur-md transition-all duration-300 transform translate-y-4 opacity-0 pointer-events-auto ${bgClass}`;
  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
  });

  // Fade out and remove
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- Relative Time Auto-updater ---
function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Never';
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 2) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

setInterval(() => {
  document.querySelectorAll('.relative-time').forEach(el => {
    const ts = el.getAttribute('data-timestamp');
    if (ts) el.textContent = formatRelativeTime(ts);
  });
}, 1000);

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Download & Media Gallery Logic ---
window.triggerDownload = async (targetId, btn) => {
  try {
    btn.classList.add('opacity-50', 'pointer-events-none');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin';

    showToast('Extracting and downloading content...', 'info');
    const res = await fetch(`/api/targets/${targetId}/download`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to download');

    showToast(`✅ Downloaded ${data.summary.newlyDownloaded} new files (${data.summary.skipped} skipped)`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.classList.remove('opacity-50', 'pointer-events-none');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fa-solid fa-cloud-arrow-down';
  }
};

// --- Download & Media Gallery Logic ---
let allGalleryItems = [];
let displayedGalleryItems = [];
let activeGalleryFilter = 'all';
let gallerySearchQuery = '';
let currentLightboxIndex = 0;

function filterAndSortGallery() {
  let list = allGalleryItems;

  // 1. Category Filter
  if (activeGalleryFilter === 'slides') {
    list = list.filter(i => i.type?.includes('slide') || i.type === 'photo_post' || i.type === 'video_post');
  } else if (activeGalleryFilter === 'highlights') {
    list = list.filter(i => i.type === 'highlight');
  } else if (activeGalleryFilter === 'stories') {
    list = list.filter(i => i.type?.includes('story'));
  }

  // 2. Search Keyword Filter
  if (gallerySearchQuery) {
    const q = gallerySearchQuery.toLowerCase();
    list = list.filter(i => {
      const caption = (i.caption || '').toLowerCase();
      const title = (i.title || '').toLowerCase();
      const code = (i.code || i.shortcode || '').toLowerCase();
      const type = (i.type || '').toLowerCase();
      const date = (i.downloadedAt ? new Date(i.downloadedAt).toLocaleDateString() : '').toLowerCase();
      return caption.includes(q) || title.includes(q) || code.includes(q) || type.includes(q) || date.includes(q);
    });
  }

  displayedGalleryItems = list;
  return list;
}

function renderGalleryItems() {
  const grid = document.getElementById('galleryGrid');
  const empty = document.getElementById('galleryEmpty');
  const stats = document.getElementById('galleryStats');

  const filtered = filterAndSortGallery();

  // Update badge counts on filter buttons
  const allCount = allGalleryItems.length;
  const slidesCount = allGalleryItems.filter(i => i.type?.includes('slide') || i.type === 'photo_post' || i.type === 'video_post').length;
  const highlightsCount = allGalleryItems.filter(i => i.type === 'highlight').length;
  const storiesCount = allGalleryItems.filter(i => i.type?.includes('story')).length;

  const countAllEl = document.getElementById('filterCountAll');
  const countSlidesEl = document.getElementById('filterCountSlides');
  const countHighlightsEl = document.getElementById('filterCountHighlights');
  const countStoriesEl = document.getElementById('filterCountStories');

  if (countAllEl) countAllEl.textContent = allCount;
  if (countSlidesEl) countSlidesEl.textContent = slidesCount;
  if (countHighlightsEl) countHighlightsEl.textContent = highlightsCount;
  if (countStoriesEl) countStoriesEl.textContent = storiesCount;

  if (stats) {
    if (gallerySearchQuery) {
      stats.innerHTML = `<span class="text-pink-400 font-bold">${filtered.length} matches</span> for "<span class="text-white">${escapeHtml(gallerySearchQuery)}</span>" (of ${allCount} files)`;
    } else {
      stats.textContent = `${filtered.length} of ${allCount} files displayed (deduplicated)`;
    }
  }

  if (filtered.length === 0) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = '';

  filtered.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col group hover:border-pink-500/60 transition cursor-pointer transform hover:-translate-y-0.5 duration-200';

    const isVideo = item.type?.includes('video') || item.fileUrl?.endsWith('.mp4');
    const isHighlight = item.type === 'highlight';
    const isStory = item.type?.includes('story');
    const isSlide = item.type?.includes('slide');
    const fileUrl = item.fileUrl;

    let badgeText = 'Photo';
    let badgeClass = 'bg-black/70 text-white';
    if (isHighlight) {
      badgeText = 'Highlight';
      badgeClass = 'bg-amber-500 text-black font-extrabold';
    } else if (isStory) {
      badgeText = 'Story';
      badgeClass = 'bg-purple-600 text-white font-bold';
    } else if (isSlide) {
      badgeText = item.slideIndex ? `Slide ${item.slideIndex}/${item.totalSlides || ''}` : 'Slide';
      badgeClass = 'bg-blue-600 text-white font-bold';
    } else if (isVideo) {
      badgeText = 'Video';
      badgeClass = 'bg-red-600 text-white font-bold';
    }

    card.innerHTML = `
      <div class="relative aspect-square bg-gray-950 flex items-center justify-center overflow-hidden" onclick="openLightbox(${index})">
        ${isVideo ? `
          <video src="${fileUrl}#t=0.001" ${item.thumbnailUrl ? `poster="${item.thumbnailUrl}"` : ''} class="w-full h-full object-cover" preload="auto" muted playsinline></video>
          <div class="absolute inset-0 bg-black/30 flex items-center justify-center group-hover:bg-black/10 transition">
            <i class="fa-solid fa-circle-play text-white/90 text-3xl group-hover:scale-110 transition-transform"></i>
          </div>
        ` : `
          <img src="${fileUrl}" alt="media" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" onerror="this.parentElement.innerHTML='<div class=\\'text-gray-600 text-xs p-2 text-center\\'>Media File</div>'" />
        `}
        <span class="absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase backdrop-blur-sm border border-white/10 ${badgeClass}">
          ${badgeText}
        </span>
        <div class="absolute inset-0 bg-pink-500/0 group-hover:bg-pink-500/10 transition-colors pointer-events-none"></div>
      </div>
      <div class="p-3 flex-1 flex flex-col justify-between space-y-2">
        <p class="text-[11px] text-gray-300 line-clamp-2 leading-tight" title="${escapeHtml(item.caption || item.title || '')}" onclick="openLightbox(${index})">
          ${escapeHtml(item.caption || item.title || 'Media File')}
        </p>
        <div class="pt-2 border-t border-gray-800/80 flex items-center justify-between text-[10px] text-gray-400">
          <span>${item.downloadedAt ? new Date(item.downloadedAt).toLocaleDateString() : 'Archived'}</span>
          <div class="flex items-center space-x-2">
            <button onclick="openLightbox(${index})" class="text-gray-400 hover:text-white font-semibold">
              <i class="fa-solid fa-up-right-and-down-left-from-center mr-0.5"></i> View
            </button>
            <a href="${fileUrl}" download target="_blank" onclick="event.stopPropagation()" class="text-pink-400 hover:text-pink-300 font-bold flex items-center space-x-0.5">
              <i class="fa-solid fa-download"></i>
            </a>
          </div>
        </div>
      </div>
    `;

    const vid = card.querySelector('video');
    if (vid) {
      card.addEventListener('mouseenter', () => { vid.play().catch(()=>{}); });
      card.addEventListener('mouseleave', () => { vid.pause(); vid.currentTime = 0; });
    }

    grid.appendChild(card);
  });
}

// Search Bar Input Event
const gallerySearchInput = document.getElementById('gallerySearchInput');
const clearGallerySearchBtn = document.getElementById('clearGallerySearchBtn');

if (gallerySearchInput) {
  gallerySearchInput.addEventListener('input', (e) => {
    gallerySearchQuery = e.target.value.trim();
    if (clearGallerySearchBtn) {
      if (gallerySearchQuery) {
        clearGallerySearchBtn.classList.remove('hidden');
      } else {
        clearGallerySearchBtn.classList.add('hidden');
      }
    }
    renderGalleryItems();
  });
}

if (clearGallerySearchBtn) {
  clearGallerySearchBtn.addEventListener('click', () => {
    if (gallerySearchInput) gallerySearchInput.value = '';
    gallerySearchQuery = '';
    clearGallerySearchBtn.classList.add('hidden');
    renderGalleryItems();
  });
}

window.openGallery = async (targetId, username) => {
  currentGalleryTarget = { targetId, username };
  const modal = document.getElementById('mediaGalleryModal');
  const title = document.getElementById('galleryTitle');
  const subtitle = document.getElementById('gallerySubtitle');
  const grid = document.getElementById('galleryGrid');
  const loading = document.getElementById('galleryLoading');
  const empty = document.getElementById('galleryEmpty');
  const galleryZipBtn = document.getElementById('galleryZipBtn');

  if (galleryZipBtn) {
    galleryZipBtn.href = `/api/download-zip/${username}`;
  }

  const galleryAnonyigBtn = document.getElementById('galleryAnonyigBtn');
  if (galleryAnonyigBtn) {
    galleryAnonyigBtn.href = `https://anonyig.com/en2/?url=${encodeURIComponent(username)}`;
  }
  const galleryEmptyAnonyigBtn = document.getElementById('galleryEmptyAnonyigBtn');
  if (galleryEmptyAnonyigBtn) {
    galleryEmptyAnonyigBtn.href = `https://anonyig.com/en2/?url=${encodeURIComponent(username)}`;
  }

  title.textContent = `@${username} • Media Gallery`;
  subtitle.textContent = `Viewing downloaded posts, slides, highlights, and stories`;
  modal.classList.remove('hidden');
  loading.classList.remove('hidden');
  grid.classList.add('hidden');
  empty.classList.add('hidden');

  // Reset search box
  if (gallerySearchInput) gallerySearchInput.value = '';
  gallerySearchQuery = '';
  if (clearGallerySearchBtn) clearGallerySearchBtn.classList.add('hidden');

  try {
    const res = await fetch(`/api/targets/${targetId}/downloads`);
    const data = await res.json();
    loading.classList.add('hidden');

    allGalleryItems = data.items || [];
    activeGalleryFilter = 'all';

    // Reset filter buttons state
    document.querySelectorAll('.gallery-filter-btn').forEach(b => {
      if (b.dataset.filter === 'all') {
        b.className = 'gallery-filter-btn px-3 py-1.5 rounded-lg font-bold transition bg-pink-600 text-white';
      } else {
        b.className = 'gallery-filter-btn px-3 py-1.5 rounded-lg font-semibold transition bg-gray-900 text-gray-400 hover:text-white hover:bg-gray-800';
      }
    });

    renderGalleryItems();
  } catch (err) {
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
    showToast(`Failed to load gallery: ${err.message}`, 'error');
  }
};

// Gallery filter tab click handlers
document.querySelectorAll('.gallery-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gallery-filter-btn').forEach(b => {
      b.className = 'gallery-filter-btn px-3 py-1.5 rounded-lg font-semibold transition bg-gray-900 text-gray-400 hover:text-white hover:bg-gray-800';
    });
    btn.className = 'gallery-filter-btn px-3 py-1.5 rounded-lg font-bold transition bg-pink-600 text-white';
    activeGalleryFilter = btn.dataset.filter || 'all';
    renderGalleryItems();
  });
});

if (closeGalleryBtn) {
  closeGalleryBtn.addEventListener('click', () => mediaGalleryModal.classList.add('hidden'));
}
if (closeGalleryBottomBtn) {
  closeGalleryBottomBtn.addEventListener('click', () => mediaGalleryModal.classList.add('hidden'));
}
if (refreshGalleryBtn) {
  refreshGalleryBtn.addEventListener('click', () => {
    if (currentGalleryTarget) {
      window.openGallery(currentGalleryTarget.targetId, currentGalleryTarget.username);
    }
  });
}

// --- In-Browser Lightbox Modal Logic ---
const lightboxModal = document.getElementById('lightboxModal');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxVideo = document.getElementById('lightboxVideo');
const lightboxTypeBadge = document.getElementById('lightboxTypeBadge');
const lightboxTargetTitle = document.getElementById('lightboxTargetTitle');
const lightboxCounter = document.getElementById('lightboxCounter');
const lightboxCaption = document.getElementById('lightboxCaption');
const lightboxTimestamp = document.getElementById('lightboxTimestamp');
const lightboxPostCode = document.getElementById('lightboxPostCode');
const lightboxDirectDownloadBtn = document.getElementById('lightboxDirectDownloadBtn');
const lightboxFullscreenBtn = document.getElementById('lightboxFullscreenBtn');
const closeLightboxBtn = document.getElementById('closeLightboxBtn');
const lightboxPrevBtn = document.getElementById('lightboxPrevBtn');
const lightboxNextBtn = document.getElementById('lightboxNextBtn');

window.openLightbox = (index) => {
  if (!displayedGalleryItems || displayedGalleryItems.length === 0) return;
  currentLightboxIndex = Math.max(0, Math.min(index, displayedGalleryItems.length - 1));
  renderLightboxItem();
  if (lightboxModal) {
    lightboxModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  }
};

window.openSingleItemLightbox = (item, username) => {
  if (!item) return;
  if (username) {
    currentGalleryTarget = { targetId: null, username };
  }
  displayedGalleryItems = [item];
  currentLightboxIndex = 0;
  renderLightboxItem();
  if (lightboxModal) {
    lightboxModal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
  }
};

function renderLightboxItem() {
  if (!displayedGalleryItems || displayedGalleryItems.length === 0) return;
  const item = displayedGalleryItems[currentLightboxIndex];
  if (!item) return;

  const total = displayedGalleryItems.length;
  const isVideo = item.type?.includes('video') || item.fileUrl?.endsWith('.mp4');
  const isHighlight = item.type === 'highlight';
  const isStory = item.type?.includes('story');
  const isSlide = item.type?.includes('slide');

  // Pause previous video
  if (lightboxVideo) {
    lightboxVideo.pause();
    lightboxVideo.src = '';
  }

  if (isVideo) {
    if (lightboxImg) lightboxImg.classList.add('hidden');
    if (lightboxVideo) {
      lightboxVideo.classList.remove('hidden');
      lightboxVideo.poster = item.thumbnailUrl || '';
      lightboxVideo.src = item.fileUrl;
      lightboxVideo.load();
      lightboxVideo.play().catch(() => {});
    }
  } else {
    if (lightboxVideo) lightboxVideo.classList.add('hidden');
    if (lightboxImg) {
      lightboxImg.classList.remove('hidden');
      lightboxImg.src = item.fileUrl;
    }
  }

  // Badges & Labels
  let badgeText = 'Photo';
  let badgeClass = 'bg-gray-700 text-white';
  if (isStory) {
    badgeText = 'Story (Active)';
    badgeClass = 'bg-purple-600 text-white';
  } else if (isHighlight) {
    badgeText = item.title ? `Highlight: ${item.title}` : 'Highlight';
    badgeClass = 'bg-amber-500 text-black font-extrabold';
  } else if (isSlide) {
    badgeText = item.slideIndex ? `Slide ${item.slideIndex}/${item.totalSlides || ''}` : 'Carousel Slide';
    badgeClass = 'bg-blue-600 text-white';
  } else if (isVideo) {
    badgeText = 'HD Video';
    badgeClass = 'bg-red-600 text-white';
  }

  if (lightboxTypeBadge) {
    lightboxTypeBadge.textContent = badgeText;
    lightboxTypeBadge.className = `px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide shadow-md ${badgeClass}`;
  }

  if (lightboxTargetTitle && currentGalleryTarget) {
    lightboxTargetTitle.textContent = `@${currentGalleryTarget.username}`;
  }

  if (lightboxCounter) {
    lightboxCounter.textContent = `${currentLightboxIndex + 1} of ${total}`;
  }

  if (lightboxCaption) {
    lightboxCaption.textContent = item.caption || item.title || 'Instagram media file';
  }

  if (lightboxTimestamp) {
    const d = item.downloadedAt ? new Date(item.downloadedAt).toLocaleString() : 'Archived';
    lightboxTimestamp.innerHTML = `<i class="fa-regular fa-clock mr-1"></i>${d}`;
  }

  if (lightboxPostCode) {
    if (item.code) {
      lightboxPostCode.innerHTML = `<a href="https://www.instagram.com/p/${escapeHtml(item.code)}/" target="_blank" class="text-pink-400 hover:underline flex items-center space-x-1"><i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i><span>instagram.com/p/${escapeHtml(item.code)}</span></a>`;
    } else {
      lightboxPostCode.innerHTML = '';
    }
  }

  if (lightboxDirectDownloadBtn) {
    lightboxDirectDownloadBtn.href = item.fileUrl;
  }
}

function navigateLightbox(delta) {
  if (!displayedGalleryItems || displayedGalleryItems.length === 0) return;
  const total = displayedGalleryItems.length;
  currentLightboxIndex = (currentLightboxIndex + delta + total) % total;
  renderLightboxItem();
}

function closeLightbox() {
  if (lightboxVideo) {
    lightboxVideo.pause();
    lightboxVideo.src = '';
  }
  if (lightboxModal) {
    lightboxModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }
}

if (lightboxPrevBtn) lightboxPrevBtn.addEventListener('click', () => navigateLightbox(-1));
if (lightboxNextBtn) lightboxNextBtn.addEventListener('click', () => navigateLightbox(1));
if (closeLightboxBtn) closeLightboxBtn.addEventListener('click', closeLightbox);

if (lightboxFullscreenBtn) {
  lightboxFullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      if (lightboxModal.requestFullscreen) lightboxModal.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });
}

// Global Keyboard Navigation for Lightbox & Modal Escapes
window.addEventListener('keydown', (e) => {
  if (lightboxModal && !lightboxModal.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      closeLightbox();
    } else if (e.key === 'ArrowLeft') {
      navigateLightbox(-1);
    } else if (e.key === 'ArrowRight') {
      navigateLightbox(1);
    } else if (e.key === ' ' && lightboxVideo && !lightboxVideo.classList.contains('hidden')) {
      e.preventDefault();
      if (lightboxVideo.paused) {
        lightboxVideo.play();
      } else {
        lightboxVideo.pause();
      }
    }
  }
});

// --- Live IG Session Cookie Health Monitor ---
const sessionHealthBadge = document.getElementById('sessionHealthBadge');
const sessionHealthDot = document.getElementById('sessionHealthDot');
const sessionHealthText = document.getElementById('sessionHealthText');

async function updateSessionHealthBadge() {
  if (!sessionHealthBadge || !sessionHealthDot || !sessionHealthText) return;

  try {
    const res = await fetch('/api/session/status');
    const data = await res.json();

    if (data.configured && data.valid) {
      sessionHealthDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-ping';
      sessionHealthText.textContent = `IG Session: @${data.userId || 'Active'}`;
      sessionHealthBadge.className = 'hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 transition cursor-pointer shadow-sm';
      sessionHealthBadge.title = `Instagram session is authenticated and active. User ID: ${data.userId}. Click to edit.`;
    } else if (data.configured && !data.valid) {
      sessionHealthDot.className = 'w-2 h-2 rounded-full bg-red-400';
      sessionHealthText.textContent = `IG Session: Expired`;
      sessionHealthBadge.className = 'hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition cursor-pointer';
      sessionHealthBadge.title = `Instagram session has expired or requires re-login. Click to update sessionid.`;
    } else {
      sessionHealthDot.className = 'w-2 h-2 rounded-full bg-amber-400';
      sessionHealthText.textContent = `IG Session: Public Mode`;
      sessionHealthBadge.className = 'hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-gray-800 text-gray-400 border border-gray-700 hover:border-amber-400/50 transition cursor-pointer';
      sessionHealthBadge.title = `No session cookie configured. Monitoring public profiles only. Click to add session cookie.`;
    }
  } catch (err) {
    // ignore
  }
}

if (sessionHealthBadge) {
  sessionHealthBadge.addEventListener('click', () => {
    openSettingsBtn.click();
    setTimeout(() => {
      const field = document.getElementById('cfgSessionCookie');
      if (field) field.focus();
    }, 150);
  });
}

function notifyViewingCache(username) {
  if (socket && socket.readyState === WebSocket.OPEN && username) {
    socket.send(JSON.stringify({ type: 'VIEWING_CACHE', username }));
  }
}

// Automatically clean up temporary cache when user leaves the site
window.addEventListener('beforeunload', () => {
  if (activeCacheUsername && navigator.sendBeacon) {
    navigator.sendBeacon('/api/cache/session-cleanup', JSON.stringify({ username: activeCacheUsername }));
  }
});

window.addEventListener('pagehide', () => {
  if (activeCacheUsername && navigator.sendBeacon) {
    navigator.sendBeacon('/api/cache/session-cleanup', JSON.stringify({ username: activeCacheUsername }));
  }
});

// Initialize on Load
window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  updateSessionHealthBadge();
});
