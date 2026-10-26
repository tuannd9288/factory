// The fixture of the bin/seat tests (#91): a temporary world with a fake `claude` on PATH (never a live one), a fake token in a
// temporary AGENT_PROFILES, and FACTORY_RUNS and FACTORY_STATE of their own.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { factory } from './helpers.mjs';

export const TOKEN = 'fake-token-0123456789-do-not-leak';
export const SEAT_JS = join(factory, 'bin/lib/seat.mjs');

// FAKE_MODE: ok (one result), two (two results, the report only in the first), hang (waits for FAKE_RELEASE), noresult (exit 3).
// It writes what it saw to FAKE_OUT, and what its parent's environment holds (the supervisor's) as booleans only.
const FAKE = `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
process.stdout.on('error', () => {});
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const e = process.env;
  let parent = '';
  try {
    parent = fs.existsSync('/proc/' + process.ppid + '/environ') ? fs.readFileSync('/proc/' + process.ppid + '/environ', 'latin1') : spawnSync('/bin/ps', ['eww', '-p', String(process.ppid)], { encoding: 'latin1' }).stdout;
  } catch {}
  fs.writeFileSync(e.FAKE_OUT, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), stdin: Buffer.concat(chunks).toString(),
    parentHasToken: parent.includes('CLAUDE_CODE_OAUTH_TOKEN'), parentSeen: parent.length > 0,
    env: { gh: e.GH_CONFIG_DIR, config: e.CLAUDE_CONFIG_DIR, token: e.CLAUDE_CODE_OAUTH_TOKEN ?? null, spec: e.FACTORY_SEAT_SUPERVISE ?? null,
      GH_TOKEN: 'GH_TOKEN' in e, GITHUB_TOKEN: 'GITHUB_TOKEN' in e, ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' in e } }));
  const line = (o) => console.log(JSON.stringify(o));
  const sid = e.FAKE_SID ?? 'sess-1';
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5' });
  line({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.12 } } } });
  if (e.FAKE_MODE === 'hang') {
    const timer = setInterval(() => { if (fs.existsSync(e.FAKE_RELEASE)) { clearInterval(timer); line({ type: 'result', subtype: 'success', session_id: sid, num_turns: Number(e.FAKE_TURNS ?? 99), duration_ms: 1, total_cost_usd: Number(e.FAKE_COST ?? 9.99), modelUsage: { 'claude-sonnet-5-5': {} }, structured_output: { conclusion: sid, evidence: [], couldNotRead: [], needsHuman: [] } }); process.exit(0); } }, 20);
    return;
  }
  if (e.FAKE_MODE === 'noresult') process.exit(3);
  const report = { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsHuman: [] };
  line({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 7, duration_ms: 1234, total_cost_usd: Number(e.FAKE_COST ?? 1.25), modelUsage: { 'claude-sonnet-5-5': {} }, structured_output: report });
  if (e.FAKE_MODE === 'two') {
    line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5' });
    line({ type: 'result', subtype: 'error_max_turns', is_error: false, session_id: sid, num_turns: 2, duration_ms: 500, total_cost_usd: 2.5, modelUsage: { 'claude-sonnet-5-5': {} } });
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

export async function world(body, { tokenFile = `${TOKEN}\n` } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seat-world-'));
  const w = { root, profiles: join(root, 'profiles'), runs: join(root, 'runs'), state: join(root, 'state'), home: join(root, 'home'), bin: join(root, 'bin'), fake: join(root, 'fake') };
  w.run = join(w.runs, 'issue-1');
  w.work = join(root, 'work');
  for (const d of [w.profiles, w.run, w.state, w.home, w.bin, w.fake, w.work, join(w.profiles, 'seats/1')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(w.bin, 'claude'), FAKE);
  chmodSync(join(w.bin, 'claude'), 0o755);
  writeFileSync(join(w.run, 'BRIEF.md'), 'the brief\n');
  w.tokenFile = join(w.profiles, 'seats/1/oauth-token');
  writeFileSync(w.tokenFile, tokenFile);
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
  w.pidOf = (tag) => Number(readFileSync(join(w.run, `run-${tag}.pid`), 'utf8'));
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
