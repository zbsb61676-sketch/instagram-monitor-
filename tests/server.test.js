const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function startServer(envOverrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mon-srv-'));
  const dbFile = path.join(tempDir, 'db.json');
  const port = 35000 + Math.floor(Math.random() * 10000);

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbFile,
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server boot timeout')), 8000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('is Running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`Server exited early with code ${code}`)));
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    ready,
    async stop() {
      child.kill();
      await new Promise(r => setTimeout(r, 250));
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

describe('Server HTTP, WebSocket & Auth Integration', () => {
  let srv;

  before(async () => {
    srv = startServer({ DASHBOARD_PASSWORD: 'test-secret-password' });
    await srv.ready;
  });

  after(async () => {
    if (srv) await srv.stop();
  });

  it('keeps /health open for cloud probes with diagnostics and security headers', async () => {
    const res = await fetch(`${srv.baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.monitor && body.monitor.circuitBreaker);
    assert.ok(body.storage && typeof body.storage.maxStorageMB === 'number');
  });

  it('enforces DASHBOARD_PASSWORD on REST API and WebSocket connections', async () => {
    const unauth = await fetch(`${srv.baseUrl}/api/status`);
    assert.equal(unauth.status, 401);

    const bearerAuth = await fetch(`${srv.baseUrl}/api/status`, {
      headers: { Authorization: 'Bearer test-secret-password' }
    });
    assert.equal(bearerAuth.status, 200);
    const statusBody = await bearerAuth.json();
    assert.equal(statusBody.authEnabled, true);

    const basicCreds = Buffer.from('admin:test-secret-password').toString('base64');
    const basicAuth = await fetch(`${srv.baseUrl}/api/targets`, {
      headers: { Authorization: `Basic ${basicCreds}` }
    });
    assert.equal(basicAuth.status, 200);

    // Unauthenticated WebSocket should be closed with 1008
    const wsUnauth = new WebSocket(srv.wsUrl);
    const closeCode = await new Promise((resolve) => {
      wsUnauth.on('close', (code) => resolve(code));
    });
    assert.equal(closeCode, 1008);
  });

  it('masks sensitive tokens/cookies in REST and WebSocket and handles CRUD + malformed JSON cleanly', async () => {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret-password'
    };

    // Malformed JSON returns 400 JSON instead of HTML stack trace
    const badJson = await fetch(`${srv.baseUrl}/api/targets`, {
      method: 'POST',
      headers,
      body: '{invalid'
    });
    assert.equal(badJson.status, 400);
    const badJsonBody = await badJson.json();
    assert.match(badJsonBody.error, /Invalid JSON/i);

    // Unknown API route returns 404 JSON
    const notFound = await fetch(`${srv.baseUrl}/api/does-not-exist`, { headers });
    assert.equal(notFound.status, 404);

    // Save secrets and confirm masking on REST & WS INIT
    const putRes = await fetch(`${srv.baseUrl}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        telegramToken: '999888777:SUPER_SECRET_BOT_TOKEN',
        sessionCookie: 'sessionid=secret_ig_cookie_value_12345'
      })
    });
    const settings = await putRes.json();
    assert.equal(putRes.status, 200);
    assert.ok(!settings.telegramToken.includes('SUPER_SECRET'));
    assert.ok(!settings.sessionCookie.includes('secret_ig_cookie'));
    assert.equal(settings.hasTelegramToken, true);
    assert.equal(settings.hasSessionCookie, true);

    const ws = new WebSocket(srv.wsUrl, {
      headers: { Authorization: 'Bearer test-secret-password' }
    });
    const initMsg = await new Promise((resolve, reject) => {
      ws.on('message', (d) => resolve(JSON.parse(d.toString())));
      ws.on('error', reject);
    });
    assert.equal(initMsg.type, 'INIT');
    assert.ok(!initMsg.data.settings.telegramToken.includes('SUPER_SECRET'));
    assert.ok(!initMsg.data.settings.sessionCookie.includes('secret_ig_cookie'));
    ws.close();

    // Verify /api/cache/status/:username responds cleanly
    const statusRes = await fetch(`${srv.baseUrl}/api/cache/status/nonexistent_demo`, { headers });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.status, 'idle');
    assert.equal(statusJson.count, 0);
  });
});
