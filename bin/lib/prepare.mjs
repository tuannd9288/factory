// bin/lib/prepare.mjs (FAC-108): before a seat's session, bin/seat makes the worktree ready to test with main's gate_prepare
// (.gate/config.sh), outside the sandbox and with the network, so a worker can run its tests and pass the pre-commit hook in a repository
// whose code needs installed dependencies. The Human chose it on 2026-11-08 (INN-51): way 2, at the worktree's first start by default,
// so that outside the sandbox only main's lockfile is installed. The sandbox keeps its network closed.
//   Main: the commit the Lead names with --main, read from GitHub with the repository named (packs/pstack/lead.md step 2), never a
//         ref of the clone: its refs, its config and its object store are shared by every worktree of the clone, and a seat that can
//         commit can write them all (git update-ref moves origin/main; a loose object, a pack or a refs/replace ref can say anything, and
//         git reads them as the object they are named for). So every object read here is hashed and checked against its id, and an object
//         that is missing or does not match installs nothing. The worktree's first start records the commit it was given beside the
//         stamp, and every later start reads main there; a later --main that differs is noted in the log and not used. No --main and no
//         record installs nothing.
//   When: that commit's .gate/driver.json `prepare`, absent or `first` (the worktree's first start) or `every` (every start).
//   What: that commit's gate_prepare, run in the worktree with the session's own scrubbed environment, its output in the run folder as
//         run-<tag>.prepare.log. A main with no .gate/config.sh, or a work folder that is no clone, installs nothing.
//   First start: only when the worktree's files are that commit's tree, compared file by file here (no git status, index or
//         fsmonitor, which a seat can set), since what is installed outside the sandbox must be a tree main had. Any other worktree
//         installs nothing, gets no stamp, says why in that log, and its session starts as before. Once an install passed, a stamp in
//         $FACTORY_STATE/prepared/, where no seat can write, keyed to the worktree's real path and folder, says the worktree is ready; a
//         worker that removes anything in its worktree or run folder does not bring the install back. A worktree removed and made again
//         at the same path is a new folder and installs again.
// Every git call takes research-git's guard (bin/lib/research-git.mjs BASE) and no replace objects; the hash check is the defence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class PrepareError extends Error {}

/** When the install runs: `first` (absent too) or `every`, from main's .gate/driver.json; anything else is a PrepareError. */
export function prepareWhen(driver) {
  const value = driver?.prepare;
  if (value !== undefined && value !== 'first' && value !== 'every') throw new PrepareError("prepare in main's .gate/driver.json must be first or every");
  return value ?? 'first';
}

/** A commit id as --main takes it: 40 hex digits (SHA-1) or 64 (SHA-256). */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// dsh-superagent-prototype gives a workspace's prepare "ten minutes to finish" (docs/003-execution.md:51 at 8c32a9d).
const TIME_MS = 10 * 60_000;
// research-git's guard (bin/lib/research-git.mjs): no pager, hooks, fsmonitor, bare repository found by looking, or file transport.
const BASE = ['--no-pager', '-c', 'safe.bareRepository=explicit', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never'];

const lastLine = (text) => text.trim().split('\n').at(-1)?.slice(0, 300) ?? '';

/** The stamp of a worktree's first install: its real path and its folder's inode, so a folder made again at the same path is new. */
export const stampOf = (state, work) =>
  join(state, 'prepared', createHash('sha256').update(`${realpathSync(work)}\0${statSync(work).ino}`).digest('hex').slice(0, 32));

/** The id git gives content of a type: the hash of "<type> <size>\0<content>", SHA-1 or SHA-256 by the id's length. */
const idOf = (type, content, length) => createHash(length === 64 ? 'sha256' : 'sha1').update(`${type} ${content.length}\0`).update(content).digest('hex');

/** The objects of the work folder's store, each read by its id and checked against it: read([[id, type], ...]) gives each one's content,
 * or null for one that is missing, of another type, or whose content is not the id's. One `git cat-file --batch` for each call. */
function storeOf(work, env) {
  return (wanted) => {
    if (!wanted.length) return [];
    const r = spawnSync('git', ['-C', work, ...BASE, 'cat-file', '--batch'], {
      env: { ...env, GIT_NO_REPLACE_OBJECTS: '1' }, input: `${wanted.map(([id]) => id).join('\n')}\n`, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 30, timeout: 60_000,
    });
    if (r.error?.code === 'ENOENT') throw new PrepareError(`git is not on bin/seat's PATH (${env.PATH ?? ''}), so main's gate_prepare could not be read`);
    const out = r.stdout ?? Buffer.alloc(0);
    let at = 0;
    return wanted.map(([id, type]) => {
      const nl = out.indexOf(10, at);
      if (nl < 0) return null;
      const [, got, size] = out.subarray(at, nl).toString().split(' ');
      if (size === undefined) {
        at = nl + 1;
        return null;
      }
      const content = out.subarray(nl + 1, nl + 1 + Number(size));
      at = nl + 1 + Number(size) + 1;
      return got === type && idOf(type, content, id.length) === id ? content : null;
    });
  };
}

/** A tree's entries as { name: { mode, id } }; raw ids are 20 bytes for SHA-1 trees, 32 for SHA-256. */
function entriesOf(tree, length) {
  const entries = {};
  const raw = length === 64 ? 32 : 20;
  for (let at = 0; at < tree.length;) {
    const space = tree.indexOf(32, at);
    const nul = tree.indexOf(0, space);
    entries[tree.subarray(space + 1, nul).toString()] = { mode: tree.subarray(at, space).toString(), id: tree.subarray(nul + 1, nul + 1 + raw).toString('hex') };
    at = nul + 1 + raw;
  }
  return entries;
}

/** The first path where the work folder is not the tree (missing, extra, another kind, another executable bit, other content), or null
 * when it is the tree. It walks level by level and stops at the first difference, so a stale node_modules/ costs one listing. Only the
 * top .git is skipped; a submodule is a folder that exists. */
function firstDifference(work, tree, read, length) {
  let level = [['', tree]];
  while (level.length) {
    const trees = read(level.map(([, id]) => [id, 'tree']));
    const next = [];
    const blobs = [];
    for (const [index, [dir, id]] of level.entries()) {
      if (!trees[index]) return `${dir || '.'} (main's tree ${id.slice(0, 7)} does not read as itself here)`;
      const entries = entriesOf(trees[index], length);
      const names = new Map(readdirSync(join(work, dir), { withFileTypes: true }).filter((d) => !(dir === '' && d.name === '.git')).map((d) => [d.name, d]));
      for (const name of names.keys()) if (!entries[name]) return join(dir, name);
      for (const [name, { mode, id: child }] of Object.entries(entries)) {
        const path = join(dir, name);
        const here = names.get(name);
        if (!here) return path;
        if (mode === '40000') {
          if (!here.isDirectory()) return path;
          next.push([path, child]);
        } else if (mode === '160000') {
          if (!here.isDirectory()) return path;
        } else if (mode === '120000') {
          if (!here.isSymbolicLink() || idOf('blob', Buffer.from(readlinkSync(join(work, path))), length) !== child) return path;
        } else {
          if (!here.isFile() || (mode === '100755') !== ((statSync(join(work, path)).mode & 0o100) !== 0)) return path;
          blobs.push([path, child]);
        }
      }
    }
    for (const [path, id] of blobs) if (idOf('blob', readFileSync(join(work, path)), length) !== id) return path;
    level = next;
  }
  return null;
}

/**
 * Runs main's gate_prepare in the work folder when the switch asks for it, main being the commit the Lead named (--main), with env (the
 * session's, scrubbed; no ANTHROPIC_* and no sandbox marker here, since this runs outside the sandbox). Returns the log's path, or null
 * when nothing ran. Throws a PrepareError that says why, the install's own error included, where an install was due and did not happen:
 * a failed install, a command missing from env.PATH, past its time, or a driver.json `prepare` it cannot read.
 */
export function prepareWork({ work, run, tag, state, env, main = null }) {
  // A work folder that is no clone (a worktree's .git is a file) starts as before.
  if (!existsSync(join(work, '.git'))) return null;
  const log = join(run, `run-${tag}.prepare.log`);
  const skip = (why) => {
    writeFileSync(log, `prepare: not run: ${why}\n`);
    return null;
  };
  if (main && !COMMIT.test(main)) throw new PrepareError(`--main ${main} is not a commit id`);
  // The commit a worktree was made at is the one the Lead gave at its first start: bin/seat records it beside the stamp, where no seat
  // writes, and every later start (a fix round, the reviewer) reads main there. A later --main that differs is noted and not used.
  const record = `${stampOf(state, work)}.main`;
  const recorded = existsSync(record) ? readFileSync(record, 'utf8').trim() : null;
  let head = '';
  if (recorded && main && main !== recorded) head = `prepare: --main ${main.slice(0, 7)} differs from ${recorded.slice(0, 7)}, the commit this worktree's first start was given; ${recorded.slice(0, 7)} is used\n`;
  if (!recorded && !main) return skip('bin/seat was given no --main, the commit of main the Lead read from GitHub, and this worktree has none recorded');
  if (!recorded) {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${main}\n`);
  }
  main = recorded ?? main;
  const skipNoted = (why) => {
    writeFileSync(log, `${head}prepare: not run: ${why}\n`);
    return null;
  };
  const read = storeOf(work, env);
  const whole = (id, type) => read([[id, type]])[0];
  const notWhole = `main's commit ${main.slice(0, 7)} is not whole in this clone (git fetch origin, then start again)`;
  const commit = whole(main, 'commit');
  const root = commit && /^tree ([0-9a-f]+)$/m.exec(commit.toString())?.[1];
  const top = root && whole(root, 'tree');
  if (!top) return skipNoted(notWhole);
  const gateEntry = entriesOf(top, main.length)['.gate'];
  if (!gateEntry || gateEntry.mode !== '40000') return null;
  const gate = whole(gateEntry.id, 'tree');
  if (!gate) return skipNoted(notWhole);
  const files = entriesOf(gate, main.length);
  if (!files['config.sh']) return null;
  const config = whole(files['config.sh'].id, 'blob');
  const driverText = files['driver.json'] ? whole(files['driver.json'].id, 'blob') : Buffer.from('{}');
  if (!config || !driverText) return skipNoted(notWhole);
  let driver;
  try {
    driver = JSON.parse(driverText.toString());
  } catch {
    throw new PrepareError("main's .gate/driver.json is not JSON");
  }
  const when = prepareWhen(driver);
  const stamp = stampOf(state, work);
  if (when === 'first') {
    if (existsSync(stamp)) return null;
    const differs = firstDifference(work, root, read, main.length);
    if (differs) return skipNoted(`the worktree differs from main's commit ${main.slice(0, 7)} at ${differs}, so its first install would run what main never had; a worktree made at that commit gets it`);
  }
  const r = spawnSync('/bin/bash', ['-c', `${config.toString()}\ngate_prepare "$1"`, 'gate_prepare', work], {
    cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIME_MS, killSignal: 'SIGKILL', maxBuffer: 64 << 20,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(log, `${head}${out}`);
  if (r.error?.code === 'ETIMEDOUT') throw new PrepareError(`main's gate_prepare ran past its ten minutes; its output is in ${log}`);
  if (r.error) throw new PrepareError(`main's gate_prepare could not run (${r.error.code ?? r.error.message}); its output is in ${log}`);
  // 127 is bash's "command not found": what gate_prepare runs must be on bin/seat's PATH (FAC-108).
  if (r.status === 127) throw new PrepareError(`main's gate_prepare runs a command that is not on bin/seat's PATH (${env.PATH ?? ''}): ${lastLine(out)}; its output is in ${log}`);
  if (r.status !== 0) throw new PrepareError(`main's gate_prepare failed (exit ${r.status ?? r.signal}): ${lastLine(out)}; its output is in ${log}`);
  if (when === 'first') {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, `${JSON.stringify({ work, main, at: new Date().toISOString() })}\n`);
  }
  return log;
}
