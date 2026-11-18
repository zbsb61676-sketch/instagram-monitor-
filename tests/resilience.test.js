const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/db');
const { MonitorService } = require('../src/monitor');
const { StorageManager } = require('../src/storageManager');
const { escapeHtml, isValidDiscordWebhookUrl, sendWithRetry } = require('../src/notifier');

describe('MonitorService Resilience', () => {
  const tempDirs = [];

  function createEnv(checkFn, extraOpts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mon-svc-'));
    tempDirs.push(dir);
    const db = new Database(path.join(dir, 'db.json'));
    const alerts = [];
    const monitor = new MonitorService({
      db,
      checkFn,
      dispatchTransitionAlert: async (target, from, to) => {
        alerts.push({ username: target.username, from, to });
      },
      downloadTargetContent: async () => ({ downloadedItems: [] }),
      dispatchMediaDownloadedAlert: async () => {},
      dispatchActivityAlert: async () => {},
      ...extraOpts
    });
    return { db, monitor, alerts };
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('preserves pending on initial errors, handles not_found, and fires transition alerts', async () => {
    let seq = [
      { status: 'error', profileInfo: null, error: 'timeout' },
      { status: 'private', profileInfo: { fullName: 'Alice' }, error: null },
      { status: 'rate_limited', profileInfo: null, error: '429' },
      { status: 'public', profileInfo: { fullName: 'Alice' }, error: null },
      { status: 'not_found', profileInfo: null, error: '404' }
    ];
    let idx = 0;
    const { db, monitor, alerts } = createEnv(async () => seq[idx++]);
    const target = db.addTarget('alice', 5);
    assert.equal(typeof monitor.onTargetAdded, 'function');

    // 1. Initial error must NOT falsely mark account as public
    let r = await monitor.checkNow(target.id);
    assert.equal(r.status, 'pending');
    assert.equal(r.connectionStatus, 'error');

    // 2. Confirmed private
    r = await monitor.checkNow(target.id);
    assert.equal(r.status, 'private');
    assert.equal(r.lastKnownPrivacyState, 'private');

    // 3. Transient rate limit preserves private status
    r = await monitor.checkNow(target.id);
    assert.equal(r.status, 'private');
    assert.equal(r.connectionStatus, 'rate_limited');

    // 4. Transition to public fires alert even after transient rate limit
    r = await monitor.checkNow(target.id);
    assert.equal(r.status, 'public');
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0], { username: 'alice', from: 'private', to: 'public' });

    // 5. Account deleted -> not_found
    r = await monitor.checkNow(target.id);
    assert.equal(r.status, 'not_found');
  });

  it('enforces maxConcurrentChecks semaphore and opens circuit breaker on consecutive rate limits', async () => {
    let inFlight = 0;
    let peakInFlight = 0;

    const { db, monitor } = createEnv(
      async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise(r => setTimeout(r, 40));
        inFlight--;
        return { status: 'rate_limited', profileInfo: null, error: '429' };
      },
      { maxConcurrentChecks: 2, circuitThreshold: 3, circuitCooldownMs: 5000 }
    );

    const t1 = db.addTarget('user_one', 10);
    const t2 = db.addTarget('user_two', 10);
    const t3 = db.addTarget('user_three', 10);
    const t4 = db.addTarget('user_four', 10);

    await Promise.all([
      monitor.checkNow(t1.id),
      monitor.checkNow(t2.id),
      monitor.checkNow(t3.id),
      monitor.checkNow(t4.id)
    ]);

    assert.ok(peakInFlight <= 2, `Expected peak concurrency <= 2, got ${peakInFlight}`);
    const diag = monitor.getDiagnostics();
    assert.equal(diag.circuitBreaker.state, 'OPEN');
    assert.ok(diag.circuitBreaker.totalTrips >= 1);
  });
});

describe('StorageManager Quotas & Cache Sweeping', () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('evicts oldest downloads when quota is exceeded and removes expired cache dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mon-store-'));
    tempDirs.push(root);
    const downloadsDir = path.join(root, 'downloads');
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(path.join(downloadsDir, 'u1'), { recursive: true });
    fs.mkdirSync(path.join(cacheDir, 'old_user'), { recursive: true });
    fs.mkdirSync(path.join(cacheDir, 'fresh_user'), { recursive: true });

    const oldFile = path.join(downloadsDir, 'u1', 'old.jpg');
    const newFile = path.join(downloadsDir, 'u1', 'new.jpg');
    fs.writeFileSync(oldFile, Buffer.alloc(600 * 1024));
    fs.writeFileSync(newFile, Buffer.alloc(600 * 1024));
    const past = new Date(Date.now() - 100000);
    fs.utimesSync(oldFile, past, past);

    const oldCacheFile = path.join(cacheDir, 'old_user', 'a.jpg');
    const freshCacheFile = path.join(cacheDir, 'fresh_user', 'b.jpg');
    fs.writeFileSync(oldCacheFile, Buffer.alloc(1024));
    fs.writeFileSync(freshCacheFile, Buffer.alloc(1024));
    const expired = new Date(Date.now() - 120000);
    fs.utimesSync(oldCacheFile, expired, expired);

    const sm = new StorageManager({
      downloadsDir,
      cacheDir,
      maxStorageMb: 1,
      maxCacheAgeMs: 60000
    });

    const { cacheResult, quotaResult } = sm.runMaintenance();
    assert.equal(cacheResult.removedDirs, 1);
    assert.equal(fs.existsSync(path.join(cacheDir, 'old_user')), false);
    assert.equal(fs.existsSync(path.join(cacheDir, 'fresh_user')), true);
    assert.equal(quotaResult.evictedFiles, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
  });
});

describe('Notifier Helpers & Retry Queue', () => {
  it('escapes HTML safely and validates Discord webhook URLs', () => {
    assert.equal(escapeHtml('<script>a & b</script>'), '&lt;script&gt;a &amp; b&lt;/script&gt;');
    assert.equal(isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123/abc'), true);
    assert.equal(isValidDiscordWebhookUrl('https://discordapp.com/api/webhooks/123/abc'), true);
    assert.equal(isValidDiscordWebhookUrl('http://127.0.0.1:3000/api/webhooks/123'), false);
    assert.equal(isValidDiscordWebhookUrl('https://evil.example/api/webhooks/123'), false);
  });

  it('retries transient failures and succeeds on subsequent attempt', async () => {
    let calls = 0;
    const res = await sendWithRetry(
      async () => {
        calls++;
        if (calls < 3) return { success: false, error: 'ETIMEDOUT' };
        return { success: true };
      },
      { maxRetries: 3, baseDelayMs: 10, label: 'unit-test' }
    );
    assert.equal(res.success, true);
    assert.equal(res.attempts, 3);
  });

  it('does not retry permanent 4xx errors', async () => {
    let calls = 0;
    const res = await sendWithRetry(
      async () => {
        calls++;
        return { success: false, error: 'HTTP 401: Unauthorized' };
      },
      { maxRetries: 3, baseDelayMs: 10, label: 'unit-test-401' }
    );
    assert.equal(res.success, false);
    assert.equal(calls, 1);
  });
});
