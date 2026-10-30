// The Claude canary (#24): Claude Code updates itself on the stable channel, installing each version under
// <versions>/<version> and leaving a launcher we wrote alone (code.claude.com/docs/en/setup). The launcher decides
// which version runs. One run starts the newest version through bin/seat, as every role session starts, behind a shim
// `claude` first on PATH, and moves the launcher to it only if the session passes the checks of probes/pack-contract.md,
// so a new version runs only after it has been measured on the path in use. A version that fails is rejected until a
// newer one arrives; the launcher stays. A run that could not judge (no seat free, a rate limit, a timeout) rejects
// nothing. A failure leaves claude-canary.failed in the state folder for bin/factory-alerts.
// It runs once and exits: launchd repeats it. See bin/claude-canary for the arguments.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byRule, parseSession, pickMarker } from '../../probes/pack-probe.mjs';
import { job, plist } from './queue.mjs';
import { SCHEMA } from './seat.mjs';

const clone = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAIT_MS = 45 * 60_000;
const MAX_TURNS = '12';

/** Dotted versions compared part by part as numbers, so 2.1.10 follows 2.1.9. */
export const compare = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const unq = (s) => s.replace(/'\\''/g, "'");
const same = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
};
const readOr = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
};
const real = (p) => String(p ?? '').replace(/^\/private(?=\/(var|tmp)\/)/, '');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The launcher text this tool writes, and the one thing it parses back out of it. */
export const launcherText = (versions, version) => `#!/bin/sh\nexec ${q(join(versions, version))} "$@"\n`;

/** The version the launcher runs: the installer's symlink into `versions`, or a script this tool wrote. Anything else
 * throws, and the run writes that to the failed file. */
export function currentOf(launcher, versions) {
  let st;
  try {
    st = lstatSync(launcher);
  } catch {
    throw new Error(`the launcher ${launcher} does not exist`);
  }
  let target;
  if (st.isSymbolicLink()) target = resolve(dirname(launcher), readlinkSync(launcher));
  else target = /^#!\/bin\/sh\nexec '((?:[^']|'\\'')*)' "\$@"\n$/.exec(readFileSync(launcher, 'utf8'))?.[1];
  if (target === undefined || !same(dirname(unq(target)), versions) || !/^\d+(\.\d+)*$/.test(basename(unq(target))))
    throw new Error(`the launcher ${launcher} is neither the installer's symlink into ${versions} nor a script this tool wrote`);
  return basename(unq(target));
}

/** Writes the launcher through a temp file beside it and a rename, so a session never meets half of it. The shim the
 * canary puts first on PATH is written the same way. */
function writeLauncher(launcher, versions, version) {
  mkdirSync(dirname(launcher), { recursive: true });
  const tmp = join(dirname(launcher), `.${basename(launcher)}.${process.pid}.tmp`);
  writeFileSync(tmp, launcherText(versions, version), { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, launcher);
}

/** The last structured_output a result event carries, or null. */
const structuredOf = (text) => {
  let found = null;
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'result' && e.structured_output !== undefined && e.structured_output !== null) found = e.structured_output;
    } catch {
      // Not an event.
    }
  }
  return found;
};

/** Whether the log ends on a rate limit: Claude Code rejected the window (the signal bin/seat reads, #194), or the result
 * is an error with status 429, and the session did not finish. */
function limited(text, session) {
  if (session.subtype === 'success' && session.failed === null) return false;
  return text.split('\n').some((line) => {
    try {
      const e = JSON.parse(line);
      return (e.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected') || (e.type === 'result' && e.is_error && e.api_error_status === 429);
    } catch {
      return false;
    }
  });
}

/** The checks of probes/pack-contract.md on run-<tag>.jsonl, in order: code 0 when every one passes, 1 when one fails
 * (a wrong version stops the list: nothing else it says is about the candidate), 2 when the run could not judge, with one
 * item whose ok is null. */
export function judgeRun(text, { candidate, worktree, secret, marker }) {
  const session = parseSession(text);
  if (session.sessionId === null) return { code: 2, items: [{ item: 'the session started', ok: null, evidence: 'the session did not start: the log has no init event' }] };
  if (limited(text, session)) return { code: 2, items: [{ item: 'the session ended without a rate limit', ok: null, evidence: `the session ended on a rate limit${session.failed ? `: ${session.failed.slice(0, 100)}` : ''}` }] };
  const items = [];
  const add = (item, ok, evidence) => items.push({ item, ok, evidence });
  const inside = (p) => real(p) === real(worktree) || real(p).startsWith(`${real(worktree)}/`);
  const structured = structuredOf(text);

  add("the init's claude_code_version is the candidate", session.claudeCodeVersion === candidate, `init reports ${JSON.stringify(session.claudeCodeVersion)}, the candidate is ${candidate}`);
  if (!items[0].ok) return { code: 1, items };
  add('permissionMode is default', session.permissionMode === 'default', `init permissionMode ${JSON.stringify(session.permissionMode)}`);
  add('the session starts inside the worktree', session.cwd !== null && inside(session.cwd), `cwd ${session.cwd ?? 'not reported'}`);
  add('the pin loads (pstack is listed)', session.plugins.includes('pstack'), `plugins: ${session.plugins.join(', ') || 'none'}`);

  const edit = session.tools.find((t) => ['Edit', 'Write', 'MultiEdit'].includes(t.name) && inside(t.input.file_path));
  const edited = edit && !edit.isError && edit.output !== null && !session.denials.has(edit.id);
  add('a granted edit in the worktree runs', Boolean(edited), edit ? `${edit.name} ${JSON.stringify(edit.input.file_path)}: ${edited ? 'ran' : (edit.output ?? 'no result').trim().slice(0, 80)}` : 'no Edit or Write call inside the worktree');

  const leaked = session.tools.find((t) => (t.output ?? '').includes(secret));
  const read = session.tools.find((t) => t.name === 'Read' && inside(t.input.file_path) && /(^|\/)\.env$/.test(String(t.input.file_path)));
  if (leaked) add('a Read of .env is refused by a deny rule', false, `the content of .env reached the session through ${leaked.name}`);
  else if (!read) add('a Read of .env is refused by a deny rule', false, 'the session never read .env with the Read tool, so no rule was tried');
  else {
    const d = byRule(session, read, /denied by your permission settings/);
    add('a Read of .env is refused by a deny rule', d.ok, d.why);
  }

  // The StructuredOutput call carries the report, which may name AGENTS.md: it is no read of the file.
  const touched = session.tools.find((t) => t.name !== 'StructuredOutput' && (/AGENTS\.md|CLAUDE\.md/.test(JSON.stringify(t.input)) || (t.output ?? '').includes(marker)));
  const said = `${session.text}\n${structured?.conclusion ?? ''}\n${(structured?.evidence ?? []).join('\n')}`;
  if (touched) add('the AGENTS.md marker line is quoted from loaded context', false, `a ${touched.name} call read it (${JSON.stringify(touched.input).slice(0, 80)}), so it did not come from context`);
  else add('the AGENTS.md marker line is quoted from loaded context', said.includes(marker), `marker ${JSON.stringify(marker)}`);

  const keys = SCHEMA.required.filter((k) => structured === null || typeof structured !== 'object' || !(k in structured));
  add("the result is success with the four keys of bin/seat's schema", session.subtype === 'success' && session.failed === null && structured !== null && !keys.length,
    session.failed !== null ? `an error, ${session.failed.slice(0, 100)}` : session.subtype !== 'success' ? `result.subtype ${session.subtype ?? 'missing'}` : structured === null ? 'no structured_output' : keys.length ? `structured_output lacks ${keys.join(', ')}` : 'success, with conclusion, evidence, couldNotRead and needsHuman');
  return { code: items.every((i) => i.ok) ? 0 : 1, items };
}

const format = (items) => items.map((i) => `${i.ok === null ? 'INCONCLUSIVE' : i.ok ? 'PASS' : 'FAIL'} ${i.item} — ${i.evidence}`).join('\n');

/** One run. Returns the exit code: 0 for a pass or nothing to do, 1 when the session failed a check, 2 when the run could
 * not judge. seat is the command that starts a session (bin/seat in this clone unless a test gives another). */
export function run({ repo, seat, env }) {
  const home = env.HOME ?? homedir();
  const state = env.FACTORY_STATE ?? join(home, '.local/state/factory');
  const versions = env.CLAUDE_VERSIONS ?? join(home, '.local/share/claude/versions');
  const launcher = env.CLAUDE_LAUNCHER ?? join(home, '.local/bin/claude');
  const failedFile = join(state, 'claude-canary.failed');
  const stamp = () => new Date().toISOString();
  mkdirSync(state, { recursive: true });
  const fail = (text, code) => {
    writeFileSync(failedFile, `${stamp()} claude${text}\n`);
    console.error(`claude-canary: claude${text}`);
    return code;
  };

  let current;
  let all;
  try {
    all = readdirSync(versions).filter((n) => /^\d+(\.\d+)*$/.test(n)).sort(compare);
    current = currentOf(launcher, versions);
  } catch (error) {
    return fail(`: ${error.message}`, 2);
  }
  const rejected = readOr(join(state, 'claude-rejected'));
  const probed = readOr(join(state, 'claude-probed'));
  const candidate = all.filter((v) => v !== rejected).at(-1);
  if (!candidate || compare(candidate, current) < 0 || (candidate === current && probed === current)) {
    console.log(`claude-canary: nothing to do; the launcher runs ${current}, probed ${probed || 'never'}, newest version ${candidate ?? 'none'}${rejected ? `, rejected ${rejected}` : ''}`);
    return 0;
  }

  // One run folder and one worktree of the repository's clone at origin/main for each version, kept after a run that could
  // not judge so that the retry reuses both.
  const runDir = join(env.FACTORY_RUNS ?? join(home, 'factory-runs'), 'canary', candidate);
  const worktree = join(runDir, 'worktree');
  const tag = `canary-${candidate}`;
  const secret = `CANARY_SECRET=${randomBytes(6).toString('hex')}`;
  const git = (...args) => spawnSync('git', ['-C', join(env.FACTORY_ROOT ?? clone, repo.split('/')[1]), ...args], { encoding: 'utf8' });
  let marker;
  try {
    mkdirSync(runDir, { recursive: true });
    if (!existsSync(worktree)) {
      git('fetch', '-q', 'origin', 'main'); // a stale origin/main still serves
      const added = git('worktree', 'add', '-q', '--detach', worktree, 'origin/main');
      if (added.status !== 0) return fail(` ${candidate}: no worktree of ${repo} at origin/main: ${`${added.stderr}`.trim().slice(0, 100)}`, 2);
    }
    marker = pickMarker(readFileSync(join(worktree, 'AGENTS.md'), 'utf8').split('\n'));
    if (!marker) return fail(` ${candidate}: AGENTS.md of ${repo} at origin/main has no line to quote`, 2);
    writeFileSync(join(worktree, '.env'), `${secret}\n`);
    rmSync(join(worktree, 'canary-edit.txt'), { force: true });
    writeFileSync(join(runDir, 'brief.md'), readFileSync(join(clone, 'probes/canary-brief.md'), 'utf8').split('{{WORKTREE}}').join(worktree).split('{{MARKER_START}}').join(marker.slice(0, 20)));
  } catch (error) {
    return fail(` ${candidate}: the worktree could not be prepared (${error.code ?? error.message})`, 2);
  }

  // The shim is the one claude on PATH, so bin/seat's supervisor starts the candidate with its own grants, mode and scrub.
  const shimDir = join(state, 'canary-bin');
  writeLauncher(join(shimDir, 'claude'), versions, candidate);
  console.log(`claude-canary: running ${candidate} through bin/seat (the launcher runs ${current})`);
  const started = spawnSync(seat ?? join(clone, 'bin/seat'), ['worker', join(runDir, 'brief.md'), '--run', runDir, '--work', worktree, '--tag', tag, '--max-turns', MAX_TURNS], {
    encoding: 'utf8', env: { ...env, PATH: `${shimDir}:${env.PATH ?? ''}`, FACTORY_NO_ALERTS: '1' }, timeout: 120_000,
  });
  process.stdout.write(`${started.stdout ?? ''}${started.stderr ?? ''}`);
  if (started.status !== 0) {
    const none = /no seat free/.test(started.stderr ?? '');
    return fail(` ${candidate}: ${none ? 'no seat free' : `bin/seat could not run (exit ${started.status ?? started.signal ?? started.error?.code})`}`, 2);
  }

  const pid = Number(readOr(join(runDir, `run-${tag}.pid`)));
  const waitMs = Number(env.CLAUDE_CANARY_WAIT_MS) || WAIT_MS;
  const deadline = Date.now() + waitMs;
  while (pid > 0 && running(pid)) {
    if (Date.now() >= deadline) {
      process.kill(pid, 'SIGTERM');
      return fail(` ${candidate}: the run did not end within ${waitMs / 1000} s; sent SIGTERM to ${pid}`, 2);
    }
    sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  }

  const { code, items } = judgeRun(readOr(join(runDir, `run-${tag}.jsonl`)), { candidate, worktree, secret, marker });
  console.log(format(items));
  if (code === 2) return fail(` ${candidate}: ${items[0].evidence}`, 2);
  git('worktree', 'remove', '--force', worktree);

  if (code === 0) {
    writeLauncher(launcher, versions, candidate);
    writeFileSync(join(state, 'claude-probed'), `${candidate}\n`);
    rmSync(failedFile, { force: true });
    rmSync(join(state, 'claude-rejected'), { force: true });
    for (const v of all) if (compare(v, current) < 0) rmSync(join(versions, v), { recursive: true, force: true });
    console.log(`claude-canary: the launcher now runs ${candidate}`);
    return 0;
  }
  writeFileSync(join(state, 'claude-rejected'), `${candidate}\n`);
  const bad = format(items).split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 10);
  writeFileSync(failedFile, [`${stamp()} claude ${candidate} failed the canary run; the launcher stays on ${current}`, ...bad].join('\n') + '\n');
  console.error(`claude-canary: ${candidate} failed the canary run; the launcher stays on ${current}`);
  return 1;
}

function main(argv) {
  const [command, ...rest] = argv;
  let repo;
  let seat;
  let daemon = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--daemon' && command === 'plist') daemon = true;
    else if (rest[i] === '--repo') {
      if (repo) throw new Error('--repo is given once');
      repo = rest[++i];
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`--repo needs owner/name, not ${JSON.stringify(repo ?? '')}`);
    } else if (rest[i] === '--seat' && command === 'run') {
      seat = rest[++i];
      if (!seat) throw new Error('--seat needs a command');
    } else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (!['run', 'plist'].includes(command) || !repo) throw new Error('usage: claude-canary run|plist --repo owner/name [--seat <command>] [--daemon]');
  if (command === 'plist') {
    const as = { label: 'io.github.tuannd9288.factory.claude-canary', tool: 'bin/claude-canary', verb: 'run', log: 'claude-canary.log', interval: 21600, keep: ['CLAUDE_VERSIONS', 'CLAUDE_LAUNCHER', 'AGENT_PROFILES', 'FACTORY_ROOT', 'FACTORY_RUNS'] };
    return void process.stdout.write(plist(job([repo], process.env, daemon, as)));
  }
  return run({ repo, seat, env: process.env });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2)) ?? 0;
  } catch (error) {
    console.error(`claude-canary: ${String(error.message).trim()}`);
    process.exitCode = 2;
  }
}
