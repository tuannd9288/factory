// The MacBook's relay of a Lead's news (#370, slice 2; the Human's "A", 2026-11-03: one sweep on each Mac, the local inbox-socket wake).
// The Mac mini's sweep wakes the Leads that run there and writes each of the six news lines to its events with the delivery as data
// (bin/lib/news-wake.mjs: `lead`, `woke`, `why`, `what`, `where`). One pass of this reads those lines by ssh (bin/factory-events --news
// --after <cursor>, which keeps its own cursor and never moves it for a look) and posts the line again, into the socket file of the Lead
// that runs on this machine (`factory lead --here` records it: wakeFile, bin/lib/factory.mjs), for a line whose Lead the Mac mini could not
// wake for want of a live Lead there: `woke` false and `why` 'no file' or 'refused'. Never for 'timed out' (a Lead that runs there, busy),
// 'not ours', 'not a socket', or a line with no Lead, and never when this machine has no socket file for the Lead. The fields are read as
// data; the text is never parsed. The cursor, $FACTORY_STATE/relay.cursor, is written through a temporary file and a rename after each
// line, so a line is relayed once; a post that fails is logged and not tried again. A pass with no cursor, or whose cursor is above the
// Mac mini's highest seq (its file was made anew), puts the cursor at the newest seq and wakes nothing. It calls no gh, reads no token, and
// logs a line's kind and key alone. On the factory host the sweep delivers, so the relay refuses to run there.
// `plist` is the LaunchAgent that runs a pass every 60 s under the Human's own user (no sudo); `check` runs one pass in the job's environment.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/** The news lines after `after`, read from the Mac mini by ssh: { status, stdout, stderr }. */
export function readNews(after, { run = spawnSync } = {}) {
  const r = run('ssh', [...SSH_OPTIONS, HOST, REMOTE, '--news', '--after', String(after)], { encoding: 'utf8', timeout: SSH_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
}

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
  return { file, line: newsLine(e.kind, e.what, e.where) };
}

/** One pass. `fetch` and `post` are passed in for tests. Returns 0, or 1 when ssh failed (the cursor stays). */
export async function pass({ state, fetch = readNews, post = postLine, log = console.log }) {
  const cursorFile = join(state, 'relay.cursor');
  const kept = readCursor(cursorFile);
  const r = fetch(kept ?? 0);
  if (r.status !== 0) {
    log(`relay: ssh to the Mac mini failed (${r.status ?? 'no status'}): ${oneLine(r.stderr)}`);
    return 1;
  }
  const events = parse(r.stdout).sort((a, b) => a.seq - b.seq);
  if (kept === null || /above the highest seq/.test(r.stderr)) {
    writeCursor(cursorFile, Math.max(0, ...events.map((e) => e.seq)));
    log('relay: cursor set to the newest news; nothing woken');
    return 0;
  }
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

/** The LaunchAgent's job, in the shape queue.mjs's plist renders: `run` every 60 s from this clone, with a PATH that finds node and ssh,
 * logging to ~/Library/Logs/factory/relay.log (launchd does not make the folder; `check` does). No user: it runs under whoever loads it. */
export function job(env = process.env) {
  const node = which('node', env.PATH) ?? process.execPath;
  const ssh = which('ssh', env.PATH) ?? '/usr/bin/ssh';
  const path = [...new Set([dirname(node), dirname(process.execPath), dirname(ssh), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const kept = Object.fromEntries(['FACTORY_STATE', 'FACTORY_HOST_USER'].filter((k) => env[k]).map((k) => [k, env[k]]));
  const factory = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return { label: LABEL, interval: 60, calendar: null, program: [join(factory, 'bin/factory-relay'), 'run'], cwd: factory, env: { PATH: path, ...kept }, log: join(env.HOME, 'Library/Logs/factory/relay.log'), user: null };
}

/** One pass in the job's environment, before the Human loads the job: it makes the log's folder and says whether ssh to the Mac mini works
 * with no prompt and whether a pass runs. Returns the exit code. */
export function check(env = process.env) {
  const j = job(env);
  const jobEnv = { HOME: env.HOME, USER: env.USER ?? '', TMPDIR: env.TMPDIR ?? '/tmp', ...j.env };
  const say = (line) => console.log(`check: ${line}`);
  mkdirSync(dirname(j.log), { recursive: true });
  say(`node ${spawnSync('node', ['--version'], { env: jobEnv, encoding: 'utf8' }).stdout?.trim() || 'not found'}`);
  say(`state folder ${jobEnv.FACTORY_STATE ?? join(jobEnv.HOME, '.local/state/factory')}`);
  say(`log ${j.log}`);
  const probe = spawnSync('ssh', [...SSH_OPTIONS, HOST, 'true'], { env: jobEnv, encoding: 'utf8', timeout: SSH_MS });
  const sshOk = probe.status === 0;
  say(`ssh ${HOST} ${sshOk ? 'works with no prompt' : `failed: ${oneLine(probe.stderr || probe.error?.message || `exit ${probe.status}`)}`}`);
  let why = sshOk ? null : 'ssh to the Mac mini does not work with no prompt';
  if (sshOk) {
    const run = spawnSync(j.program[0], j.program.slice(1), { cwd: j.cwd, env: jobEnv, encoding: 'utf8', timeout: 2 * SSH_MS });
    for (const line of `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-10)) say(`  ${line}`);
    say(`one pass exited ${run.status}`);
    if (run.status !== 0) why = 'the pass failed';
  }
  say(why ? `not ready: ${why}` : 'ready; the Human loads the job');
  return why ? 1 : 0;
}

async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (!['run', 'plist', 'check'].includes(command) || rest.length) throw new Error('usage: factory-relay run|plist|check');
  if (command === 'plist') return void process.stdout.write(plist(job(env)));
  if (placeOf(env) === 'factory') throw new Error('this is the factory host: its sweep delivers the news, so the relay runs on the MacBook');
  if (command === 'check') return check(env);
  return pass({ state: contextOf(env).state });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (error) {
    console.error(`factory-relay: ${error.message}`);
    process.exitCode = 2;
  }
}
