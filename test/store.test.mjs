// #399: the daemon's store (bin/lib/store.mjs), on node:sqlite in a temporary folder. No socket, no process.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openStore } from '../bin/lib/store.mjs';

const temp = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a new database is made at mode 0600 with piggery\'s settings and the latest schema', () =>
  temp((dir) => {
    const file = join(dir, 'state', 'factory.db');
    const store = openStore(file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.settings(), { journal_mode: 'wal', busy_timeout: 5000, foreign_keys: 1, synchronous: 2 });
    assert.equal(store.version(), MIGRATIONS.length);
    store.close();
  }));

test('the offset and the posts survive a reopen, and a post is settled by its id', () =>
  temp((dir) => {
    const file = join(dir, 'factory.db');
    let store = openStore(file);
    assert.equal(store.offset('sessions.jsonl'), 0);
    store.setOffset('sessions.jsonl', 1234);
    const id = store.post({ verb: 'seat-ended', run: '/r/app-1', tag: 'w1', session: 's1', at: 1000 });
    const other = store.post({ verb: 'found', run: '/r/app-2', tag: 'w2', at: 1001 });
    store.settle(id, { wokeAt: 1500, seq: 7 });
    store.settle(other, { why: 'no file' });
    store.close();
    store = openStore(file);
    assert.equal(store.offset('sessions.jsonl'), 1234);
    store.setOffset('sessions.jsonl', 2000);
    assert.equal(store.offset('sessions.jsonl'), 2000);
    assert.deepEqual(store.posts(), [
      { id, arrived_at: 1000, verb: 'seat-ended', run: '/r/app-1', tag: 'w1', session: 's1', woke_at: 1500, why: null, seq: 7 },
      { id: other, arrived_at: 1001, verb: 'found', run: '/r/app-2', tag: 'w2', session: null, woke_at: null, why: 'no file', seq: null },
    ]);
    store.close();
  }));

test('a migration is one transaction a step: a failing step leaves the version and the tables as they were, after a backup', () =>
  temp((dir) => {
    const file = join(dir, 'factory.db');
    openStore(file).close();
    const bad = [...MIGRATIONS, 'CREATE TABLE extra (a INTEGER); INSERT INTO nowhere VALUES (1);'];
    assert.throws(() => openStore(file, { migrations: bad }), /migrate to v2/);
    const db = new DatabaseSync(file);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '1');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='extra'").get().n, 0, 'half a step stayed');
    db.close();
    assert.equal(readdirSync(join(dir, 'backups')).filter((n) => /^pre-v1-2-\d{4}-\d{2}-\d{2}\.db$/.test(n)).length, 1);
  }));

test('a good new step is applied once, keeps the rows, and only the newest three backups stay', () =>
  temp((dir) => {
    const file = join(dir, 'factory.db');
    let store = openStore(file);
    store.post({ verb: 'seat-ended', run: '/r', tag: 't' });
    store.close();
    let migrations = MIGRATIONS;
    for (let n = 0; n < 5; n += 1) {
      migrations = [...migrations, `CREATE TABLE step${n} (a INTEGER)`];
      store = openStore(file, { migrations });
      assert.equal(store.version(), migrations.length);
      assert.equal(store.posts().length, 1);
      store.close();
    }
    assert.equal(readdirSync(join(dir, 'backups')).length, 3);
    // Opening at the same version makes no backup and no change.
    openStore(file, { migrations }).close();
    assert.equal(readdirSync(join(dir, 'backups')).length, 3);
  }));

test('a database of a newer version than the code, or with a damaged one, is refused', () =>
  temp((dir) => {
    const file = join(dir, 'factory.db');
    openStore(file).close();
    const db = new DatabaseSync(file);
    db.exec("UPDATE meta SET value='99' WHERE key='schema_version'");
    db.close();
    assert.throws(() => openStore(file), /unsupported schema version "99"/);
    writeFileSync(join(dir, 'junk.db'), 'this is not a database, and it is long enough to have a header'.repeat(80));
    assert.throws(() => openStore(join(dir, 'junk.db')));
  }));
