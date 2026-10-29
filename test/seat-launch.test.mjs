// bin/seat (#91), end to end with a fake `claude` on PATH, never a live one: what it starts, which files it writes, how
// seat 1's token reaches the session (the environment only), and the record it appends when the session ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { factory } from './helpers.mjs';

const TOKEN = 'fake-token-0123456789-do-not-leak';
const SEAT_JS = join(factory, 'bin/lib/seat.mjs');

const FAKE = `#!${process.execPath}
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const e = process.env;
  fs.writeFileSync(e.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: Buffer.concat(chunks).toString(),
    env: { gh: e.GH_CONFIG_DIR, config: e.CLAUDE_CONFIG_DIR, token: e.CLAUDE_CODE_OAUTH_TOKEN ?? null, spec: e.FACTORY_SEAT_SUPERVISE ?? null } }));
  const line = (o) => console.log(JSON.stringify(o));
  const sid = e.FAKE_SID ?? 'sess-1';
  line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5' });
  line({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.12 } } } });
  if (e.FAKE_MODE === 'hang') {
    const timer = setInterval(() => { if (fs.existsSync(e.FAKE_RELEASE)) { clearInterval(timer); process.exit(0); } }, 20);
    return;
  }
  if (e.FAKE_MODE === 'noresult') process.exit(3);
  line({ type: 'result', subtype: e.FAKE_SUBTYPE ?? 'success', is_error: false, session_id: sid, num_turns: 7, duration_ms: 1234,
    total_cost_usd: Number(e.FAKE_COST ?? 1.25), modelUsage: { 'claude-sonnet-5-5': {} }, structured_output: { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsHuman: [] } });
});
`;

function world(body) {
  const root = mkdtempSync(join(tmpdir(), 'seat-launch-'));
  const w = { root, profiles: join(root, 'profiles'), runs: join(root, 'runs'), state: join(root, 'state'), home: join(root, 'home'), bin: join(root, 'bin'), fake: join(root, 'fake') };
  w.run = join(w.runs, 'issue-1');
  w.work = join(root, 'work');
  for (const d of [w.profiles, w.run, w.state, w.home, w.bin, w.fake, w.work]) mkdirSync(d, { recursive: true });
  writeFileSync(join(w.bin, 'claude'), FAKE);
  chmodSync(join(w.bin, 'claude'), 0o755);
  writeFileSync(join(w.run, 'BRIEF.md'), 'the brief\n');
  mkdirSync(join(w.profiles, 'seats/1'), { recursive: true });
  writeFileSync(join(w.profiles, 'seats/1/oauth-token'), `${TOKEN}\n`);
  w.out = (n = 'a') => join(w.fake, `${n}.json`);
  w.env = (extra = {}) => ({
    PATH: `${w.bin}:${dirname(process.execPath)}`, HOME: w.home, AGENT_PROFILES: w.profiles, FACTORY_RUNS: w.runs, FACTORY_STATE: w.state,
    FAKE_OUT: w.out(), CLAUDE_CODE_OAUTH_TOKEN: 'inherited-token-must-go', ...extra,
  });
  w.seat = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [SEAT_JS, ...args], { encoding: 'utf8', env: w.env(extra), cwd: w.root, timeout: 20000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  w.start = (role = 'worker', extra = [], env = {}) => w.seat([role, join(w.run, 'BRIEF.md'), '--run', w.run, '--work', w.work, ...extra], env);
  w.records = () => (existsSync(join(w.state, 'sessions.jsonl')) ? readFileSync(join(w.state, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  w.saw = (n = 'a') => JSON.parse(readFileSync(w.out(n), 'utf8'));
  return Promise.resolve(body(w)).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function until(test, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Every file under a folder, as path and text. */
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [[join(dir, e.name), readFileSync(join(dir, e.name), 'utf8')]]));
}

const full = (w, n) => { for (let i = 0; i < n; i += 1) { writeFileSync(join(w.run, `run-x${i}.pid`), `${process.pid}\n`); writeFileSync(join(w.run, `run-x${i}.seat`), '2\n'); } };

test('it starts the session in the background and prints the pid, the seat and the tag', () => world(async (w) => {
  const r = w.start('worker', [], { FAKE_MODE: 'hang', FAKE_RELEASE: join(w.fake, 'release') });
  assert.equal(r.code, 0, r.out + r.err);
  const pid = Number(readFileSync(join(w.run, 'run-worker.pid'), 'utf8'));
  assert.match(r.out, new RegExp(`^bin/seat: worker started ${pid} on seat 2\\n$`));
  assert.doesNotThrow(() => process.kill(pid, 0), 'the session is still running when bin/seat returns');
  assert.equal(readFileSync(join(w.run, 'run-worker.seat'), 'utf8').trim(), '2');
  for (const ext of ['jsonl', 'err', 'pid', 'seat']) assert.ok(existsSync(join(w.run, `run-worker.${ext}`)), ext);
  writeFileSync(join(w.fake, 'release'), '');
  await until(() => w.records().length === 1, 'the record');
}));

test('the session gets its preset, the brief on stdin, the work folder as cwd, an empty gh config and seat 2\'s profile, and no token', () => world(async (w) => {
  const { buildArgs } = await import('../bin/lib/seat.mjs');
  const r = w.start('worker', ['--skill', 'deletion-proof', '--allow', `Bash(${w.run}/other)`]);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => existsSync(w.out()) && w.records().length === 1, 'the session');
  const saw = w.saw();
  assert.deepEqual(saw.argv, buildArgs({ role: 'worker', run: w.run, home: w.home, skills: ['deletion-proof'], allow: [`Bash(${w.run}/other)`], seat: 2 }));
  assert.equal(saw.stdin, 'the brief\n');
  assert.equal(saw.cwd, readlinkReal(w.work));
  assert.equal(saw.env.gh, join(w.run, '.gh-empty'));
  assert.ok(existsSync(join(w.run, '.gh-empty')));
  assert.equal(saw.env.config, join(w.profiles, 'seats/2/claude'));
  assert.equal(saw.env.token, null, 'seat 2 has no token, even when the caller\'s environment has one');
  assert.equal(saw.env.spec, null, 'the supervisor\'s own settings do not reach the session');
}));

function readlinkReal(p) {
  return spawnSync(process.execPath, ['-e', 'console.log(require("fs").realpathSync(process.argv[1]))', p], { encoding: 'utf8' }).stdout.trim();
}

test('seat 1: the token is in the session\'s environment and in no argv, log, record, pid file or output', () => world(async (w) => {
  full(w, 4);
  const r = w.start('worker', ['--tag', 'one']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /on seat 1/);
  await until(() => w.records().length === 1, 'the record');
  const saw = w.saw();
  assert.equal(saw.env.token, TOKEN);
  assert.equal(saw.env.config, join(w.profiles, 'seats/1/claude'));
  assert.ok(!saw.argv.some((a) => a.includes(TOKEN)));
  const tokenFile = join(w.profiles, 'seats/1/oauth-token');
  const i = saw.argv.indexOf('--disallowedTools');
  const denied = saw.argv.slice(i + 1, saw.argv.indexOf('--output-format'));
  assert.deepEqual(denied.slice(-1), [`Read(/${tokenFile})`]);
  for (const [file, text] of [...filesUnder(w.run), ...filesUnder(w.state)]) assert.ok(!text.includes(TOKEN), `${file} holds the token`);
  assert.ok(!(r.out + r.err).includes(TOKEN));
}));

test('seat 1 with a missing or empty token file is refused with exit 2, naming the path and not the content', () => world(async (w) => {
  const tokenFile = join(w.profiles, 'seats/1/oauth-token');
  for (const content of [null, '', '\n\n']) {
    if (content === null) rmSync(tokenFile);
    else writeFileSync(tokenFile, content);
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'x']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.ok((r.out + r.err).includes(tokenFile));
    assert.deepEqual(readdirSync(w.run).filter((n) => n !== 'BRIEF.md'), [], 'nothing was started');
  }
  assert.equal(w.records().length, 0);
}));

test('no seat free: exit 2, and a reason for each seat', () => world((w) => {
  full(w, 4);
  for (let i = 0; i < 4; i += 1) { writeFileSync(join(w.run, `run-y${i}.pid`), `${process.pid}\n`); writeFileSync(join(w.run, `run-y${i}.seat`), '1\n'); }
  const r = w.start('worker');
  assert.equal(r.code, 2);
  assert.match(r.out + r.err, /seat 2: 4 live sessions, at most 4\n.*seat 1: 4 live sessions, at most 4/s);
  assert.match(r.out + r.err, /no seat free/);
}));

test('a resume needs --seat, passes the session id and stays on that seat; its tag is the brief\'s name', () => world(async (w) => {
  const brief = join(w.run, 'BRIEF-fix.md');
  writeFileSync(brief, 'fix it\n');
  const bad = w.seat(['worker', brief, '--run', w.run, '--work', w.work, '--resume', 'sid-9']);
  assert.equal(bad.code, 2);
  assert.match(bad.out + bad.err, /a resume stays on its seat; give --seat/);
  const r = w.seat(['worker', brief, '--run', w.run, '--work', w.work, '--resume', 'sid-9', '--seat', '1']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^bin\/seat: BRIEF-fix started \d+ on seat 1\n$/);
  await until(() => w.records().length === 1, 'the record');
  const saw = w.saw();
  assert.deepEqual(saw.argv.slice(0, 3), ['-p', '--resume', 'sid-9']);
  assert.equal(saw.env.token, TOKEN);
  assert.equal(readFileSync(join(w.run, 'run-BRIEF-fix.seat'), 'utf8').trim(), '1');
  assert.equal(w.records()[0].tag, 'BRIEF-fix');
}));

test('a tag that is already running is refused', () => world((w) => {
  writeFileSync(join(w.run, 'run-worker.pid'), `${process.pid}\n`);
  const r = w.start('worker');
  assert.equal(r.code, 2);
  assert.match(r.out + r.err, /run-worker is already running/);
}));

test('a tag that ends in .claim is refused, as --tag or as the name of a resumed brief', () => world((w) => {
  // run-x.claim.pid is the claim of tag x (#117): a session of tag x.claim would be removed from the count by a start of x.
  const r = w.start('worker', ['--tag', 'x.claim']);
  assert.equal(r.code, 2);
  assert.match(r.err, /x\.claim/);
  const brief = join(w.run, 'x.claim.md');
  writeFileSync(brief, 'brief\n');
  const s = w.seat(['worker', brief, '--run', w.run, '--work', w.work, '--resume', 'sid-9', '--seat', '2']);
  assert.equal(s.code, 2);
  assert.match(s.err, /x\.claim/);
  assert.equal(existsSync(join(w.run, 'run-x.claim.pid')), false);
}));

test('a tag that ends in .claim in any case is refused, since the run folder\'s disk may ignore case', () => world((w) => {
  for (const tag of ['x.CLAIM', 'x.Claim']) {
    const r = w.start('worker', ['--tag', tag]);
    assert.equal(r.code, 2, tag);
    assert.match(r.err, /ends in \.claim/i, tag);
  }
}));

test('the usage errors exit 2: an unknown role, no --run, no --work, a missing brief', () => world((w) => {
  assert.match(w.seat(['builder', join(w.run, 'BRIEF.md'), '--run', w.run, '--work', w.work]).err, /unknown role builder/);
  assert.equal(w.seat(['worker', join(w.run, 'BRIEF.md'), '--work', w.work]).code, 2);
  assert.equal(w.seat(['worker', join(w.run, 'BRIEF.md'), '--run', w.run]).code, 2);
  const r = w.seat(['worker', join(w.run, 'NOPE.md'), '--run', w.run, '--work', w.work]);
  assert.equal(r.code, 2);
  assert.match(r.err, /NOPE\.md/);
  assert.equal(w.seat(['worker', join(w.run, 'BRIEF.md'), '--run', w.run, '--work', w.work, '--frobnicate']).code, 2);
}));

test('the record: one line when the session ends, with the result event\'s cost, turns, duration and model, and the structured output', () => world(async (w) => {
  const before = Date.now();
  const r = w.start('reviewer', ['--tag', 'rev']);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.equal(rec.session, 'sess-1');
  assert.equal(rec.role, 'reviewer');
  assert.equal(rec.seat, 2);
  assert.equal(rec.tag, 'rev');
  assert.equal(rec.run, w.run);
  assert.equal(rec.model, 'claude-sonnet-5-5');
  assert.equal(rec.turns, 7);
  assert.equal(rec.duration_ms, 1234);
  assert.equal(rec.total_cost_usd, 1.25);
  assert.deepEqual(rec.structured, { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsHuman: [] });
  assert.equal(rec.ended, 'success');
  assert.equal(rec.exitCode, 0);
  assert.ok(Date.parse(rec.start) >= before - 1000 && Date.parse(rec.end) >= Date.parse(rec.start));
  assert.equal(typeof rec.minutes, 'number');
}));

test('a session that ends with no result event is recorded too: no structured output, and how it ended', () => world(async (w) => {
  const r = w.start('worker', ['--tag', 'crash'], { FAKE_MODE: 'noresult' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.equal(rec.session, 'sess-1', 'the init event gives the session id');
  assert.equal(rec.structured, null);
  assert.equal(rec.total_cost_usd, null);
  assert.equal(rec.turns, null);
  assert.equal(rec.ended, 'no-result');
  assert.equal(rec.exitCode, 3);
  assert.equal(rec.model, 'claude-sonnet-5-5', 'the init event\'s model, since no result event names one');
}));

test('killing the session\'s pid stops claude and still records it', () => world(async (w) => {
  const r = w.start('worker', ['--tag', 'kill'], { FAKE_MODE: 'hang', FAKE_RELEASE: join(w.fake, 'never') });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => existsSync(w.out()) && readFileSync(join(w.run, 'run-kill.jsonl'), 'utf8').includes('init'), 'the session');
  process.kill(Number(readFileSync(join(w.run, 'run-kill.pid'), 'utf8')), 'SIGTERM');
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.equal(rec.ended, 'no-result');
  assert.equal(rec.signal, 'SIGTERM');
}));

test('caffeinate, when it is on PATH, wraps claude as the launchers did', () => world(async (w) => {
  writeFileSync(join(w.bin, 'caffeinate'), `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.FAKE_OUT + '.caf', process.argv.slice(2, 4).join(' '));\nrequire('child_process').spawnSync(process.argv[3], process.argv.slice(4), { stdio: 'inherit' });\n`);
  chmodSync(join(w.bin, 'caffeinate'), 0o755);
  const r = w.start('worker');
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(readFileSync(`${w.out()}.caf`, 'utf8'), '-i claude');
  assert.equal(w.saw().argv[0], '-p');
}));

test('bin/seat is the command: the same start through the script', () => world(async (w) => {
  const r = spawnSync(join(factory, 'bin/seat'), ['worker', join(w.run, 'BRIEF.md'), '--run', w.run, '--work', w.work], { encoding: 'utf8', env: { ...w.env(), PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  await until(() => w.records().length === 1, 'the record');
}));
