const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const proxyManager = require('../src/proxyManager');
const { ProxyAgent } = require('undici');
const {
  determinePrivacy,
  extractProfileInfo,
  decodeHtmlEntities,
  isBotChallengePage,
  parseMirrorHtml
} = require('../src/igChecker');

describe('ProxyManager', () => {
  it('parses and rotates multi-line and comma-separated proxies', () => {
    const raw = 'http://p1.example:8080\nhttp://p2.example:8080, https://p3.example:8443';
    const list = proxyManager.parseProxyString(raw);
    assert.deepEqual(list, [
      'http://p1.example:8080',
      'http://p2.example:8080',
      'https://p3.example:8443'
    ]);

    const seen = new Set([
      proxyManager.getNextProxy(raw),
      proxyManager.getNextProxy(raw),
      proxyManager.getNextProxy(raw)
    ]);
    assert.equal(seen.size, 3);
    assert.ok(new ProxyAgent(list[0]));
  });

  it('skips proxies currently in failure cooldown', () => {
    const raw = 'http://bad.example:8080,http://good.example:8080';
    proxyManager.markProxyFailed('http://bad.example:8080', 60);
    assert.equal(proxyManager.getNextProxy(raw), 'http://good.example:8080');
    proxyManager.markProxyHealthy('http://bad.example:8080');
  });
});

describe('IG Checker Parsers & Mirror Safety', () => {
  it('detects private profiles from text markers and embedded JSON', () => {
    assert.equal(determinePrivacy('<div>This Account is Private</div>', 'alice'), true);
    const jsonHtml = '<script type="application/json">{"user":{"username":"alice","is_private":true}}</script>';
    assert.equal(determinePrivacy(jsonHtml, 'alice'), true);
    const publicJsonHtml = '<script type="application/json">{"user":{"username":"alice","is_private":false}}</script>';
    assert.equal(determinePrivacy(publicJsonHtml, 'alice'), false);
  });

  it('extracts profile metadata including userId and latestReelMedia', () => {
    const html = `
      <meta property="og:title" content="Alice Doe (@alice) • Instagram photos and videos" />
      <meta property="og:image" content="https://cdn.example/pic.jpg?a=1&amp;b=2" />
      <meta name="description" content="1.2K Followers, 50 Following, 12 Posts - See Instagram photos and videos from Alice on Instagram: &quot;Hello &amp; welcome&quot;" />
      <script type="application/json">{"user":{"username":"alice","id":"998877","is_verified":true,"latest_reel_media":1700000123}}</script>
    `;
    const info = extractProfileInfo(html, 'alice');
    assert.equal(info.fullName, 'Alice Doe');
    assert.equal(info.profilePicUrl, 'https://cdn.example/pic.jpg?a=1&b=2');
    assert.equal(info.followerCount, '1.2K');
    assert.equal(info.followingCount, '50');
    assert.equal(info.postsCount, 12);
    assert.equal(info.isVerified, true);
    assert.equal(info.userId, '998877');
    assert.equal(info.latestReelMedia, 1700000123);
    assert.equal(decodeHtmlEntities('a &amp; b &#064;c'), 'a & b @c');
  });

  it('rejects Cloudflare / anti-bot challenge pages and generic landing pages on mirrors', () => {
    const cfHtml = '<html><head><title>Just a moment...</title></head><body>cf-browser-verification ' + 'x'.repeat(600) + '</body></html>';
    assert.equal(isBotChallengePage(cfHtml), true);
    assert.equal(parseMirrorHtml(cfHtml, 'alice', 'dumpor'), null);

    // Generic homepage without the target username must be rejected (no false PUBLIC)
    const genericHtml = '<html><head><title>Mirror Home</title></head><body>' + 'welcome '.repeat(100) + '</body></html>';
    assert.equal(parseMirrorHtml(genericHtml, 'alice', 'dumpor'), null);

    // Valid private profile mirror page
    const validPrivate = '<html><head><title>alice • Profile</title></head><body><h1>@alice</h1><p>This account is private</p>' + ' '.repeat(500) + '</body></html>';
    const parsedPrivate = parseMirrorHtml(validPrivate, 'alice', 'dumpor');
    assert.equal(parsedPrivate.status, 'private');
    assert.equal(parsedPrivate.fallbackMirror, 'dumpor');
  });
});
