/**
 * Background Monitoring Engine
 * Continuously monitors targets at their specified intervals (e.g. every second).
 */

const config = require('./config');
const db = require('./db');
const { checkInstagramProfile } = require('./igChecker');
const { dispatchTransitionAlert, dispatchMediaDownloadedAlert, dispatchActivityAlert } = require('./notifier');
const { downloadTargetContent } = require('./downloader');

class MonitorService {
  constructor(deps = {}) {
    this.db = deps.db || db;
    this.checkFn = deps.checkFn || checkInstagramProfile;
    this.dispatchTransitionAlertFn = deps.dispatchTransitionAlert || dispatchTransitionAlert;
    this.dispatchMediaDownloadedAlertFn = deps.dispatchMediaDownloadedAlert || dispatchMediaDownloadedAlert;
    this.dispatchActivityAlertFn = deps.dispatchActivityAlert || dispatchActivityAlert;
    this.downloadTargetContentFn = deps.downloadTargetContent || downloadTargetContent;

    this.timers = new Map(); // targetId -> NodeJS.Timeout
    this.activeLocks = new Set(); // targetId being actively queried
    this.broadcastFn = null;
    this.isRunning = false;

    // Global concurrency semaphore
    this.maxConcurrentChecks = deps.maxConcurrentChecks || config.MAX_CONCURRENT_CHECKS || 3;
    this.activeCheckSlots = 0;
    this.waitQueue = [];

    // Global rate-limit circuit breaker
    this.circuitThreshold = deps.circuitThreshold || config.CIRCUIT_BREAKER_THRESHOLD || 5;
    this.circuitCooldownMs = deps.circuitCooldownMs || config.CIRCUIT_BREAKER_COOLDOWN_MS || 60000;
    this.consecutiveGlobalRateLimits = 0;
    this.circuitOpenUntil = 0;
    this.circuitTrips = 0;
  }

  acquireSlot() {
    if (this.activeCheckSlots < this.maxConcurrentChecks) {
      this.activeCheckSlots++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  releaseSlot() {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next();
    } else {
      this.activeCheckSlots = Math.max(0, this.activeCheckSlots - 1);
    }
  }

  isCircuitOpen() {
    return Date.now() < this.circuitOpenUntil;
  }

  recordGlobalRateLimit() {
    this.consecutiveGlobalRateLimits++;
    if (this.consecutiveGlobalRateLimits >= this.circuitThreshold && !this.isCircuitOpen()) {
      this.circuitOpenUntil = Date.now() + this.circuitCooldownMs;
      this.circuitTrips++;
      const cooldownSec = Math.round(this.circuitCooldownMs / 1000);
      console.warn(`[Monitor] Circuit breaker OPEN after ${this.consecutiveGlobalRateLimits} consecutive rate limits. Cooling down for ${cooldownSec}s.`);
      this.db.addLog(
        `Circuit breaker triggered after ${this.consecutiveGlobalRateLimits} consecutive rate limits. Pausing background checks for ${cooldownSec}s to protect IP.`,
        'warning'
      );
    }
  }

  resetCircuitBreaker() {
    if (this.consecutiveGlobalRateLimits > 0 || this.circuitOpenUntil > 0) {
      this.consecutiveGlobalRateLimits = 0;
      this.circuitOpenUntil = 0;
    }
  }

  getDiagnostics() {
    const now = Date.now();
    return {
      isRunning: this.isRunning,
      activeChecks: this.activeCheckSlots,
      queuedChecks: this.waitQueue.length,
      maxConcurrentChecks: this.maxConcurrentChecks,
      scheduledTargets: this.timers.size,
      circuitBreaker: {
        state: now < this.circuitOpenUntil ? 'OPEN' : 'CLOSED',
        consecutiveRateLimits: this.consecutiveGlobalRateLimits,
        threshold: this.circuitThreshold,
        remainingCooldownSec: now < this.circuitOpenUntil ? Math.ceil((this.circuitOpenUntil - now) / 1000) : 0,
        totalTrips: this.circuitTrips
      }
    };
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

    const targets = this.db.getTargets();
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
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.timers.set(target.id, timer);
  }

  async executeCheck(targetId, options = {}) {
    if (!this.isRunning && !options.force) return;

    // Respect circuit breaker for routine background checks (manual force checks bypass it)
    if (!options.force && this.isCircuitOpen()) {
      const latestTarget = this.db.getTarget(targetId);
      if (latestTarget && latestTarget.isMonitoring && this.isRunning) {
        const remainingMs = Math.max(1000, this.circuitOpenUntil - Date.now());
        this.scheduleTarget(latestTarget, remainingMs + Math.floor(Math.random() * 1000));
      }
      return;
    }

    // Concurrency lock per target
    if (this.activeLocks.has(targetId) && !options.force) return;
    this.activeLocks.add(targetId);

    const target = this.db.getTarget(targetId);
    if (!target || (!target.isMonitoring && !options.force)) {
      this.activeLocks.delete(targetId);
      return;
    }

    const settings = this.db.getSettings();
    let slotAcquired = false;

    try {
      await this.acquireSlot();
      slotAcquired = true;

      const t0 = Date.now();
      // Routine monitoring checks are ALWAYS 100% anonymous to guarantee
      // the user's account is NEVER challenged, flagged, or suspended.
      const result = await this.checkFn(target.username, {
        proxyUrl: settings.proxyUrl
      });
      const latencyMs = typeof result.latencyMs === 'number' ? result.latencyMs : (Date.now() - t0);

      const now = new Date().toISOString();
      const previousStatus = target.status;
      const newStatus = result.status;

      let consecutiveErrors = target.consecutiveErrors || 0;
      const totalChecks = (target.totalChecks || 0) + 1;
      let successfulChecks = target.successfulChecks || 0;

      if (newStatus === 'error' || newStatus === 'rate_limited') {
        consecutiveErrors++;
        if (newStatus === 'rate_limited') {
          this.recordGlobalRateLimit();
        }
      } else {
        consecutiveErrors = 0;
        successfulChecks++;
        this.resetCircuitBreaker();
      }

      const prevAvg = typeof target.avgLatencyMs === 'number' ? target.avgLatencyMs : latencyMs;
      const avgLatencyMs = Math.round((prevAvg * 0.7) + (latencyMs * 0.3));

      // Target privacy status preserves last known PUBLIC/PRIVATE state across transient errors/rate limits.
      let effectiveStatus = target.status;
      if (newStatus === 'public' || newStatus === 'private' || newStatus === 'not_found') {
        effectiveStatus = newStatus;
      } else {
        effectiveStatus = target.lastKnownPrivacyState ||
          (target.status === 'public' || target.status === 'private' ? target.status : 'pending');
      }

      const updates = {
        lastCheckedAt: now,
        consecutiveErrors,
        totalChecks,
        successfulChecks,
        avgLatencyMs,
        status: effectiveStatus,
        connectionStatus: (newStatus === 'rate_limited') ? 'rate_limited' : (newStatus === 'error' ? 'error' : 'healthy')
      };

      if (newStatus !== 'error' && newStatus !== 'rate_limited') {
        updates.lastSuccessAt = now;
      }

      if (result.error) {
        updates.lastError = result.error;
      } else {
        updates.lastError = null;
      }

      if (result.profileInfo) {
        updates.profileInfo = {
          fullName: result.profileInfo.fullName || target.profileInfo?.fullName || '',
          isVerified: result.profileInfo.isVerified ?? target.profileInfo?.isVerified ?? false,
          biography: result.profileInfo.biography || target.profileInfo?.biography || '',
          profilePicUrl: result.profileInfo.profilePicUrl || target.profileInfo?.profilePicUrl || '',
          userId: result.profileInfo.userId || target.profileInfo?.userId || null,
          latestReelMedia: result.profileInfo.latestReelMedia || target.profileInfo?.latestReelMedia || null
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

          this.db.addLog(
            `Status changed for @${target.username}: ${priorPrivacyState.toUpperCase()} ➔ ${newStatus.toUpperCase()}`,
            newStatus === 'public' ? 'alert' : 'warning',
            target.username
          );

          const isPrivateToPublic = (priorPrivacyState === 'private' && newStatus === 'public');
          const isPublicToPrivate = (priorPrivacyState === 'public' && newStatus === 'private');

          // TRANSITION ALERTS: Triggers for BOTH Private -> Public AND Public -> Private!
          if (isPrivateToPublic || isPublicToPrivate) {
            const updatedTargetObj = { ...target, ...updates };
            await this.dispatchTransitionAlertFn(
              updatedTargetObj,
              priorPrivacyState,
              newStatus,
              settings,
              this.db,
              this.broadcast.bind(this)
            );

            // AUTO-DOWNLOAD: Trigger automatic download of all available content when transitioning to public
            if (isPrivateToPublic && settings.autoDownloadOnPublic !== false) {
              this.downloadTargetContentFn(target.username, {
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
                  await this.dispatchMediaDownloadedAlertFn(target.username, dlSummary.downloadedItems, settings, this.db);
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
            await this.dispatchActivityAlertFn('NEW_STORY', { username: target.username }, settings, this.db, this.broadcast.bind(this));
            if (settings.autoDownloadOnPublic !== false) {
              this.downloadTargetContentFn(target.username, {
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
            await this.dispatchActivityAlertFn('NEW_POST', { username: target.username, postCode: latestCode }, settings, this.db, this.broadcast.bind(this));
            if (settings.autoDownloadOnPublic !== false) {
              this.downloadTargetContentFn(target.username, {
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
            await this.dispatchActivityAlertFn('BIO_CHANGED', { username: target.username, oldBio, newBio }, settings, this.db, this.broadcast.bind(this));
          }
        }
      }

      // If rate limited, log warning occasionally
      if (newStatus === 'rate_limited' && consecutiveErrors % 10 === 1) {
        this.db.addLog(
          `Instagram rate-limit encountered for @${target.username}. Consider adding a proxy in Settings.`,
          'warning',
          target.username
        );
      }

      const updatedTarget = this.db.updateTarget(target.id, updates);

      // Broadcast update to WebSocket clients
      this.broadcast({
        type: 'TARGET_UPDATED',
        data: updatedTarget
      });

    } catch (err) {
      console.error(`[Monitor] Error checking @${target.username}:`, err.message);
      const fallbackStatus = target.lastKnownPrivacyState ||
        (target.status === 'public' || target.status === 'private' ? target.status : 'pending');
      const erroredTarget = this.db.updateTarget(target.id, {
        lastCheckedAt: new Date().toISOString(),
        consecutiveErrors: (target.consecutiveErrors || 0) + 1,
        totalChecks: (target.totalChecks || 0) + 1,
        status: fallbackStatus,
        connectionStatus: 'error',
        lastError: err.message
      });
      if (erroredTarget) {
        this.broadcast({
          type: 'TARGET_UPDATED',
          data: erroredTarget
        });
      }
    } finally {
      if (slotAcquired) {
        this.releaseSlot();
      }
      this.activeLocks.delete(targetId);

      // Re-schedule next run based on intervalSec with adaptive rate-limit backoff & jitter
      const latestTarget = this.db.getTarget(targetId);
      if (latestTarget && latestTarget.isMonitoring && this.isRunning) {
        let intervalMs = Math.max(1000, (latestTarget.intervalSec || 3) * 1000);

        // Adaptive Backoff on Instagram Rate-Limits to prevent prolonged IP bans
        if (latestTarget.connectionStatus === 'rate_limited' || latestTarget.status === 'rate_limited') {
          const errCount = latestTarget.consecutiveErrors || 1;
          // Progressive backoff: 30s -> 60s -> 120s max
          const backoffSec = Math.min(120, 30 * Math.pow(2, Math.min(errCount - 1, 2)));
          intervalMs = backoffSec * 1000;
        } else if ((latestTarget.connectionStatus === 'error' || latestTarget.status === 'error') && (latestTarget.consecutiveErrors || 0) >= 3) {
          intervalMs = Math.max(intervalMs, 10000); // 10s cooldown on persistent network errors
        }

        // Respect circuit breaker cooldown if open
        if (this.isCircuitOpen()) {
          intervalMs = Math.max(intervalMs, this.circuitOpenUntil - Date.now());
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
    const target = this.db.getTarget(targetId);
    if (!target) throw new Error('Target not found');

    // Clear active lock to ensure manual user check runs immediately
    this.activeLocks.delete(target.id);
    await this.executeCheck(target.id, { force: true });
    return this.db.getEnrichedTarget(target.id);
  }

  /**
   * Called when a new target is added
   */
  onTargetAdded(target) {
    this.onTargetUpdated(target);
  }

  /**
   * Called when a target is added or updated
   */
  onTargetUpdated(target) {
    if (!target) return;
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

const monitorInstance = new MonitorService();
monitorInstance.MonitorService = MonitorService;
module.exports = monitorInstance;
