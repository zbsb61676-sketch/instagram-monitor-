/**
 * Background Monitoring Engine
 * Continuously monitors targets at their specified intervals (e.g. every second).
 */

const db = require('./db');
const { checkInstagramProfile } = require('./igChecker');
const { dispatchTransitionAlert, dispatchMediaDownloadedAlert, dispatchActivityAlert } = require('./notifier');
const { downloadTargetContent } = require('./downloader');

class MonitorService {
  constructor() {
    this.timers = new Map(); // targetId -> NodeJS.Timeout
    this.activeLocks = new Set(); // targetId being actively queried
    this.broadcastFn = null;
    this.isRunning = false;
  }

  setBroadcastFunction(fn) {
    this.broadcastFn = fn;
  }

  broadcast(message) {
    if (typeof this.broadcastFn === 'function') {
      try {
        this.broadcastFn(message);
      } catch (err) {
        console.error('[Monitor] Broadcast error:', err.message);
      }
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Monitor] Starting background monitoring engine...');

    const targets = db.getTargets();
    for (const target of targets) {
      if (target.isMonitoring) {
        this.scheduleTarget(target);
      }
    }
  }

  stop() {
    this.isRunning = false;
    for (const [id, timer] of this.timers.entries()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    console.log('[Monitor] Stopped background monitoring engine.');
  }

  scheduleTarget(target, delayMs = 0) {
    if (!this.isRunning) return;

    // Clear existing timer if any
    if (this.timers.has(target.id)) {
      clearTimeout(this.timers.get(target.id));
      this.timers.delete(target.id);
    }

    if (!target.isMonitoring) return;

    const timer = setTimeout(async () => {
      await this.executeCheck(target.id);
    }, delayMs);

    this.timers.set(target.id, timer);
  }

  async executeCheck(targetId, options = {}) {
    if (!this.isRunning && !options.force) return;

    // Concurrency lock per target
    if (this.activeLocks.has(targetId) && !options.force) return;
    this.activeLocks.add(targetId);

    const target = db.getTarget(targetId);
    if (!target || (!target.isMonitoring && !options.force)) {
      this.activeLocks.delete(targetId);
      return;
    }

    const settings = db.getSettings();

    try {
      // Routine monitoring checks are ALWAYS 100% anonymous to guarantee
      // the user's account is NEVER challenged, flagged, or suspended.
      const result = await checkInstagramProfile(target.username, {
        proxyUrl: settings.proxyUrl
      });

      const now = new Date().toISOString();
      const previousStatus = target.status;
      const newStatus = result.status;

      let consecutiveErrors = target.consecutiveErrors || 0;
      if (newStatus === 'error' || newStatus === 'rate_limited') {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }

      // Target privacy status is strictly PUBLIC or PRIVATE.
      // Transient network glitches or rate limits NEVER corrupt a target's privacy state!
      let effectiveStatus = target.status;
      if (newStatus === 'public' || newStatus === 'private') {
        effectiveStatus = newStatus;
      } else {
        effectiveStatus = target.lastKnownPrivacyState || (target.status !== 'error' && target.status !== 'rate_limited' ? target.status : null) || 'public';
      }

      const updates = {
        lastCheckedAt: now,
        consecutiveErrors,
        status: effectiveStatus,
        connectionStatus: (newStatus === 'rate_limited') ? 'rate_limited' : (newStatus === 'error' ? 'error' : 'healthy')
      };

      if (result.error) {
        updates.lastError = result.error;
      }

      if (result.profileInfo) {
        updates.profileInfo = {
          fullName: result.profileInfo.fullName || target.profileInfo?.fullName || '',
          isVerified: result.profileInfo.isVerified ?? target.profileInfo?.isVerified ?? false,
          biography: result.profileInfo.biography || target.profileInfo?.biography || '',
          profilePicUrl: result.profileInfo.profilePicUrl || target.profileInfo?.profilePicUrl || ''
        };
      }

      // Track lastKnownPrivacyState independently so transient error or rate-limit
      // never breaks Public <-> Private transition detection!
      const priorPrivacyState = target.lastKnownPrivacyState || (
        previousStatus === 'public' || previousStatus === 'private' ? previousStatus : null
      );

      if (newStatus === 'public' || newStatus === 'private') {
        updates.lastKnownPrivacyState = newStatus;

        if (priorPrivacyState && priorPrivacyState !== newStatus) {
          updates.previousStatus = priorPrivacyState;
          updates.lastChangedAt = now;

          db.addLog(
            `Status changed for @${target.username}: ${priorPrivacyState.toUpperCase()} ➔ ${newStatus.toUpperCase()}`,
            newStatus === 'public' ? 'alert' : 'warning',
            target.username
          );

          const isPrivateToPublic = (priorPrivacyState === 'private' && newStatus === 'public');
          const isPublicToPrivate = (priorPrivacyState === 'public' && newStatus === 'private');

          // TRANSITION ALERTS: Triggers for BOTH Private -> Public AND Public -> Private!
          if (isPrivateToPublic || isPublicToPrivate) {
            const updatedTargetObj = { ...target, ...updates };
            await dispatchTransitionAlert(
              updatedTargetObj,
              priorPrivacyState,
              newStatus,
              settings,
              db,
              this.broadcast.bind(this)
            );

            // AUTO-DOWNLOAD: Trigger automatic download of all available content when transitioning to public
            if (isPrivateToPublic && settings.autoDownloadOnPublic !== false) {
              downloadTargetContent(target.username, {
                proxyUrl: settings.proxyUrl,
                sessionCookie: settings.sessionCookie
              }).then(async dlSummary => {
                this.broadcast({
                  type: 'MEDIA_DOWNLOADED',
                  data: {
                    username: target.username,
                    summary: dlSummary
                  }
                });

                // Send downloaded photos directly to Telegram and Discord
                if (dlSummary.downloadedItems && dlSummary.downloadedItems.length > 0) {
                  await dispatchMediaDownloadedAlert(target.username, dlSummary.downloadedItems, settings, db);
                }
              }).catch(dlErr => {
                console.error(`[Downloader] Auto-download error for @${target.username}:`, dlErr.message);
              });
            }
          }
        }
      } else {
        // If error / rate-limited, preserve prior lastKnownPrivacyState
        if (target.lastKnownPrivacyState) {
          updates.lastKnownPrivacyState = target.lastKnownPrivacyState;
        }
      }

      // --- ACTIVITY DETECTOR (New Story, New Post, Bio Change) ---
      if (newStatus === 'public') {
        // 1. Detect New Active Story
        if (result.profileInfo?.latestReelMedia) {
          const currentReel = result.profileInfo.latestReelMedia;
          if (target.lastSeenReelMedia && currentReel > target.lastSeenReelMedia) {
            await dispatchActivityAlert('NEW_STORY', { username: target.username }, settings, db, this.broadcast.bind(this));
            if (settings.autoDownloadOnPublic !== false) {
              downloadTargetContent(target.username, {
                proxyUrl: settings.proxyUrl,
                sessionCookie: settings.sessionCookie
              }).catch(() => {});
            }
          }
          updates.lastSeenReelMedia = currentReel;
        }

        // 2. Detect New Post Upload
        if (result.profileInfo?.postCodes && result.profileInfo.postCodes.length > 0) {
          const latestCode = result.profileInfo.postCodes[0];
          if (target.lastSeenPostCode && latestCode !== target.lastSeenPostCode) {
            await dispatchActivityAlert('NEW_POST', { username: target.username, postCode: latestCode }, settings, db, this.broadcast.bind(this));
            if (settings.autoDownloadOnPublic !== false) {
              downloadTargetContent(target.username, {
                proxyUrl: settings.proxyUrl,
                sessionCookie: settings.sessionCookie
              }).catch(() => {});
            }
          }
          updates.lastSeenPostCode = latestCode;
          updates.postsCount = result.profileInfo.postsCount;
        }

        // 3. Detect Biography Change
        if (result.profileInfo?.biography !== undefined) {
          const oldBio = target.profileInfo?.biography;
          const newBio = result.profileInfo.biography;
          if (oldBio && newBio && oldBio !== newBio) {
            await dispatchActivityAlert('BIO_CHANGED', { username: target.username, oldBio, newBio }, settings, db, this.broadcast.bind(this));
          }
        }
      }

      // If rate limited, log warning occasionally
      if (newStatus === 'rate_limited' && consecutiveErrors % 10 === 1) {
        db.addLog(
          `Instagram rate-limit encountered for @${target.username}. Consider adding a proxy in Settings.`,
          'warning',
          target.username
        );
      }

      const updatedTarget = db.updateTarget(target.id, updates);

      // Broadcast update to WebSocket clients
      this.broadcast({
        type: 'TARGET_UPDATED',
        data: updatedTarget
      });

    } catch (err) {
      console.error(`[Monitor] Error checking @${target.username}:`, err.message);
      db.updateTarget(target.id, {
        lastCheckedAt: new Date().toISOString(),
        consecutiveErrors: (target.consecutiveErrors || 0) + 1,
        status: target.lastKnownPrivacyState || 'public',
        lastError: err.message
      });
    } finally {
      this.activeLocks.delete(targetId);

      // Re-schedule next run based on intervalSec with adaptive rate-limit backoff & jitter
      const latestTarget = db.getTarget(targetId);
      if (latestTarget && latestTarget.isMonitoring && this.isRunning) {
        let intervalMs = Math.max(1000, (latestTarget.intervalSec || 3) * 1000);

        // Adaptive Backoff on Instagram Rate-Limits to prevent prolonged IP bans
        if (latestTarget.status === 'rate_limited') {
          const errCount = latestTarget.consecutiveErrors || 1;
          // Progressive backoff: 30s -> 60s -> 120s max
          const backoffSec = Math.min(120, 30 * Math.pow(2, Math.min(errCount - 1, 2)));
          intervalMs = backoffSec * 1000;
        } else if (latestTarget.status === 'error' && (latestTarget.consecutiveErrors || 0) >= 3) {
          intervalMs = Math.max(intervalMs, 10000); // 10s cooldown on persistent network errors
        }

        // Add small jitter (up to 500ms) to prevent multi-target thundering herd
        const jitter = Math.floor(Math.random() * 500);
        this.scheduleTarget(latestTarget, intervalMs + jitter);
      }
    }
  }

  /**
   * Manually trigger check right now for a target
   */
  async checkNow(targetId) {
    const target = db.getTarget(targetId);
    if (!target) throw new Error('Target not found');

    // Clear active lock to ensure manual user check runs immediately
    this.activeLocks.delete(targetId);
    await this.executeCheck(targetId, { force: true });
    return db.getTarget(targetId);
  }

  /**
   * Called when a target is added or updated
   */
  onTargetUpdated(target) {
    if (target.isMonitoring) {
      this.scheduleTarget(target, 0); // Check immediately
    } else {
      if (this.timers.has(target.id)) {
        clearTimeout(this.timers.get(target.id));
        this.timers.delete(target.id);
      }
    }
  }

  onTargetDeleted(targetId) {
    if (this.timers.has(targetId)) {
      clearTimeout(this.timers.get(targetId));
      this.timers.delete(targetId);
    }
    this.activeLocks.delete(targetId);
  }
}

module.exports = new MonitorService();
