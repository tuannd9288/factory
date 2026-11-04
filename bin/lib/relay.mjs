// The MacBook's relay of a Lead's news (#370, slice 2; the Human's "A", 2026-11-03: one sweep on each Mac, the local inbox-socket wake).
// The Mac mini's sweep wakes the Leads that run there and writes each of the six news lines to its events with the delivery as data
// (bin/lib/news-wake.mjs: `lead`, `woke`, `why`, `what`, `where`). One pass of this reads those lines by ssh (bin/factory-events --news
// --after <cursor>, which keeps its own cursor and never moves it for a look) and posts the line again, into the socket file of the Lead
// that runs on this machine (`factory lead --here` records it: wakeFile, bin/lib/factory.mjs), for a line whose Lead the Mac mini could not
// wake for want of a live Lead there: `woke` false and `why` 'no file' or 'refused'. Never for 'timed out' (a Lead that runs there, busy),
// 'not ours', 'not a socket', or a line with no Lead, and never when this machine has no socket file for the Lead. The fields are read as
// data; the text is never parsed. The cursor, $FACTORY_STATE/relay.cursor, is written through a temporary file and a rename after each
// line, so a line is relayed once; a post that fails is logged and not tried again. A pass with no cursor, or whose cursor is above the
// Mac mini's highest seq (its file was made anew), only learns the newest seq (`--news --newest`, which prints that number and no line),
// puts the cursor there and wakes nothing. The ssh read has a 64 MiB buffer; a read that fails, a full buffer included, is told as a failure
// and leaves the cursor. A line is relayed only when `what` and `where` are at most 300 characters each and `where` is a https://github.com/
// URL or an absolute path on the Mac mini, which is posted as `<host>:<path>`. It calls no gh, reads no token, and logs a line's kind and
// key alone. On the factory host the sweep delivers, so `run` and `check` refuse to run there.
// `plist` is the LaunchAgent that runs a pass every 60 s under the Human's own user (no sudo). macOS's privacy protection refuses a launchd
// job ~/Desktop, ~/Documents, ~/Downloads and ~/Library/Mobile Documents (the clone on the MacBook sits under ~/Desktop: exit 126, #370),
// and Full Disk Access is not asked for. So the job runs from a copy outside them: `plist` writes the clone's committed HEAD (`git archive`,
// the whole tree, since the imports reach bin/, packs/ and kit/) into ~/.local/share/factory/relay/<sha>/, through a temporary folder and a
// rename, reusing a folder that is there; points the symlink relay/current at it by a rename, which is atomic; removes the other folders in
// relay/; and prints the job with relay/current as its program and folder. An uncommitted change is not copied, and `plist` says so on
// stderr. After a pull, `plist` again refreshes the copy, and the loaded job needs no reload. `plist` and `check` refuse a linked worktree
// (guard) and note a branch other than main; the job's PATH holds the folder `which` finds node in, ssh's folder and the system folders.
// `check` fails, saying which path, when the program, the folder, the copy (by real path), the log or the state folder sits under a protected
// folder, when an installed ~/Library/LaunchAgents plist names such a path, when the copy or its bin/factory-relay is not there and
// executable, and, for a loaded job, when `launchctl print` reports a last exit code other than 0 (no launchctl, or not loaded: skipped).
// It probes ssh with the SSH_AUTH_SOCK `launchctl getenv` gives, which is what launchd gives the job, and none when that is empty; it reads
// the newest seq, relays nothing, and sets the cursor only when there is none.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLine } from './events.mjs';
import { contextOf, placeOf, wakeFile } from './factory.mjs';
import { parseTeam } from './names.mjs';
import { NEWS_KINDS } from './news-wake.mjs';
import { plist } from './queue.mjs';
import { newsLine, post as postLine, recordedPath } from './wake.mjs';

export const HOST = 'factory@tuans-mac-mini';
export const REMOTE = '/Users/factory/WORKSPACES/bin/factory-events';
export const LABEL = 'io.github.tuannd9288.factory.relay';
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];
const SSH_MS = 60_000;

/** The reasons the Mac mini gives for a line it did not deliver that mean no Lead runs there: nothing recorded (or the socket is gone), or
 * nothing listens. */
export const RELAYED_WHY = new Set(['no file', 'refused']);

/** What a relayed line's `what` and `where` may be: at most this many characters each. */
export const FIELD_MAX = 300;

/** The most the ssh read may print: as the queue's gh() has, so a long file of news is an answer and not an ENOBUFS. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** One ssh read of the Mac mini's news: { status, stdout, stderr, error }. A read that fails, an exceeded buffer included, has no status 0. */
function readRemote(args, { run = spawnSync, env = process.env } = {}) {
  const r = run('ssh', [...SSH_OPTIONS, HOST, REMOTE, '--news', ...args], { encoding: 'utf8', timeout: SSH_MS, maxBuffer: MAX_BUFFER, env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '', error: r.error };
}

/** The news lines after `after`, read from the Mac mini by ssh. */
export const readNews = (after, opts) => readRemote(['--after', String(after)], opts);

/** The newest news seq, from the Mac mini: its stdout is that number alone (`--news --newest`), so no line is read. */
export const readNewest = (opts) => readRemote(['--newest'], opts);

function readCursor(file) {
  try {
    const n = Number(readFileSync(file, 'utf8').trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function writeCursor(file, seq) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${seq}\n`);
  renameSync(tmp, file);
}

const parse = (text) =>
  text.split('\n').flatMap((l) => {
    try {
      const e = l.trim() ? JSON.parse(l) : null;
      return e?.type === 'start' && Number.isInteger(e.seq) && NEWS_KINDS.has(e.kind) ? [e] : [];
    } catch {
      return [];
    }
  });

/** What to do with one line: { file, line } to post, or { skip } with the reason. Only the fields are read. */
function decide(e, state) {
  if (e.woke === true) return { skip: 'the Mac mini woke it' };
  if (typeof e.lead !== 'string') return { skip: 'no Lead named' };
  if (!RELAYED_WHY.has(e.why)) return { skip: `the Mac mini's reason is ${oneLine(e.why ?? 'none')}` };
  const team = parseTeam(e.lead);
  if (!team) return { skip: 'the Lead name is not a team' };
  const file = wakeFile(state, team.repo, team.team);
  if (recordedPath(file) === null) return { skip: 'no socket file here' };
  if (typeof e.what !== 'string' || typeof e.where !== 'string') return { skip: 'the line has no what and where' };
  if (e.what.length > FIELD_MAX || e.where.length > FIELD_MAX) return { skip: `what or where is over ${FIELD_MAX} characters` };
  // The sweep writes both through oneLine (bin/lib/events.mjs): a line it would have changed (a newline, a control character, a secret) did not come from it.
  if (oneLine(e.what) !== e.what || oneLine(e.where) !== e.where) return { skip: 'what or where is not as the Mac mini writes it' };
  // `where` is a pull request's URL or a path on the Mac mini; a path is posted with the host, so a Lead here knows where it is.
  const url = /^https:\/\/github\.com\//.test(e.where);
  if (!url && !e.where.startsWith('/')) return { skip: 'where is neither a GitHub URL nor an absolute path' };
  return { file, line: newsLine(e.kind, e.what, url ? e.where : `${HOST}:${e.where}`) };
}

const failed = (r) => `relay: ssh to the Mac mini failed (${r.status ?? r.error?.code ?? 'no status'}): ${oneLine(r.stderr)}`;

/** Puts the cursor at the Mac mini's newest news seq, learned from `--news --newest` and not from the lines. Returns 0, or 1 when the read
 * failed or did not answer with a number (the cursor stays). */
function reseat(cursorFile, newest, log) {
  const r = newest();
  const seq = /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
  if (r.status !== 0 || !Number.isSafeInteger(seq)) {
    log(failed(r));
    return 1;
  }
  writeCursor(cursorFile, seq);
  log('relay: cursor set to the newest news; nothing woken');
  return 0;
}

/** One pass. `fetch`, `newest` and `post` are passed in for tests. Returns 0, or 1 when ssh failed (the cursor stays). A pass with no cursor,
 * or with one above the Mac mini's newest (its file was made anew), only learns the newest seq: it reads no line and wakes nothing. */
export async function pass({ state, fetch = readNews, newest = readNewest, post = postLine, log = console.log }) {
  const cursorFile = join(state, 'relay.cursor');
  const kept = readCursor(cursorFile);
  if (kept === null) return reseat(cursorFile, newest, log);
  const r = fetch(kept);
  if (r.status !== 0) {
    log(failed(r));
    return 1;
  }
  if (/above the highest seq/.test(r.stderr)) return reseat(cursorFile, newest, log);
  const events = parse(r.stdout).sort((a, b) => a.seq - b.seq);
  for (const e of events.filter((x) => x.seq > kept)) {
    const what = `${e.kind} ${oneLine(e.key ?? '')}`;
    const d = decide(e, state);
    let said = `not relayed (${d.skip})`;
    if (d.file) {
      const p = await post(d.file, d.line);
      said = p.posted ? 'relayed' : `not relayed (${p.why})`;
    }
    writeCursor(cursorFile, e.seq);
    log(`relay: ${what}: ${said}`);
  }
  return 0;
}

/** The first executable `name` on a PATH, or null. */
function which(name, path) {
  for (const dir of (path ?? '').split(':').filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

/** The folders macOS refuses a launchd job, under the home folder. */
const PROTECTED = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'];

/** Where the job's copy of the clone lives: <relayDir>/<sha>/, and `current` there is the symlink to the one in use. */
export const relayDir = (env) => join(env.HOME, '.local/share/factory/relay');

/** The real path of `p` through its symlinks, even when `p` is not there yet: the nearest folder that is, with the rest added. */
function realish(p) {
  const rest = [];
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      if (dirname(cur) === cur) return resolve(p);
      rest.unshift(basename(cur));
    }
  }
}

/** The protected folder (as `~/Desktop`, say) that `path` really sits under, or null. */
export function protectedFolder(path, home) {
  const real = realish(path);
  for (const f of PROTECTED) {
    for (const dir of new Set([join(realish(home), f), realish(join(home, f))])) if (real === dir || real.startsWith(`${dir}${sep}`)) return `~/${f}`;
  }
  return null;
}

/** Writes the committed HEAD of the clone at `root` into relay/<sha>/ and points relay/current at it; returns { sha, dirty }, `dirty` being
 * an uncommitted change that is not copied. A folder for that sha already there is reused; the others in relay/ are removed. */
export function install(root, env = process.env) {
  if (!env.HOME?.startsWith('/')) throw new Error('HOME is not an absolute path');
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  const sha = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`cannot read HEAD of ${root}`);
  const base = relayDir(env);
  const dest = join(base, sha);
  mkdirSync(base, { recursive: true });
  if (!existsSync(dest)) {
    const tmp = mkdtempSync(join(base, '.copy-'));
    const tar = `${tmp}.tar`;
    try {
      const made = git('archive', '--format=tar', '-o', tar, 'HEAD');
      const out = made.status === 0 ? spawnSync('tar', ['-xf', tar, '-C', tmp], { encoding: 'utf8' }) : made;
      if (out.status !== 0) throw new Error(`cannot copy HEAD of ${root}: ${oneLine(out.stderr || out.error?.message || `exit ${out.status}`)}`);
      try {
        renameSync(tmp, dest);
      } catch (error) {
        if (!existsSync(dest)) throw error;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tar, { force: true });
    }
  }
  // A symlink made under another name and renamed over `current` is swapped at once; `ln -sfn` removes the old link first.
  const next = join(base, `.current-${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(sha, next);
  renameSync(next, join(base, 'current'));
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    if (name !== 'current' && name !== sha && dirname(path) === base) rmSync(path, { recursive: true, force: true });
  }
  return { sha, dirty: git('status', '--porcelain').stdout.trim() !== '' };
}

/** The LaunchAgent's job, in the shape queue.mjs's plist renders: `run` every 60 s from the copy `install` makes, with a PATH that finds node
 * and ssh, logging to ~/Library/Logs/factory/relay.log (launchd does not make the folder; `check` does). No user: it runs under whoever loads it. */
export function job(env = process.env) {
  const node = which('node', env.PATH) ?? process.execPath;
  const ssh = which('ssh', env.PATH) ?? '/usr/bin/ssh';
  // The folder `which` finds node in, as the shell has it (Homebrew's link folder, which an upgrade keeps), not the versioned one `process.execPath` names.
  const path = [...new Set([dirname(node), dirname(ssh), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const kept = Object.fromEntries(['FACTORY_STATE', 'FACTORY_HOST_USER'].filter((k) => env[k]).map((k) => [k, env[k]]));
  const copy = join(relayDir(env), 'current');
  return { label: LABEL, interval: 60, calendar: null, program: [join(copy, 'bin/factory-relay'), 'run'], cwd: copy, env: { PATH: path, ...kept }, log: join(env.HOME, 'Library/Logs/factory/relay.log'), user: null };
}

/** What the checkout at `root`, which `plist` and `check` run from and the job would point at, is: { refuse, note }. A linked worktree
 * (`--git-dir` differs from `--git-common-dir`) is refused, since the job would run a folder that goes away with the worktree; a branch
 * other than main is only noted. A folder git cannot read is neither. */
export function guard(root) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const dir = git('rev-parse', '--git-dir');
  const common = git('rev-parse', '--git-common-dir');
  if (dir.status !== 0 || common.status !== 0) return { refuse: null, note: null };
  if (resolve(root, dir.stdout.trim()) !== resolve(root, common.stdout.trim())) return { refuse: `${root} is a linked worktree, which goes away; run this from the clone itself`, note: null };
  const branch = git('branch', '--show-current').stdout.trim();
  return { refuse: null, note: branch === 'main' ? null : `${root} is on ${branch ? `branch ${branch}` : 'no branch'}, not main` };
}

/** What launchd would meet that a terminal does not: the problems with the job's paths, the installed plist and the loaded job, as lines
 * (empty when there are none). `launchd(args)` runs launchctl in the job's environment. */
function preflight(j, state, env, launchd) {
  const problems = [];
  const copy = join(relayDir(env), 'current');
  const paths = [['program', j.program[0]], ['working folder', j.cwd], ['copy', copy], ['log', j.log], ['state folder', state]];
  for (const [what, path] of paths) {
    const folder = protectedFolder(path, env.HOME);
    if (folder) problems.push(`the ${what} ${path} (really ${realish(path)}) sits under ${folder}, which macOS refuses a launchd job`);
  }
  try {
    accessSync(j.program[0], constants.X_OK);
  } catch {
    problems.push(`the copy is not there or ${j.program[0]} is not executable; run \`bin/factory-relay plist\` from the clone`);
  }
  const installed = join(env.HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
  if (existsSync(installed)) {
    const names = [...readFileSync(installed, 'utf8').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).filter((s) => s.startsWith('/'));
    for (const path of names) {
      const folder = protectedFolder(path, env.HOME);
      if (folder) problems.push(`the installed ${installed} names ${path}, under ${folder}, which macOS refuses a launchd job; write it again from \`bin/factory-relay plist\`, then \`launchctl bootout\` and \`launchctl bootstrap\` the job`);
    }
  }
  // Not loaded, or no launchctl: nothing to read, which is not a failure.
  const printed = launchd(['print', `gui/${process.getuid?.()}/${LABEL}`]);
  const last = printed.status === 0 ? /last exit code = (\d+)/.exec(printed.stdout ?? '') : null;
  if (last && last[1] !== '0') problems.push(`the loaded job's last exit code is ${last[1]}; reload it: \`launchctl bootout gui/$(id -u)/${LABEL}\`, then \`launchctl bootstrap gui/$(id -u) ${installed}\``);
  return problems;
}

/** Before the Human loads the job: makes the log's folder, fails on what launchd would refuse the job (see preflight), and says whether ssh
 * to the Mac mini works with no prompt (with the SSH_AUTH_SOCK `launchctl getenv` gives, which is the job's, and none when that is empty)
 * and whether the news can be read there. It relays nothing and posts nothing: it sets the cursor to the newest seq only when there is none.
 * Returns the exit code. */
export function check(env = process.env, note = null) {
  const j = job(env);
  const base = { HOME: env.HOME, USER: env.USER ?? '', TMPDIR: env.TMPDIR ?? '/tmp', ...j.env };
  const launchd = (args) => spawnSync('launchctl', args, { env: base, encoding: 'utf8' });
  const sock = launchd(['getenv', 'SSH_AUTH_SOCK']);
  const jobEnv = { ...base, ...(sock.status === 0 && sock.stdout?.trim() ? { SSH_AUTH_SOCK: sock.stdout.trim() } : {}) };
  const say = (line) => console.log(`check: ${line}`);
  if (note) say(note);
  mkdirSync(dirname(j.log), { recursive: true });
  say(`node ${spawnSync('node', ['--version'], { env: jobEnv, encoding: 'utf8' }).stdout?.trim() || 'not found'}`);
  const state = contextOf(jobEnv).state;
  say(`state folder ${state}`);
  say(`log ${j.log}`);
  say(`copy ${realish(join(relayDir(env), 'current'))}`);
  const problems = preflight(j, state, env, launchd);
  if (problems.length) {
    for (const p of problems) say(`not ready: ${p}`);
    return 1;
  }
  const probe = spawnSync('ssh', [...SSH_OPTIONS, HOST, 'true'], { env: jobEnv, encoding: 'utf8', timeout: SSH_MS });
  let why = null;
  if (probe.status !== 0) why = `ssh to the Mac mini does not work with no prompt: ${oneLine(probe.stderr || probe.error?.message || `exit ${probe.status}`)}`;
  else {
    const cursorFile = join(state, 'relay.cursor');
    const newest = readNewest({ env: jobEnv });
    if (newest.status !== 0 || !/^\d+$/.test(newest.stdout.trim())) why = `the Mac mini's news could not be read: ${oneLine(newest.stderr || `exit ${newest.status}`)}`;
    else if (readCursor(cursorFile) === null) writeCursor(cursorFile, Number(newest.stdout.trim()));
  }
  say(why ? `not ready: ${why}` : 'ready; the Human loads the job');
  return why ? 1 : 0;
}

/** The command. `root` is the checkout that runs it, passed in for tests. */
export async function main(argv, env = process.env, root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')) {
  const [command, ...rest] = argv;
  if (!['run', 'plist', 'check'].includes(command) || rest.length) throw new Error('usage: factory-relay run|plist|check');
  if (command !== 'plist' && placeOf(env) === 'factory') throw new Error('this is the factory host: its sweep delivers the news, so the relay runs on the MacBook');
  if (command === 'run') return pass({ state: contextOf(env).state });
  const g = guard(root);
  if (g.refuse) throw new Error(g.refuse);
  if (command === 'check') return check(env, g.note);
  if (g.note) console.error(`factory-relay: note: ${g.note}`);
  const copied = install(root, env);
  console.error(`factory-relay: the job runs from the copy of ${copied.sha}${copied.dirty ? '; an uncommitted change in the clone is not in it' : ''}`);
  return void process.stdout.write(plist(job(env)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    console.error(`factory-relay: ${error.message}`);
    process.exitCode = 2;
  }
}
