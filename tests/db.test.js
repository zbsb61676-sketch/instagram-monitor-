const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database, validateUsername } = require('../src/db');

describe('Database & Backup Recovery', () => {
  const tempDirs = [];

  function createTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-mon-db-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'db.json');
    return { dir, dbPath, db: new Database(dbPath) };
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates Instagram usernames strictly', () => {
    assert.equal(validateUsername(' @Test.User_1 '), 'test.user_1');
    assert.throws(() => validateUsername(''), /empty/i);
    assert.throws(() => validateUsername('../etc/passwd'), /invalid/i);
    assert.throws(() => validateUsername('a'.repeat(31)), /30 characters/i);
    assert.throws(() => validateUsername('bad..name'), /invalid/i);
  });

  it('performs target CRUD and safely handles non-numeric intervalSec', () => {
    const { db } = createTempDb();
    const t = db.addTarget('@Sample_User', 'not_a_number');
    assert.equal(t.username, 'sample_user');
    assert.ok(Number.isFinite(t.intervalSec) && t.intervalSec >= 1);

    assert.equal(db.getTarget(t.id).username, 'sample_user');
    assert.equal(db.getTarget('sample_user').id, t.id);
    assert.equal(db.getTarget(null), null);

    const toggled = db.toggleTargetMonitoring(t.id);
    assert.equal(toggled.isMonitoring, false);
    assert.equal(toggled.downloadedCount, 0);

    assert.equal(db.deleteTarget(t.id), true);
    assert.equal(db.getTargets().length, 0);
  });

  it('automatically recovers from rolling .bak backup if primary db.json is corrupted', () => {
    const { dbPath, db } = createTempDb();
    db.addTarget('persisted_user', 5);
    db.flushSync();
    // Second flush creates the rolling .bak of valid JSON containing persisted_user
    db.updateSettings({ defaultIntervalSec: 7 });
    db.flushSync();

    assert.ok(fs.existsSync(`${dbPath}.bak`), 'Expected rolling .bak file to exist');

    // Corrupt the primary db.json file
    fs.writeFileSync(dbPath, '{ corrupted json !!!', 'utf-8');

    const recoveredDb = new Database(dbPath);
    assert.equal(recoveredDb.recoveredFromBackup, true);
    assert.ok(recoveredDb.getTarget('persisted_user'), 'Target should be recovered from .bak');
  });
});
