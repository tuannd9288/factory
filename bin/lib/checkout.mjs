// The factory's own checkout follows main (#257). The queue's sweep calls followMain: it fast-forwards the checkout the daemons and
// bin/seat run from to origin/main, but only when no run is live, under checkout.lock, which every start of a run takes for the
// moment it registers (withStartLock). So the files under a run already going never change: either the start registered first and
// the update defers, or the update finished first and the start, which may have loaded older code, starts again on the new
// (the one re-exec). Nothing is deleted: a file in the way moves to $state/archive. A checkout that cannot follow is not moved,
// and queue-checkout.failed says why. checkPlists tells the Human when the code now renders a LaunchDaemon plist that differs
// from the installed one, which only his sudo can replace.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STALE_MS = 120_000;
const LONG_MS = 2 * 3600_000;

const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};
const first = (text) => String(text ?? '').trim().split('\n')[0].slice(0, 200);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The commit a checkout is at, read from its .git files (no process): null where they cannot tell. */
export function headOf(root) {
  try {
    let dir = join(root, '.git');
    if (statSync(dir).isFile()) dir = resolve(root, readFileSync(dir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    const common = readOr(join(dir, 'commondir'));
    for (const d of [dir, ...(common ? [resolve(dir, common.trim())] : [])]) {
      const sha = readOr(join(d, ref))?.trim();
      if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
      const packed = readOr(join(d, 'packed-refs'))?.split('\n').find((l) => l.endsWith(` ${ref}`));
      if (packed) return packed.split(' ')[0];
    }
  } catch {
    // not a clone
  }
  return null;
}

/** The commit this process loaded its code at: read as this module loads, which is as the start's own code loads. A test names one. */
export const LOADED = process.env.FACTORY_LOADED_HEAD || headOf(ROOT);

/** A lock folder (mkdir is atomic), as bin/seat claims a tag. Returns its release, or null after `wait` ms. One older than STALE_MS
 * is a crashed holder's: the update holds it for seconds, a start for milliseconds. */
function takeDir(lock, wait, label) {
  const end = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(join(lock, 'holder'), `${process.pid} ${label}\n`);
      } catch {
        // the lock is held all the same, only unnamed
      }
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
        else if (Date.now() >= end) return null;
        else sleep(25);
      } catch {
        // it went away meanwhile: take it
      }
    }
  }
}

/** Runs fn while holding checkout.lock: the registration of a run (its claim, its marker), and no more: a plugin install or a spawn
 * is for after the release, the claim being live from then on. The update cannot count or pull meanwhile. The lock records its
 * holder (`label`), which a refused start names. Returns {value}, or {moved: true, head} without running fn when the checkout is at another commit
 * than the one this start loaded its code at: the caller starts again (reexec) so one commit's code starts the run. Throws, naming
 * the update, when the lock stays taken for `wait` ms. */
export function withStartLock(state, root, fn, { wait = Number(process.env.FACTORY_CHECKOUT_LOCK_WAIT_MS) || 10_000, loaded = LOADED, label = 'a start' } = {}) {
  mkdirSync(state, { recursive: true });
  const lock = join(state, 'checkout.lock');
  const release = takeDir(lock, wait, label);
  if (!release) {
    const holder = /^(\d+) (.+)$/.exec((readOr(join(lock, 'holder')) ?? '').trim());
    const by = holder ? `the checkout lock is held by ${holder[2]} (pid ${holder[1]})` : 'an update of the checkout is in progress';
    throw Object.assign(new Error(`${by}; start again in a moment`), { busy: true });
  }
  try {
    const head = headOf(root);
    if (!process.env.FACTORY_REEXEC && loaded && head && head !== loaded) return { moved: true, head };
    return { value: fn() };
  } finally {
    release();
  }
}

/** Starts this command again on the checkout's current files, once (FACTORY_REEXEC), and returns its exit code. */
export function reexec(argv, head) {
  process.stderr.write(`the checkout moved to ${String(head).slice(0, 7)}; started again on it\n`);
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit', env: { ...process.env, FACTORY_REEXEC: '1' } });
  return r.status ?? 1;
}

/** A run of a process with no run folder of its own (the canary): run-<name>.pid and .seat (seat 0, which no seat's count includes) under
 * <runs>/daemon-<name>, so liveRuns sees it. Returns the function that removes the two. */
export function markRun(runs, name) {
  const dir = join(runs, `daemon-${name}`);
  mkdirSync(dir, { recursive: true });
  const seat = join(dir, `run-${name}.seat`);
  const pid = join(dir, `run-${name}.pid`);
  writeFileSync(seat, '0\n');
  writeFileSync(pid, `${process.pid}\n`);
  return () => {
    rmSync(pid, { force: true });
    rmSync(seat, { force: true });
    try {
      rmdirSync(dir); // only while it is empty
    } catch {
      // another process's marker, or already gone
    }
  };
}

const stamp = (ms) => new Date(ms).toISOString().replace(/:/g, '-');

/** Moves path (under root) into $state/archive/<folder>, keeping its place in the tree. */
function archive(state, folder, root, path) {
  const to = join(state, 'archive', folder, path);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(join(root, path), to);
}

/** One try to bring the checkout at root to origin/main. live() is the number of runs live now (Infinity when unknown). Returns
 * {status}: current, updated, deferred (runs are live; nothing written until two hours), busy (a start holds the lock) or refused
 * (queue-checkout.failed says why). It moves the checkout by `git pull --ff-only origin main` alone. */
export function followMain({ root, state, live, now = Date.now(), env = process.env }) {
  mkdirSync(state, { recursive: true });
  const report = join(state, 'queue-checkout.failed');
  const since = join(state, 'queue-checkout.since');
  // GIT_LITERAL_PATHSPECS: a path from the scan is a path, whatever characters it holds.
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' } });
  const out = (r) => `${r.stdout ?? ''}`.trim();
  const why = (r) => first(r.stderr) || first(r.stdout) || (r.error ? r.error.message : `exit ${r.status}`);
  const refuse = (text) => {
    writeFileSync(report, `${new Date(now).toISOString()} ${text}\n`);
    rmSync(since, { force: true });
    return { status: 'refused', why: text };
  };
  const clear = () => {
    rmSync(report, { force: true });
    rmSync(since, { force: true });
  };
  // The checkout must be on main with no change of its own.
  const unfit = () => {
    const branch = git('symbolic-ref', '--short', '-q', 'HEAD');
    if (out(branch) !== 'main') return `on ${out(branch) ? `branch ${out(branch)}` : 'a detached HEAD'}, not main`;
    const status = git('status', '--porcelain');
    if (status.status !== 0) return `git status failed: ${why(status)}`;
    const lines = out(status).split('\n').filter(Boolean);
    if (lines.length) return `local changes: ${lines.length} files, first ${lines[0].slice(3)}`;
    return null;
  };

  let reason = unfit();
  if (reason) return refuse(reason);
  const fetch = git('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  if (fetch.status !== 0) return refuse(`fetch failed: ${why(fetch)}`);
  const behind = Number(out(git('rev-list', '--count', 'HEAD..origin/main')));
  if (!(behind >= 0)) return refuse('could not tell how far behind origin/main the checkout is');
  if (behind === 0) {
    clear();
    return { status: 'current' };
  }
  const head = out(git('rev-parse', 'HEAD'));
  const tip = out(git('rev-parse', 'origin/main'));
  if (git('merge-base', '--is-ancestor', 'HEAD', 'origin/main').status !== 0) {
    return refuse(`main diverged: HEAD ${head.slice(0, 7)} is not behind origin/main ${tip.slice(0, 7)}`);
  }

  const release = takeDir(join(state, 'checkout.lock'), 0, 'the update of the checkout');
  if (!release) return { status: 'busy' };
  try {
    const n = live();
    if (n !== 0) {
      const began = Date.parse((readOr(since) ?? '').trim());
      if (Number.isNaN(began)) writeFileSync(since, `${new Date(now).toISOString()}\n`);
      else if (now - began >= LONG_MS) {
        writeFileSync(report, `${new Date(now).toISOString()} ${behind} commits behind for ${Math.floor((now - began) / 3600_000)} h: runs are live\n`);
      }
      return { status: 'deferred', behind };
    }
    reason = unfit();
    if (reason) return refuse(reason);
    // git overwrites an ignored file that a commit brings in without a word, so those go to the archive first. The scan and the
    // merge both use the tip fetched above: a main that moved since is the next sweep's, with its own scan.
    const brought = out(git('diff', '-z', '--name-only', '--diff-filter=AMR', 'HEAD', tip)).split('\0').filter(Boolean);
    const folder = `${tip.slice(0, 7)}-${stamp(now)}`;
    try {
      for (const path of brought) {
        if (existsSync(join(root, path)) && git('ls-files', '--error-unmatch', '--', path).status !== 0) archive(state, folder, root, path);
      }
    } catch (e) {
      return refuse(`could not move a file in the way to the archive: ${e.code ?? e.message}`);
    }
    // What the scan cannot see (an ignored file where a directory comes in) is refused by --no-overwrite-ignore, never deleted.
    const pull = git('merge', '-q', '--ff-only', '--no-overwrite-ignore', tip);
    if (pull.status !== 0) return refuse(`pull failed: ${why(pull)}`);
    clear();
    return { status: 'updated', from: head, to: out(git('rev-parse', 'HEAD')), behind };
  } finally {
    release();
  }
}

export const PLISTS = ['io.github.tuannd9288.factory.queue', 'io.github.tuannd9288.factory.digest', 'io.github.tuannd9288.factory.claude-canary'];
const TOOLS = { queue: 'bin/factory-queue', digest: 'bin/factory-ledger', 'claude-canary': 'bin/claude-canary' };

/** The repositories an installed plist names (its --repo arguments), in order. */
export function reposOf(text) {
  return [...text.matchAll(/<string>--repo<\/string>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
}

/** What this checkout's code renders for the plist of `label`, with the repositories the installed one names: the three tools'
 * own `plist --daemon`, run in this process's environment, which for a daemon is the plist's. */
export function renderPlist(root, label, installed, env = process.env) {
  const tool = TOOLS[label.split('.').slice(4).join('.')];
  const r = spawnSync(join(root, tool), ['plist', '--daemon', ...reposOf(installed).flatMap((repo) => ['--repo', repo])], { encoding: 'utf8', env, timeout: 30_000 });
  if (r.status !== 0) throw new Error(first(r.stderr) || `exit ${r.status}`);
  return r.stdout;
}

/** Compares what the code renders for each plist with the installed file, which it only reads (the three of PLISTS, in plistDir).
 * A plist that is not installed is skipped. A difference leaves the wanted plist in $state/plist-wanted (an earlier, different
 * one moves to the archive) and queue-plist.failed until the Human's reinstall makes them equal. A render that throws leaves the
 * same file too, saying `could not render <label>: <first line>`. Returns {differ: [labels], unrendered: [lines]}. */
export function checkPlists({ root, state, plistDir, render = (label, installed) => renderPlist(root, label, installed), now = Date.now() }) {
  const differ = [];
  const unrendered = [];
  const wantedDir = join(state, 'plist-wanted');
  const report = join(state, 'queue-plist.failed');
  for (const label of PLISTS) {
    const installed = readOr(join(plistDir, `${label}.plist`));
    if (installed === null) continue;
    let wanted;
    try {
      wanted = render(label, installed);
    } catch (error) {
      unrendered.push(`could not render ${label}: ${first(error.message)}`); // nothing to compare, and never a silence
      continue;
    }
    const file = join(wantedDir, `${label}.plist`);
    if (wanted === installed) {
      rmSync(file, { force: true });
      continue;
    }
    differ.push(label);
    mkdirSync(wantedDir, { recursive: true });
    const had = readOr(file);
    if (had !== null && had !== wanted) {
      const to = join(state, 'archive', `plist-${stamp(now)}`, `${label}.plist`);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(file, to);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, wanted);
    renameSync(tmp, file);
  }
  const parts = [
    ...(differ.length ? [`${differ.join(' ')}: the installed plist differs from what the code renders; the wanted one is in ${wantedDir}; the Human reinstalls it with sudo`] : []),
    ...unrendered,
  ];
  if (parts.length) writeFileSync(report, `${new Date(now).toISOString()} ${parts.join('; ')}\n`);
  else rmSync(report, { force: true });
  return { differ, unrendered };
}
