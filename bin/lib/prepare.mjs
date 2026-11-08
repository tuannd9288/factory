// bin/lib/prepare.mjs (FAC-108): before a seat's session, bin/seat makes the worktree ready to test with origin/main's gate_prepare
// (.gate/config.sh), outside the sandbox and with the network, so a worker can run its tests and pass the pre-commit hook in a repository
// whose code needs installed dependencies. The Human chose it on 2026-11-08 (INN-51): way 2, at the worktree's first start by default,
// so that outside the sandbox only a lockfile main had is installed. The sandbox keeps its network closed.
//   When: origin/main's .gate/driver.json `prepare`, absent or `first` (the worktree's first start) or `every` (every start).
//   What: origin/main's gate_prepare, read with `git show`, never the worktree's copy, run in the worktree with the session's own
//         scrubbed environment, its output in the run folder as run-<tag>.prepare.log. A main with no .gate/config.sh, or a work
//         folder with no origin/main, installs nothing.
//   First start: only in a worktree that holds nothing main lacks (HEAD on main's line, nothing changed or added), since what is
//         installed there is a tree main had; any other worktree installs nothing, gets no stamp, says why in that log, and its
//         session starts as before. Once an install passed, a stamp in $FACTORY_STATE/prepared/, where no seat can write, keyed to the
//         worktree's real path and folder, says the worktree is ready; a worker that removes anything in its worktree or run folder does
//         not bring the install back. A worktree removed and made again at the same path is a new folder and installs again.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class PrepareError extends Error {}

/** When the install runs: `first` (absent too) or `every`, from origin/main's .gate/driver.json; anything else is a PrepareError. */
export function prepareWhen(driver) {
  const value = driver?.prepare;
  if (value !== undefined && value !== 'first' && value !== 'every') throw new PrepareError("prepare in origin/main's .gate/driver.json must be first or every");
  return value ?? 'first';
}

// dsh-superagent-prototype gives a workspace's prepare "ten minutes to finish" (docs/003-execution.md:51 at 8c32a9d).
const TIME_MS = 10 * 60_000;

const lastLine = (text) => text.trim().split('\n').at(-1)?.slice(0, 300) ?? '';

/** The stamp of a worktree's first install: its real path and its folder's inode, so a folder made again at the same path is new. */
export const stampOf = (state, work) =>
  join(state, 'prepared', createHash('sha256').update(`${realpathSync(work)}\0${statSync(work).ino}`).digest('hex').slice(0, 32));

/**
 * Runs origin/main's gate_prepare in the work folder when the switch asks for it, with env (the session's, scrubbed; no ANTHROPIC_* and
 * no sandbox marker here, since this runs outside the sandbox). Returns the log's path, or null when nothing ran. Throws a PrepareError
 * that says why, the install's own error included, where an install was due and did not happen: a failed install, a command missing
 * from env.PATH, past its time, or a driver.json `prepare` it cannot read.
 */
export function prepareWork({ work, run, tag, state, env }) {
  // A work folder that is no clone (a worktree's .git is a file) starts as before.
  if (!existsSync(join(work, '.git'))) return null;
  const git = (...args) => {
    const r = spawnSync('git', ['-C', work, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    if (r.error?.code === 'ENOENT') throw new PrepareError(`git is not on bin/seat's PATH (${env.PATH ?? ''}), so origin/main's gate_prepare could not be read`);
    return r.status === 0 ? r.stdout : null;
  };
  if (git('rev-parse', '--verify', '--quiet', 'origin/main^{commit}') === null) return null;
  if (!git('ls-tree', 'origin/main', '--', '.gate/config.sh')) return null;
  let driver = {};
  if (git('ls-tree', 'origin/main', '--', '.gate/driver.json')) {
    try {
      driver = JSON.parse(git('show', 'origin/main:.gate/driver.json'));
    } catch {
      throw new PrepareError("origin/main's .gate/driver.json is not JSON");
    }
  }
  const when = prepareWhen(driver);
  const stamp = stampOf(state, work);
  const log = join(run, `run-${tag}.prepare.log`);
  if (when === 'first') {
    if (existsSync(stamp)) return null;
    // A tree main had: HEAD on main's line (behind a moved main still is), with nothing changed and nothing added, untracked files
    // included, since a lockfile a worker added where main has none would be installed as well. Any other worktree gets no install
    // and no stamp, and starts as before: a fix round or a reviewer in a worktree from before this, with a no-op gate_prepare too.
    const ahead = git('rev-list', '--count', 'origin/main..HEAD');
    const changed = git('status', '--porcelain', '--untracked-files=all');
    const holds = ahead === null || changed === null ? 'what git could not read' : Number(ahead) > 0 ? `${Number(ahead)} commit(s) main lacks` : changed.trim() ? 'changes main lacks' : null;
    if (holds) {
      writeFileSync(log, `prepare: not run: the worktree ${work} holds ${holds}, so its first install would run them outside the sandbox; a worktree made from origin/main gets it\n`);
      return null;
    }
  }
  const r = spawnSync('/bin/bash', ['-c', `${git('show', 'origin/main:.gate/config.sh')}\ngate_prepare "$1"`, 'gate_prepare', work], {
    cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIME_MS, killSignal: 'SIGKILL', maxBuffer: 64 << 20,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(log, out);
  if (r.error?.code === 'ETIMEDOUT') throw new PrepareError(`origin/main's gate_prepare ran past its ten minutes; its output is in ${log}`);
  if (r.error) throw new PrepareError(`origin/main's gate_prepare could not run (${r.error.code ?? r.error.message}); its output is in ${log}`);
  // 127 is bash's "command not found": what gate_prepare runs must be on bin/seat's PATH (FAC-108).
  if (r.status === 127) throw new PrepareError(`origin/main's gate_prepare runs a command that is not on bin/seat's PATH (${env.PATH ?? ''}): ${lastLine(out)}; its output is in ${log}`);
  if (r.status !== 0) throw new PrepareError(`origin/main's gate_prepare failed (exit ${r.status ?? r.signal}): ${lastLine(out)}; its output is in ${log}`);
  if (when === 'first') {
    mkdirSync(dirname(stamp), { recursive: true });
    writeFileSync(stamp, `${JSON.stringify({ work, main: git('rev-parse', 'origin/main')?.trim() ?? null, at: new Date().toISOString() })}\n`);
  }
  return log;
}
