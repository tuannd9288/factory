// #399: the daemon's logic with no socket and no process: the verbs through handleLine, reconcile from fixture files, the seat wake that the
// pass and the daemon share, and the job's start of the daemon with an injected ping and spawn.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codeMoved, handleLine, leaseExpired, reconcile } from '../bin/lib/daemon.mjs';
import { readLines } from '../bin/lib/events.mjs';
import { wakeOnSeatEnds, wakeOnSeats } from '../bin/lib/news-wake.mjs';
import { takeLock } from '../bin/lib/lock.mjs';
import { ensureDaemon } from '../bin/lib/queue.mjs';
import { openStore } from '../bin/lib/store.mjs';

/** A state folder and a runs folder, with a Lead `app-lead` whose socket file names a path, and a daemon record `d` over them. `posts` collects the wakes. */
function world(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-'));
  try {
    const state = join(dir, 'state');
    const runs = join(dir, 'runs');
    mkdirSync(state);
    mkdirSync(join(runs, 'app-lead'), { recursive: true });
    writeFileSync(join(runs, 'app-lead/socket'), `${join(dir, 'lead.sock')}\n`);
    const posts = [];
    const logs = [];
    const post = (file, line) => (posts.push({ file, line: JSON.parse(line).message.content }), { posted: true });
    const store = openStore(join(state, 'factory.db'));
    const d = { state, runs, store, post, log: (l) => logs.push(l), lock: { start: null }, held: null, passes: 0, passing: false, startedAt: 'now' };
    const seats = (...records) => appendFileSync(join(state, 'sessions.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const baseline = (count = 0) => writeFileSync(join(state, 'queue-seats.news'), JSON.stringify({ count, gone: {}, told: [] }));
    try {
      return body({ dir, state, runs, posts, logs, d, store, seats, baseline });
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const record = (tag, extra = {}) => ({ role: 'worker', tag, run: '/runs/app-7', team: 'app-lead', session: `s-${tag}`, end: new Date().toISOString(), structured: { conclusion: 'done' }, ...extra });
const ended = (run, tag) => JSON.stringify({ id: '1', verb: 'seat-ended', run, tag, session: `s-${tag}` });

test('a seat end posted to the daemon wakes its Lead once, and neither the next pass nor a restart wakes it again', () =>
  world(({ state, runs, posts, d, store, seats, baseline }) => {
    baseline();
    seats(record('w1'));
    const { response, after } = handleLine(d, ended('/runs/app-7', 'w1'));
    assert.equal(response.ok, true);
    assert.equal(response.id, '1');
    assert.equal(posts.length, 0, 'the answer is given before the work');
    after();
    assert.equal(posts.length, 1);
    assert.match(posts[0].line, /seat-ended: worker w1 ended; read \/runs\/app-7\/run-w1\.jsonl\./);
    const lines = readLines(state).filter((e) => e.kind === 'seat-ended');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].woke, true);
    assert.equal(lines[0].lead, 'app-lead');
    const [row] = store.posts();
    assert.equal(row.verb, 'seat-ended');
    assert.equal(row.seq, lines[0].seq);
    assert.ok(row.woke_at >= row.arrived_at && row.why === null);
    // The pass finds nothing new, and neither does a second post of the same end, nor a daemon that starts again.
    wakeOnSeats({ state, runs, post: d.post, live: () => true });
    handleLine(d, ended('/runs/app-7', 'w1')).after();
    reconcile(d);
    assert.equal(posts.length, 1);
    assert.equal(readLines(state).filter((e) => e.kind === 'seat-ended').length, 1);
    assert.equal(store.posts().find((r) => r.id !== row.id && r.verb === 'seat-ended').why, 'no new record: taken already');
  }));

test('a seat that ended while the daemon was down is woken once when it starts, and its offset is kept', () =>
  world(({ state, posts, d, store, seats, baseline }) => {
    baseline();
    seats(record('w1'), record('w2', { structured: null }));
    reconcile(d);
    assert.equal(posts.length, 2);
    assert.match(posts[1].line, /seat-no-result: worker w2 ended with no structured result/);
    assert.deepEqual(store.posts().map((r) => r.verb), ['reconcile', 'reconcile']);
    assert.equal(store.offset('sessions.jsonl'), readFileSync(join(state, 'sessions.jsonl')).length);
    reconcile(d);
    assert.equal(posts.length, 2, 'a second start woke them again');
  }));

test('the daemon wakes nothing before a sweep has recorded the seats, and leaves a record with no team to the sweep until it knows the claim holders', () =>
  world(({ state, runs, posts, d, seats, baseline }) => {
    seats(record('w1'));
    handleLine(d, ended('/runs/app-7', 'w1')).after();
    assert.equal(posts.length, 0, 'it woke before the sweep recorded what was there');
    baseline(1);
    seats(record('w2', { team: undefined, run: join(runs, 'app-7') }), record('w3'));
    handleLine(d, ended(join(runs, 'app-7'), 'w2')).after();
    assert.equal(posts.length, 0, 'a record with no team was woken without the holders, and the one after it before it');
    assert.equal(JSON.parse(readFileSync(join(state, 'queue-seats.news'), 'utf8')).count, 1);
    d.held = new Map([['app', new Map([[7, 'lead']])]]);
    handleLine(d, ended(join(runs, 'app-7'), 'w2')).after();
    assert.equal(posts.length, 2);
    assert.match(posts[0].line, /w2 ended/);
    assert.match(posts[1].line, /w3 ended/);
  }));

test('a wake that does not go is kept in the store with its reason, and the record is not taken again', () =>
  world(({ state, runs, d, store, seats, baseline }) => {
    baseline();
    seats(record('w1'), record('w2', { team: 'ghost-lead' }));
    d.post = () => ({ posted: false, why: 'refused' });
    handleLine(d, ended('/runs/app-7', 'w1')).after();
    // w1's Lead has a socket file and the post is refused; w2's Lead has no socket file on this machine, so no post is tried.
    assert.deepEqual(store.posts().map((r) => [r.verb, r.tag, r.woke_at, r.why]), [
      ['seat-ended', 'w1', null, 'refused'],
      ['found', 'w2', null, 'no file'],
    ]);
    const lines = readLines(state).filter((e) => e.kind === 'seat-ended');
    assert.deepEqual(lines.map((e) => [e.woke, e.why]), [[false, 'refused'], [false, 'no file']]);
    wakeOnSeats({ state, runs, post: d.post, live: () => true });
    assert.equal(readLines(state).filter((e) => e.kind === 'seat-ended').length, 2, 'the sweep took them again');
  }));

test('an unknown verb, a bad line and a bad seat-ended get an error answer and change nothing', () =>
  world(({ d, store }) => {
    for (const [line, code] of [
      [JSON.stringify({ id: 'a', verb: 'nope' }), 'unknown-verb'],
      ['{not json', 'bad-request'],
      ['[1]', 'bad-request'],
      [JSON.stringify({ id: 'b', verb: 'seat-ended', run: 7, tag: 'x' }), 'bad-request'],
      [JSON.stringify({ id: 'c', verb: 'seat-ended', run: '/r', tag: '' }), 'bad-request'],
      [JSON.stringify({ id: 'd', verb: 'seat-ended', run: '/r', tag: 'x', session: 5 }), 'bad-request'],
    ]) {
      const { response, after } = handleLine(d, line);
      assert.equal(response.ok, false, line);
      assert.equal(response.error.code, code, line);
      assert.equal(after, undefined);
    }
    assert.deepEqual(store.posts(), []);
    assert.equal(handleLine(d, JSON.stringify({ id: 'p', verb: 'ping' })).response.result.pid, process.pid);
  }));

test('the lease runs out after the time with no ping, not before, and the code has moved only when both heads are known and differ', () => {
  assert.equal(leaseExpired(1000, 1000 + 179_999, 180_000), false);
  assert.equal(leaseExpired(1000, 1000 + 180_000, 180_000), true);
  assert.equal(codeMoved('a'.repeat(40), 'b'.repeat(40)), true);
  assert.equal(codeMoved('a'.repeat(40), 'a'.repeat(40)), false);
  assert.equal(codeMoved(null, 'b'.repeat(40)), false);
  assert.equal(codeMoved('a'.repeat(40), null), false);
});

test('a store that fails to write a row does not stop the records after it from being woken', () =>
  world(({ posts, d, store, seats, baseline }) => {
    baseline();
    seats(record('w1'), record('w2'));
    d.store = { ...store, post: store.post, settle: () => { throw new Error('disk full'); } };
    handleLine(d, ended('/runs/app-7', 'w1')).after();
    assert.equal(posts.length, 2);
  }));

test('the job starts the daemon when nobody answers, and does nothing when it answers or when a live daemon holds the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-'));
  try {
    const state = join(dir, 'state');
    mkdirSync(state);
    const spawned = [];
    const spawnFn = (file, args, options) => (spawned.push({ file, args, options }), { pid: 4242, on() {}, unref() {} });
    // It answers: nothing is started.
    assert.equal(await ensureDaemon(state, { ping: async () => ({ ok: true, result: { pid: 1 } }), spawnFn, home: dir, waitMs: 100 }), 0);
    assert.equal(spawned.length, 0);
    // A daemon that holds the lock and does not answer: told, nothing started.
    const held = takeLock(join(state, 'daemon.lock'));
    const mute = async () => ({ ok: false, why: 'timed out' });
    assert.equal(await ensureDaemon(state, { ping: mute, spawnFn, home: dir, waitMs: 100 }), 1);
    assert.equal(spawned.length, 0);
    assert.match(readFileSync(join(state, 'queue-run.failed'), 'utf8'), /holds .*daemon\.lock and does not answer/);
    held.release();
    // A lock whose process is gone: the daemon is started detached, with the job's environment and a log of its own.
    writeFileSync(join(state, 'daemon.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, start: null, token: 'y' }));
    let answered = false;
    const ping = async () => ({ ok: answered });
    // Not the job (no XPC_SERVICE_NAME of its label): refused, nothing started, nothing written.
    assert.equal(await ensureDaemon(state, { ping, spawnFn, home: dir, waitMs: 100, env: {} }), 2);
    assert.equal(spawned.length, 0);
    const env = { XPC_SERVICE_NAME: 'io.github.tuannd9288.factory.queue' };
    const code = await ensureDaemon(state, { ping, spawnFn: (...a) => ((answered = true), spawnFn(...a)), home: dir, waitMs: 100, env });
    assert.equal(code, 0);
    assert.equal(spawned.length, 1);
    assert.match(spawned[0].file, /bin\/factory-daemon$/);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.env.FACTORY_DAEMON_LOG, join(dir, 'Library/Logs/factory/daemon.log'));
    assert.ok(existsSync(join(dir, 'Library/Logs/factory/daemon.log')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
