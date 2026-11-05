// The factory's daemon (#399, slice 1): the one long-running process that hosts the sweep's pass and takes a seat's end at once. The pattern is
// piggery's (v0.10.3, 67c083e; the part ported is cited at each place), the differences are named below. bin/factory-daemon runs it; only the 60 s
// job starts it (bin/lib/queue.mjs, ensureDaemon).
//   One instance: $FACTORY_STATE/daemon.lock records the pid and start time (takeLock of the queue's lock; a lock whose process is gone is taken
//   over). piggery takes a flock (server/server.go:119-130); a pid and a start time is how the queue's lock tells a dead holder from a reused pid.
//   The socket: $FACTORY_STATE/daemon.sock, mode 0600, its path under 104 bytes (bin/lib/daemon-proto.mjs says the wire). Only the lock holder
//   unlinks a stale socket and makes its own (server/transport_unix.go:16-30). One request, one answer, matched by `id` (proto/proto.go:136-157).
//   Verbs: `ping` -> { pid, start, startedAt, head, passes, passing }; `seat-ended` { run, tag, session } -> { id }. An unknown verb gets an error
//   answer, a bad line too; nothing a client sends ends the daemon.
//   Reconcile before listening (server/server.go:242-248, core/reconcile.go:11-54): the store is opened, then the seat records not yet taken are
//   woken once. The authority for "once" is queue-seats.news (bin/lib/news-wake.mjs, wakeOnSeatEnds), the state the sweep always had; the store's
//   offset into sessions.jsonl is the daemon's own read position. piggery's reconcile marks sessions gone and never respawns; this daemon starts no
//   seat and ends none, so a restart stops nothing.
//   The pass: bin/lib/queue.mjs's runPass, unchanged, every 60 s (from the start of one to the start of the next, 1 s at least between), under
//   queue.lock, so a pass run by hand (`bin/factory-queue sweep --once`, `check`) and this one never overlap. It runs in a worker thread of this
//   process, not on the thread that listens: the pass calls gh and git synchronously for seconds, and a seat's end must be taken meanwhile. The
//   worker is a fresh module graph, so what a pass keeps in module variables (bin/lib/events.mjs's `notes`, bin/lib/wake.mjs's counter) dies with
//   it and nothing carries into the next pass; runPass still calls resetNotes first. The worker hands back the claim holders it read (`heldBy`),
//   which the seat-ended handler needs for a record that names no team, and whether the pass moved the checkout.
//   A seat's end: bin/seat appends its record to sessions.jsonl, then posts { verb: 'seat-ended', run, tag, session }. The daemon writes the post
//   to the store, answers at once, then takes the new records (queue-seats.news first, then the wake, then the events line, as the sweep does:
//   the line carries `woke`, so the wake comes before it), and settles the store's row with the time of the wake or why it went not. The wake is
//   #351's: a post into the Lead's recorded inbox socket (bin/lib/wake.mjs), the same line and text. This is the factory's counterpart of
//   piggery's `cmd.Wait` (driver/local/runner.go:331-344): piggery's daemon owns the worker's process; here bin/seat does, and tells the daemon.
//   When a pass moved the checkout (followMain), the daemon exits cleanly after that pass, releasing the lock and the socket, so the job's next run
//   starts the new code (as #257 does for a Lead's hook). It exits the same way when its log (FACTORY_DAEMON_LOG, set by the job's start) passes
//   10 MiB, so the next start moves it aside, and on SIGTERM, SIGINT and SIGHUP after the pass in hand (30 s at most). After every pass, whether
//   it ended well or threw, it also compares the code it loaded with the checkout's HEAD and exits when they differ (a move made by another
//   process, or whose message the pass lost). It lives on a lease from the job: each `ping` renews it, and with none for 180 s
//   (FACTORY_DAEMON_LEASE_MS) it stops the way SIGTERM does, so booting the job out ends it within about three minutes, with no plist change.
//   The peer check (server/peer.go:22-47) is not ported. It lets a caller speak for a harness process, by the pid of the socket's peer and its
//   process tree, since piggery's verbs carry a participant's authority. Here a post carries none: the daemon acts on what sessions.jsonl holds,
//   never on the post's fields, which only name the row they settle, and a forged `seat-ended` makes the daemon take records earlier, which is
//   idempotent. Any process of this account can already append to sessions.jsonl, write the events and post into a Lead's socket; one that is
//   not this account cannot connect to a socket of mode 0600, which is the protection (the folder's own mode is the umask's). node has no call for the peer's pid either (it would take a process spawn
//   for each connection). If a later verb carries authority, as slice 2's hooks may, this is decided again for it.
//   Differences from piggery that are not in the list above: the socket holds one request per connection from every client here (piggery's
//   v0.11.2 answers a waiting request out of order, server.go: `waits`; nothing here waits); the clients never start the daemon (piggery's
//   Dial does, client.go:32-64); and the store is node:sqlite, with the settings of store.go:117, 132-133 (bin/lib/store.mjs).
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { LOADED, ROOT, headOf } from './checkout.mjs';
import { MAX_LINE, fits, socketPath } from './daemon-proto.mjs';
// queue.mjs before news-wake.mjs: the modules import each other in a ring, and the queue's constants are built from the comment wake's, so the ring
// must be entered at the queue, as bin/factory-queue enters it.
import { holderOf, releaseLock, takeLock } from './queue.mjs';
import { wakeOnSeatEnds } from './news-wake.mjs';
import { openStore } from './store.mjs';
import { startLinearSource } from './linear-listen.mjs';
import { postSync } from './wake.mjs';

export const PASS_MS = 60_000;
const LOG_MAX = 10 * 1024 * 1024;
const STOP_WAIT_MS = 30_000;
/** How long the daemon lives without a `ping`: the job pings once a minute, and the daemon's own start counts as the first. */
export const LEASE_MS = 180_000;
const PASS_FILE = new URL('./daemon-pass.mjs', import.meta.url);

const first = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);
const text = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const bad = (code, message) => ({ ok: false, error: { code, message } });

const sizeOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** Settles the row of a record the daemon took: the time its wake went out, or why it did not. It never throws: a store that fails costs the
 * row and one line, not the records after it in the batch, whose count has moved already. */
function settleWith(store, id, out, now = Date.now()) {
  try {
    store.settle(id, { wokeAt: out.woke ? now : null, why: out.woke ? null : out.why, seq: out.seq });
  } catch (error) {
    console.log(`daemon: could not settle post ${id}: ${first(error)}`);
  }
}

/** Whether the daemon's lease has run out: no `ping` for `leaseMs` since `lastPing` (ms). */
export const leaseExpired = (lastPing, now, leaseMs) => now - lastPing >= leaseMs;

/** Whether the checkout now holds other code than this process loaded: both heads are known and differ. */
export const codeMoved = (loaded, head) => Boolean(loaded && head && loaded !== head);

/** The records of sessions.jsonl not yet taken, woken once, before the socket listens. The first pass finds the holders of a record that names no
 * team, so such a record waits for it. */
export function reconcile(d) {
  const file = join(d.state, 'sessions.jsonl');
  const size = sizeOf(file);
  let offset = d.store.offset('sessions.jsonl');
  if (offset > size) {
    d.log(`daemon: sessions.jsonl (${size} bytes) is shorter than the offset ${offset}; read from its start`);
    offset = 0;
  }
  const taken = wakeOnSeatEnds({
    state: d.state,
    runs: d.runs,
    heldBy: d.held,
    post: d.post,
    sink: (r, out) => settleWith(d.store, d.store.post({ verb: 'reconcile', run: r.run ?? null, tag: r.tag ?? null, session: r.session ?? null }), out),
  });
  d.store.setOffset('sessions.jsonl', size);
  d.log(`daemon: reconciled: ${size - offset} bytes of sessions.jsonl past the offset, ${taken.length} seat ends taken`);
  return taken;
}

/** The `seat-ended` verb: the post is written to the store and answered at once; the work (`after`) follows. Its fields only name the row to
 * settle: what is woken is what sessions.jsonl holds. */
function seatEnded(d, req) {
  if (!text(req.run) || !text(req.tag) || !(req.session === undefined || req.session === null || text(req.session)))
    return { response: bad('bad-request', 'seat-ended needs run and tag, and a session or null') };
  const id = d.store.post({ verb: 'seat-ended', run: req.run, tag: req.tag, session: req.session ?? null });
  const after = () => {
    let mine = false;
    try {
      const size = sizeOf(join(d.state, 'sessions.jsonl'));
      const taken = wakeOnSeatEnds({
        state: d.state,
        runs: d.runs,
        heldBy: d.held,
        post: d.post,
        sink: (r, out) => {
          // The row of the post is the record it names; any other record taken with it has a row of its own.
          if (!mine && r.run === req.run && r.tag === req.tag) {
            mine = true;
            return settleWith(d.store, id, out);
          }
          settleWith(d.store, d.store.post({ verb: 'found', run: r.run ?? null, tag: r.tag ?? null, session: r.session ?? null }), out);
        },
      });
      d.store.setOffset('sessions.jsonl', size);
      if (!mine) d.store.settle(id, { why: taken.length ? 'the record it names was not among those taken' : 'no new record: taken already' });
    } catch (error) {
      d.log(`daemon: seat-ended ${req.tag}: ${first(error)}`);
      d.store.settle(id, { why: `error: ${first(error)}` });
    }
  };
  return { response: { ok: true, result: { id } }, after };
}

/** One request line to { response, after }; never throws. */
export function handleLine(d, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { response: { id: null, ...bad('bad-request', 'not a JSON line') } };
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { response: { id: null, ...bad('bad-request', 'not a JSON object') } };
  const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  try {
    if (req.verb === 'ping') d.lastPing = Date.now();
    if (req.verb === 'ping') return { response: { id, ok: true, result: { pid: process.pid, start: d.lock.start, startedAt: d.startedAt, head: LOADED ?? null, passes: d.passes, passing: d.passing } } };
    if (req.verb === 'seat-ended') {
      const r = seatEnded(d, req);
      return { ...r, response: { id, ...r.response } };
    }
    return { response: { id, ...bad('unknown-verb', `unknown verb ${JSON.stringify(String(req.verb).slice(0, 40))}`) } };
  } catch (error) {
    d.log(`daemon: ${String(req.verb).slice(0, 40)}: ${first(error)}`);
    return { response: { id, ...bad('internal', 'the daemon could not handle it') } };
  }
}

function serve(d, sock) {
  const server = createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.setTimeout(10_000, () => c.destroy());
    c.on('error', () => {});
    c.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes('\n')) return c.destroy();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const { response, after } = handleLine(d, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (c.writable) c.write(`${JSON.stringify(response)}\n`);
        if (after) setImmediate(() => {
          try {
            after();
          } catch (error) {
            d.log(`daemon: ${first(error)}`);
          }
        });
      }
    });
  });
  // Mode 0600 from the bind (the umask), and again after it; the folder is the account's own.
  const umask = process.umask(0o177);
  try {
    server.listen(sock);
  } finally {
    process.umask(umask);
  }
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.once('listening', () => {
      chmodSync(sock, 0o600);
      server.off('error', fail);
      done(server);
    });
  });
}

/** Removes queue.lock if this process holds it: a pass whose worker died leaves it, and its pid is alive, so nobody else would take it. */
function releaseQueueLock(state) {
  const lock = join(state, 'queue.lock');
  if (holderOf(lock)?.pid === process.pid) rmSync(lock, { force: true });
}

/** Runs the daemon until it stops; resolves with the exit code. `passFile`, `passMs`, `post`, `signals`, `leaseMs`, `headNow` and `onStart` (told
 * { stop, d } once it listens) are passed in for tests. */
export async function run({ state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory'), runs = process.env.FACTORY_RUNS ?? join(process.env.HOME, 'factory-runs'), human = process.env.FACTORY_HUMAN ?? 'tuannd9288', passFile = PASS_FILE, passMs = PASS_MS, post = postSync, log = (line) => console.log(line), logFile = process.env.FACTORY_DAEMON_LOG ?? null, signals = true, leaseMs = Number(process.env.FACTORY_DAEMON_LEASE_MS) || LEASE_MS, headNow = () => headOf(ROOT), onStart } = {}) {
  const sock = socketPath(state);
  if (!fits(sock)) throw new Error(`the socket path ${sock} is longer than 103 bytes`);
  mkdirSync(state, { recursive: true });
  const lockFile = join(state, 'daemon.lock');
  const lock = takeLock(lockFile);
  if (!lock) {
    const other = holderOf(lockFile);
    log(`daemon: another daemon holds ${lockFile}${other ? ` (pid ${other.pid}, started ${other.start})` : ''}; nothing done`);
    return 0;
  }
  let store;
  try {
    store = openStore(join(state, 'factory.db'));
  } catch (error) {
    releaseLock(lockFile, lock.token);
    throw error;
  }
  const d = { state, runs, store, lock, post, log, held: null, lastPing: Date.now(), passes: 0, passing: false, stopping: false, moved: false, worker: null, timer: null, startedAt: new Date().toISOString() };
  let server = null;
  let stopped;
  const finished = new Promise((done) => (stopped = done));
  const stop = (why) => {
    if (d.stopping) return;
    d.stopping = true;
    log(`daemon: stopping: ${why}`);
    d.linear?.stop();
    clearTimeout(d.timer);
    clearInterval(d.lease);
    const close = () => {
      server?.close();
      rmSync(sock, { force: true });
      store.close();
      releaseLock(lockFile, lock.token);
      log('daemon: stopped');
      stopped(0);
    };
    if (!d.worker) return close();
    // The pass in hand finishes (30 s at most), then the daemon goes.
    const timer = setTimeout(() => d.worker?.terminate(), STOP_WAIT_MS);
    d.worker.once('exit', () => {
      clearTimeout(timer);
      close();
    });
  };
  const startPass = () => {
    if (d.passing || d.stopping) return;
    d.passing = true;
    const began = Date.now();
    let result = null;
    const worker = new Worker(passFile, { workerData: { state, human } });
    d.worker = worker;
    worker.on('message', (m) => {
      if (m?.type === 'pass') result = m;
    });
    worker.on('error', (error) => log(`daemon: the pass raised ${first(error)}`));
    worker.on('exit', () => {
      d.passing = false;
      d.worker = null;
      d.passes += 1;
      releaseQueueLock(state);
      if (result?.heldBy) d.held = result.heldBy;
      if (result?.moved) d.moved = true;
      if (d.stopping) return;
      // A move this pass made, or one made by another process (`check`, bin/install-factory), or one whose message was lost to a pass that threw.
      if (d.moved || codeMoved(LOADED, headNow())) return stop('the checkout moved, so the next start runs the new code');
      if (logFile && sizeOf(logFile) > LOG_MAX) return stop(`${logFile} is over 10 MiB, so the next start moves it aside`);
      d.timer = setTimeout(startPass, Math.max(1000, passMs - (Date.now() - began)));
    });
  };
  try {
    reconcile(d);
    rmSync(sock, { force: true }); // a socket left by a daemon that died: the lock is ours, so nobody listens on it
    server = await serve(d, sock);
  } catch (error) {
    store.close();
    releaseLock(lockFile, lock.token);
    throw error;
  }
  d.linear = startLinearSource({ state, store, log });
  if (signals) for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop(`signal ${sig}`));
  log(`daemon: listening on ${sock} (pid ${process.pid}, head ${String(LOADED ?? 'unknown').slice(0, 7)})`);
  // The lease: the job pings once a minute, so a daemon nobody pings (its job booted out) stops by itself, by the path of SIGTERM.
  d.lease = setInterval(() => {
    if (leaseExpired(d.lastPing, Date.now(), leaseMs)) stop(`no ping for ${Math.round(leaseMs / 1000)} s: the job that starts it is gone`);
  }, Math.max(20, Math.min(5000, leaseMs / 4)));
  onStart?.({ stop, d });
  startPass();
  return finished;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await run();
    process.exit();
  } catch (error) {
    console.error(`factory-daemon: ${first(error)}`);
    process.exitCode = 2;
  }
}
