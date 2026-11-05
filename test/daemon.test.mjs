// #399: the daemon as a process on a unix socket: its lock, its socket, the verbs over the wire, a pass in its worker thread, the exit after a
// pass that moved the checkout, the job's start of it, and bin/seat's post. These listen on sockets and start processes, so they run outside
// Claude Code's sandbox. The pass is a fake worker file; no test reaches GitHub (the fake gh refuses).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ask, socketPath } from '../bin/lib/daemon-proto.mjs';
import { run } from '../bin/lib/daemon.mjs';
import { readLines } from '../bin/lib/events.mjs';
import { openStore } from '../bin/lib/store.mjs';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');
const wait = async (ok, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await ok()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
};

// A pass that does what the real one hands back and nothing else: it counts itself in <state>/passes, gives the claim holders of app-7, and
// says it moved the checkout when <state>/moved exists.
const FAKE_PASS = `
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
appendFileSync(join(workerData.state, 'passes'), 'x\\n');
parentPort.postMessage({ type: 'pass', code: 0, heldBy: new Map([['app', new Map([[7, 'lead']])]]), moved: existsSync(join(workerData.state, 'moved')) });
`;

async function world(body, { pass = FAKE_PASS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fd-'));
  const state = join(dir, 'state');
  const runs = join(dir, 'runs');
  mkdirSync(state);
  mkdirSync(join(runs, 'app-lead'), { recursive: true });
  writeFileSync(join(runs, 'app-lead/socket'), `${join(dir, 'lead.sock')}\n`);
  writeFileSync(join(dir, 'pass.mjs'), pass);
  const posts = [];
  const post = (file, line) => (posts.push(JSON.parse(line).message.content), { posted: true });
  const daemons = [];
  const start = async (extra = {}) => {
    let up;
    const ready = new Promise((done) => (up = done));
    const finished = run({ state, runs, human: 'nobody', passFile: new URL(`file://${join(dir, 'pass.mjs')}`), post, log: () => {}, signals: false, startSource: () => null, onStart: up, ...extra });
    const api = await Promise.race([ready, finished.then(() => null)]);
    daemons.push({ api, finished });
    return { api, finished };
  };
  const seats = (...records) => appendFileSync(join(state, 'sessions.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const baseline = (count = 0) => writeFileSync(join(state, 'queue-seats.news'), JSON.stringify({ count, gone: {}, told: [] }));
  try {
    await body({ dir, state, runs, posts, start, seats, baseline, sock: socketPath(state) });
  } finally {
    for (const { api, finished } of daemons) {
      api?.stop('the test ended');
      await finished;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const record = (tag, extra = {}) => ({ role: 'worker', tag, run: '/runs/app-7', team: 'app-lead', session: `s-${tag}`, end: new Date().toISOString(), structured: { conclusion: 'done' }, ...extra });

test('the daemon answers ping on a socket of mode 0600, and stopping takes the socket and the lock away', () =>
  world(async ({ state, sock, start }) => {
    const { api, finished } = await start();
    assert.equal(statSync(sock).mode & 0o777, 0o600);
    const r = await ask(sock, { verb: 'ping' });
    assert.equal(r.ok, true);
    assert.equal(r.result.pid, process.pid);
    assert.equal(JSON.parse(readFileSync(join(state, 'daemon.lock'), 'utf8')).pid, process.pid);
    api.stop('test');
    assert.equal(await finished, 0);
    assert.equal(existsSync(sock), false);
    assert.equal(existsSync(join(state, 'daemon.lock')), false);
    assert.equal((await ask(sock, { verb: 'ping' })).ok, false);
  }));

test('a seat end posted over the socket wakes its Lead within a second and settles its row in the store', () =>
  world(async ({ state, posts, start, seats, baseline, sock }) => {
    await start();
    await wait(() => existsSync(join(state, 'passes')));
    baseline();
    seats(record('w1'));
    const began = Date.now();
    const r = await ask(sock, { verb: 'seat-ended', run: '/runs/app-7', tag: 'w1', session: 's-w1' });
    assert.equal(r.ok, true);
    assert.ok(await wait(() => posts.length === 1, 1000), 'no wake within a second');
    assert.ok(Date.now() - began < 1000);
    assert.match(posts[0], /seat-ended: worker w1 ended/);
    const lines = readLines(state).filter((e) => e.kind === 'seat-ended');
    assert.deepEqual(lines.map((e) => [e.woke, e.lead]), [[true, 'app-lead']]);
    await wait(() => openStore(join(state, 'factory.db')).posts().some((p) => p.woke_at));
  }));

test('an unknown verb and a bad line get an error answer, and the daemon goes on answering', () =>
  world(async ({ start, sock }) => {
    await start();
    const r = await ask(sock, { verb: 'nope' });
    assert.equal(r.ok, false);
    assert.match(r.why, /unknown verb "nope"/);
    assert.equal((await ask(sock, { verb: 'seat-ended', run: 5 })).ok, false);
    assert.equal((await ask(sock, { verb: 'ping' })).ok, true);
  }));

test('a second daemon on the same state exits at once and the first goes on answering', () =>
  world(async ({ start, sock }) => {
    await start();
    const second = await start();
    assert.equal(second.api, null, 'the second one listened');
    assert.equal(await second.finished, 0);
    assert.equal((await ask(sock, { verb: 'ping' })).ok, true);
  }));

test('a lock whose process is gone and a socket file left behind are taken over', () =>
  world(async ({ state, start, sock }) => {
    writeFileSync(join(state, 'daemon.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, start: null, token: 'old' }));
    writeFileSync(sock, 'left behind');
    await start();
    assert.equal((await ask(sock, { verb: 'ping' })).ok, true);
    assert.equal(JSON.parse(readFileSync(join(state, 'daemon.lock'), 'utf8')).pid, process.pid);
  }));

test('a pass that moved the checkout ends the daemon after that pass, with its lock and socket released', () =>
  world(async ({ state, start, sock }) => {
    writeFileSync(join(state, 'moved'), '');
    const { finished } = await start();
    assert.equal(await finished, 0);
    assert.equal(readFileSync(join(state, 'passes'), 'utf8'), 'x\n');
    assert.equal(existsSync(sock), false);
    assert.equal(existsSync(join(state, 'daemon.lock')), false);
  }));

test('the first pass hands its claim holders to the daemon, which then wakes a record that names no team', () =>
  world(async ({ state, runs, posts, start, seats, baseline, sock }) => {
    baseline();
    seats(record('w2', { team: undefined, run: join(runs, 'app-7') }));
    await start();
    await wait(() => existsSync(join(state, 'passes')));
    await wait(async () => (await ask(sock, { verb: 'ping' })).result.passes >= 1);
    await ask(sock, { verb: 'seat-ended', run: join(runs, 'app-7'), tag: 'w2', session: 's-w2' });
    assert.ok(await wait(() => posts.length === 1, 1000));
    assert.match(posts[0], /w2 ended/);
  }));

test('a daemon that no one pings stops by itself when its lease runs out, and one that is pinged stays', async () => {
  await world(async ({ state, sock, start }) => {
    const idle = await start({ leaseMs: 300 });
    assert.equal(await idle.finished, 0);
    assert.equal(existsSync(sock), false);
    assert.equal(existsSync(join(state, 'daemon.lock')), false);
    assert.equal(existsSync(join(state, 'queue.lock')), false);
  });
  await world(async ({ start, sock }) => {
    const { api, finished } = await start({ leaseMs: 400 });
    let over = false;
    finished.then(() => (over = true));
    for (let i = 0; i < 12; i += 1) {
      assert.equal((await ask(sock, { verb: 'ping' })).ok, true);
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(over, false, 'a pinged daemon stopped');
    api.stop('test');
  });
});

test('a daemon whose checkout moved under it, with no message from its pass, stops after that pass', () =>
  world(async ({ start, sock }) => {
    const { finished } = await start({ headNow: () => 'f'.repeat(40) });
    assert.equal(await finished, 0);
    assert.equal(existsSync(sock), false);
  }));

test('a socket path of 104 bytes or more is refused before anything is made', async () => {
  const state = join(tmpdir(), 'x'.repeat(100));
  await assert.rejects(run({ state, signals: false, startSource: () => null }), /longer than 103 bytes/);
  assert.equal(existsSync(state), false);
  assert.deepEqual(await ask(join(state, 'daemon.sock'), { verb: 'ping' }), { ok: false, why: 'path too long' });
});

test('bin/factory-queue sweep starts the daemon detached when nobody answers, and a second sweep starts none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    mkdirSync(join(dir, 'root'));
    const env = { XPC_SERVICE_NAME: 'io.github.tuannd9288.factory.queue', PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, 'home'), FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'), FACTORY_ROOT: join(dir, 'root'), FACTORY_CHECKOUT: '' };
    mkdirSync(env.HOME);
    const sweep = () => spawnSync(join(factory, 'bin/factory-queue'), ['sweep'], { encoding: 'utf8', env });
    const first = sweep();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /started the daemon/);
    const up = await ask(socketPath(env.FACTORY_STATE), { verb: 'ping' });
    assert.equal(up.ok, true);
    const second = sweep();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.doesNotMatch(second.stdout, /started the daemon/);
    assert.equal((await ask(socketPath(env.FACTORY_STATE), { verb: 'ping' })).result.pid, up.result.pid);
    assert.ok(existsSync(join(env.HOME, 'Library/Logs/factory/daemon.log')));
    process.kill(up.result.pid, 'SIGTERM');
    assert.ok(await wait(() => !existsSync(socketPath(env.FACTORY_STATE)), 40_000), 'the daemon did not stop on SIGTERM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The supervisor of bin/seat, run alone with a spec whose token file is missing: the seat ends with "start failed", which writes its record the
// same way a finished session does, and then posts.
function supervise(dir, state) {
  const run = join(dir, 'runs/app-7');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'brief.md'), 'brief');
  const spec = {
    cmd: ['claude'], cwd: dir, brief: join(run, 'brief.md'), jsonl: join(run, 'run-w1.jsonl'), err: join(run, 'run-w1.err'), childFile: join(run, 'run-w1.child'),
    tokenPath: join(dir, 'no-token'), account: 'a', team: 'app-lead', role: 'worker', seat: 1, tag: 'w1', name: 'w1', run, state, model: 'm', resume: null, start: new Date().toISOString(),
  };
  const child = spawn(process.execPath, [join(factory, 'bin/lib/seat.mjs'), '--supervise'], { cwd: dir, env: { ...process.env, FACTORY_SEAT_SUPERVISE: JSON.stringify(spec) }, stdio: 'ignore' });
  return { spec, done: new Promise((done) => child.on('close', done)) };
}

test('bin/seat posts the end to the daemon after it wrote the record, and a missing daemon costs one line in the error file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-'));
  try {
    const state = join(dir, 'state');
    mkdirSync(state);
    // No daemon: the record is written, one line says why not told, the outcome is the same.
    let s = supervise(dir, state);
    await s.done;
    assert.equal(readFileSync(join(state, 'sessions.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.match(readFileSync(s.spec.err, 'utf8'), /could not tell the daemon the seat ended: no socket/);
    // A daemon: it gets one line with the verb, the run, the tag and the session, after the record is on disk.
    const got = [];
    const server = createServer((c) => {
      c.setEncoding('utf8');
      c.on('data', (chunk) => {
        const req = JSON.parse(chunk);
        got.push({ req, recorded: readFileSync(join(state, 'sessions.jsonl'), 'utf8').trim().split('\n').length });
        c.write(`${JSON.stringify({ id: req.id, ok: true, result: {} })}\n`);
      });
    });
    await new Promise((done) => server.listen(socketPath(state), done));
    s = supervise(dir, state);
    await s.done;
    server.close();
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].req.verb, got[0].req.run, got[0].req.tag], ['seat-ended', s.spec.run, 'w1']);
    assert.equal(got[0].recorded, 2, 'it posted before the record was written');
    assert.doesNotMatch(readFileSync(s.spec.err, 'utf8'), /could not tell the daemon/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
