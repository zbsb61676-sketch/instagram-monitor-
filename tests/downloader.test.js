const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadFile, runWithConcurrency } = require('../src/downloader');
const { CacheManager } = require('../src/cacheManager');

describe('High-Speed Streaming Downloader & Temporary Cache', () => {
  let mockServer;
  let baseUrl;
  let tempRoot;
  let flakyHits = 0;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mon-dl-'));
    mockServer = http.createServer((req, res) => {
      if (req.url === '/ok.jpg') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(Buffer.alloc(4096, 0xab));
      } else if (req.url === '/flaky.jpg') {
        flakyHits++;
        if (flakyHits === 1) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('temporary overload');
        } else {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(Buffer.alloc(2048, 0xcd));
        }
      } else if (req.url === '/html-error') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Login required</body></html>');
      } else if (req.url.startsWith('/slow/')) {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(Buffer.alloc(2048, 0xef));
        }, 60);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve));
    }
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('streams files atomically without leaving .tmp artifacts', async () => {
    const dest = path.join(tempRoot, 'atomic', 'ok.jpg');
    const ok = await downloadFile(`${baseUrl}/ok.jpg`, dest, { force: true });
    assert.equal(ok, true);
    assert.equal(fs.statSync(dest).size, 4096);
    const leftovers = fs.readdirSync(path.dirname(dest)).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('retries transient HTTP 503 errors automatically and succeeds', async () => {
    flakyHits = 0;
    const dest = path.join(tempRoot, 'retry', 'flaky.jpg');
    const ok = await downloadFile(`${baseUrl}/flaky.jpg`, dest, { force: true, maxRetries: 2 });
    assert.equal(ok, true);
    assert.equal(flakyHits, 2);
    assert.equal(fs.statSync(dest).size, 2048);
  });

  it('rejects HTML error pages and cleans up temp files immediately', async () => {
    const dir = path.join(tempRoot, 'html');
    const dest = path.join(dir, 'bad.jpg');
    await assert.rejects(
      () => downloadFile(`${baseUrl}/html-error`, dest, { force: true }),
      /Unexpected HTML response/i
    );
    assert.equal(fs.existsSync(dest), false);
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('downloads multiple files concurrently with bounded parallelism for major speedup', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `${baseUrl}/slow/${i}.jpg`);
    let active = 0;
    let peak = 0;
    const t0 = Date.now();

    await runWithConcurrency(urls, 6, async (u, idx) => {
      active++;
      peak = Math.max(peak, active);
      try {
        const dest = path.join(tempRoot, 'parallel', `${idx}.jpg`);
        await downloadFile(u, dest, { force: true });
      } finally {
        active--;
      }
    });

    const elapsed = Date.now() - t0;
    assert.ok(peak <= 6, `Concurrency exceeded limit: ${peak}`);
    assert.ok(peak >= 2, `Expected concurrent execution, got peak ${peak}`);
    // 12 x 60ms sequentially would take >= 720ms; at concurrency 6 it finishes around ~120-250ms
    assert.ok(elapsed < 550, `Expected parallel speedup (<550ms), took ${elapsed}ms`);
  });

  it('manages temporary cache items with atomic index flushes and batch deletion', () => {
    const cacheDir = path.join(tempRoot, 'temp-cache');
    const cm = new CacheManager(cacheDir);
    const userDir = cm.getUserCacheDir('tempuser');
    const f1 = path.join(userDir, 'posts', 'a.jpg');
    const f2 = path.join(userDir, 'posts', 'b.jpg');
    fs.writeFileSync(f1, Buffer.alloc(1500, 1));
    fs.writeFileSync(f2, Buffer.alloc(1500, 2));

    cm.recordCachedItem('tempuser', { id: '1', fileName: 'a.jpg', filePath: f1 });
    cm.recordCachedItem('tempuser', { id: '2', fileName: 'b.jpg', filePath: f2 });
    cm.flushUserIndex('tempuser');

    assert.equal(cm.getCachedItems('tempuser').length, 2);
    assert.ok(fs.existsSync(path.join(userDir, 'index.json')));

    // Batch-delete item 1 and verify file is unlinked
    const deleted = cm.deleteCachedItems('tempuser', ['1']);
    assert.deepEqual(deleted, ['1']);
    assert.equal(fs.existsSync(f1), false);
    assert.equal(fs.existsSync(f2), true);
    assert.equal(cm.getCachedItems('tempuser').length, 1);

    // Deleting the last item cleans up the entire user temporary folder
    cm.deleteCachedItems('tempuser', ['2']);
    assert.equal(fs.existsSync(userDir), false);
  });
});
