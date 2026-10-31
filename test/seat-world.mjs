// The fixture of the bin/seat tests (#91): a temporary world with a fake `claude` on PATH (never a live one), a fake token in a
// temporary AGENT_PROFILES, and FACTORY_RUNS and FACTORY_STATE of their own.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { factory } from './helpers.mjs';

export const TOKEN = 'fake-token-0123456789-do-not-leak';
export const SEAT_JS = join(factory, 'bin/lib/seat.mjs');
/** The pstack pack's settings, which pin the plugin and enable it. */
export const PSTACK_SETTINGS = JSON.parse(readFileSync(join(factory, 'packs/pstack/settings.json'), 'utf8'));

// FAKE_MODE: ok (one result), two (two results, the report only in the first), hang (waits for FAKE_RELEASE, then its result),
// holdafter (one result, then waits for FAKE_RELEASE), split (a result line cut inside a multi-byte character), noresult (exit 3).
// It writes what it saw to FAKE_OUT, and what its parent's environment holds (the supervisor's) as booleans only.
const FAKE = `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
process.stdout.on('error', () => {});
if (process.argv[2] === 'plugin') {
  // \`claude plugin ...\` (#185): logs the call next to this file; plugin-mode there makes it fail (fail) or ask for a login (login).
  const dir = require('path').dirname(process.argv[1]);
  // The install runs in the work folder, a sibling of state/ and runs/ in world() (the plugin call's environment holds neither).
  // lock: whether checkout.lock is held now; claimed: whether a start's claim file is in the run folder (#257).
  const root = require('path').dirname(process.cwd());
  fs.appendFileSync(dir + '/plugin-log.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,
    lock: fs.existsSync(root + '/state/checkout.lock'), claimed: fs.readdirSync(root + '/runs/issue-1').some((n) => n.endsWith('.claim.pid')) }) + '\\n');
  const mode = fs.existsSync(dir + '/plugin-mode') ? fs.readFileSync(dir + '/plugin-mode', 'utf8').trim() : 'ok';
  if (mode === 'fail') { console.error('boom'); process.exit(1); }
  if (mode === 'login') console.log('Not logged in. Please run /login');
  process.exit(0);
}
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const e = process.env;
  let parent = '';
  try {
    parent = fs.existsSync('/proc/' + process.ppid + '/environ') ? fs.readFileSync('/proc/' + process.ppid + '/environ', 'latin1') : spawnSync('/bin/ps', ['eww', '-p', String(process.ppid)], { encoding: 'latin1' }).stdout;
  } catch {}
  fs.writeFileSync(e.FAKE_OUT, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), stdin: Buffer.concat(chunks).toString(),
    parentHasToken: parent.includes('CLAUDE_CODE_OAUTH_TOKEN'), parentSeen: parent.includes('PATH='),
    env: { gh: e.GH_CONFIG_DIR, config: e.CLAUDE_CONFIG_DIR, token: e.CLAUDE_CODE_OAUTH_TOKEN ?? null, spec: e.FACTORY_SEAT_SUPERVISE ?? null,
      GH_TOKEN: 'GH_TOKEN' in e, GITHUB_TOKEN: 'GITHUB_TOKEN' in e, ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' in e, ANTHROPIC_AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN' in e,
      pluginCache: e.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? null, scrub: e.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null, clones: e.FACTORY_RESEARCH_CLONES ?? null } }));
  const line = (o) => console.log(JSON.stringify(o));
  const sid = e.FAKE_SID ?? 'sess-1';
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5' });
  line({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.12 } } } });
  if (e.FAKE_MODE === 'hang') {
    const timer = setInterval(() => { if (fs.existsSync(e.FAKE_RELEASE)) { clearInterval(timer); line({ type: 'result', subtype: 'success', session_id: sid, num_turns: Number(e.FAKE_TURNS ?? 99), duration_ms: 1, total_cost_usd: Number(e.FAKE_COST ?? 9.99), modelUsage: { 'claude-sonnet-5-5': {} }, structured_output: { conclusion: sid, evidence: [], couldNotRead: [], needsHuman: [] } }); process.exit(0); } }, 20);
    return;
  }
  if (e.FAKE_MODE === 'noresult') process.exit(3);
  if (e.FAKE_MODE === 'split') {
    // One result line in two writes, cut inside the two bytes of a.
    const text = JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, num_turns: 1, duration_ms: 1, total_cost_usd: 1, structured_output: { conclusion: 'L\\u00e0m (Recommended) \\u2014 ng\\u01b0\\u1ee1ng 70%', evidence: [], couldNotRead: [], needsHuman: [] } }) + '\\n';
    const buf = Buffer.from(text);
    const cut = buf.indexOf(Buffer.from('\\u00e0')) + 1;
    process.stdout.write(buf.subarray(0, cut));
    setTimeout(() => { process.stdout.write(buf.subarray(cut)); process.exit(0); }, 100);
    return;
  }
  const report = { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsHuman: [] };
  line({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 7, duration_ms: 1234, total_cost_usd: Number(e.FAKE_COST ?? 1.25), modelUsage: { 'claude-sonnet-5-5': {} }, structured_output: report });
  if (e.FAKE_MODE === 'two') {
    line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5' });
    line({ type: 'result', subtype: 'error_max_turns', is_error: false, session_id: sid, num_turns: 2, duration_ms: 500, total_cost_usd: 2.5, modelUsage: { 'claude-sonnet-5-5': {} } });
  }
  if (e.FAKE_MODE === 'holdafter') {
    // The result is out; the process lives until FAKE_RELEASE, so a test can act between the result and the end.
    const timer = setInterval(() => { if (fs.existsSync(e.FAKE_RELEASE)) { clearInterval(timer); process.exit(0); } }, 20);
  }
});
`;

export async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Every file under a folder, as [path, text]. */
export function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [[join(dir, e.name), readFileSync(join(dir, e.name), 'latin1')]]));
}

/** Writes pid and seat files for n live sessions of a seat (this process stands for each). */
export function fill(w, seat, n, folder = w.run) {
  for (let i = 0; i < n; i += 1) {
    writeFileSync(join(folder, `run-fill${seat}-${i}.pid`), `${process.pid}\n`);
    writeFileSync(join(folder, `run-fill${seat}-${i}.seat`), `${seat}\n`);
  }
}

/** A log of a seat's, in the run folder, whose last rate_limit_event Claude Code rejected for inSeconds. */
export function rejected(w, seat, tag, inSeconds = 3600) {
  const resetsAt = Math.floor(Date.now() / 1000) + inSeconds;
  writeFileSync(join(w.run, `run-${tag}.jsonl`), `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.3, resetsAt: resetsAt + 9999 } } } })}\n`);
  writeFileSync(join(w.run, `run-${tag}.seat`), `${seat}\n`);
}

export async function world(body, { tokenFile = `${TOKEN}\n` } = {}) {
  // The real path: tmpdir() is under /var, a link to /private/var on macOS, and bin/seat refuses a folder that is not its own real path (#192).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seat-world-')));
  const w = { root, profiles: join(root, 'profiles'), runs: join(root, 'runs'), state: join(root, 'state'), home: join(root, 'home'), bin: join(root, 'bin'), fake: join(root, 'fake') };
  w.run = join(w.runs, 'issue-1');
  w.work = join(root, 'work');
  for (const d of [w.profiles, w.run, w.state, w.home, w.bin, w.fake, w.work, join(w.profiles, 'seats/1'), join(w.profiles, 'tokens')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(w.bin, 'claude'), FAKE);
  chmodSync(join(w.bin, 'claude'), 0o755);
  writeFileSync(join(w.run, 'BRIEF.md'), 'the brief\n');
  // Both seats name one account by default (#178), whose token file is the fixture's; the seat's old oauth-token is never read.
  w.account = 'acct-one';
  writeFileSync(join(w.state, 'accounts'), 'factory/seat-1=acct-one\nfactory/seat-2=acct-one\n');
  w.tokenOf = (account) => join(w.profiles, 'tokens', account);
  w.tokenFile = w.tokenOf('acct-one');
  writeFileSync(w.tokenFile, tokenFile, { mode: 0o600 });
  w.accounts = (text) => writeFileSync(join(w.state, 'accounts'), text);
  w.out = (n = 'a') => join(w.fake, `${n}.json`);
  w.env = (extra = {}) => ({
    PATH: `${w.bin}:${dirname(process.execPath)}`, HOME: w.home, AGENT_PROFILES: w.profiles, FACTORY_RUNS: w.runs, FACTORY_STATE: w.state,
    FAKE_OUT: w.out(), ...extra,
  });
  w.seat = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [SEAT_JS, ...args], { encoding: 'utf8', env: w.env(extra), cwd: w.root, timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  w.args = (role = 'worker', extra = []) => [role, join(w.run, 'BRIEF.md'), '--run', w.run, '--work', w.work, ...extra];
  w.start = (role = 'worker', extra = [], env = {}) => w.seat(w.args(role, extra), env);
  w.records = () => (existsSync(join(w.state, 'sessions.jsonl')) ? readFileSync(join(w.state, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.saw = (n = 'a') => JSON.parse(readFileSync(w.out(n), 'utf8'));
  w.pluginCalls = () => (existsSync(join(w.bin, 'plugin-log.jsonl')) ? readFileSync(join(w.bin, 'plugin-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.pluginMode = (mode) => writeFileSync(join(w.bin, 'plugin-mode'), mode);
  w.settings = (settings) => {
    mkdirSync(join(w.work, '.claude'), { recursive: true });
    writeFileSync(join(w.work, '.claude/settings.json'), JSON.stringify(settings));
  };
  w.pidOf =(tag) => Number(readFileSync(join(w.run, `run-${tag}.pid`), 'utf8'));
  try {
    return await body(w);
  } finally {
    // No test leaves a process behind: the supervisors and the sessions are killed by the pids they recorded.
    for (const n of existsSync(w.run) ? readdirSync(w.run) : []) {
      if (!/^run-.*\.(pid|child)$/.test(n) || n.startsWith('run-fill')) continue;
      const pid = Number(readFileSync(join(w.run, n), 'utf8'));
      for (const target of [pid, -pid]) {
        try {
          if (pid > 1) process.kill(target, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
