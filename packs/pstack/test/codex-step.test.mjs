// `factory codex` (#182, FAC-4): a pstack step that asks for another model family runs on Codex, on the verifier's profile, and
// waits, never on Claude, when Codex cannot run. Against a fake codex and a fake claude on PATH, in a repository with an origin.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { factory, git } from '../../../test/helpers.mjs';
import { DENY_READ } from '../../../bin/lib/seat.mjs';

/** The permission profile a codex call names (`-c default_permissions=` and its `-c permissions.<name>.filesystem=` table), as an object. */
function profileOf(args) {
  const values = args.filter((_, i) => args[i - 1] === '-c');
  const name = /^default_permissions="([^"]+)"$/.exec(values.find((v) => v.startsWith('default_permissions=')) ?? '')?.[1];
  const table = values.find((v) => name && v.startsWith(`permissions.${name}.filesystem=`));
  assert.ok(table, `no permission profile in: ${args.join(' ')}`);
  return JSON.parse(table.slice(table.indexOf('=') + 1).replaceAll('"="', '":"'));
}

// codex: as $FAKE/codex.json says (loggedIn, mode); every call appended to $FAKE/codex-calls with CODEX_HOME and the names of its
// environment. The folder is written into it, since the step strips the environment. From the live verifier's fake (before-fac-8).
const FAKE_CODEX = (fake) => String.raw`#!/usr/bin/env node
const fs = require('fs');
const fake = ${JSON.stringify(fake)};
const conf = JSON.parse(fs.readFileSync(fake + '/codex.json', 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(fake + '/codex-calls', JSON.stringify({ args: a, home: process.env.CODEX_HOME, env: Object.keys(process.env) }) + '\n');
if (a[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }
if (a[0] === 'login' && a[1] === 'status') {
  if (conf.loggedIn) { console.log('Logged in using ChatGPT'); process.exit(0); }
  console.log('Not logged in'); process.exit(1);
}
if (a[0] !== 'exec') process.exit(1);
fs.writeFileSync(fake + '/prompt', fs.readFileSync(0, 'utf8'));
if (conf.mode === 'quota') { process.stderr.write("ERROR: You've hit your usage limit. Try again later.\n"); process.exit(1); }
fs.writeFileSync(a[a.indexOf('-o') + 1], 'The answer.\n');
process.exit(0);
`;

// claude: any call is a step run on Claude, which never happens.
const FAKE_CLAUDE = (fake) => `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(fake, 'claude-calls'))}\nexit 0\n`;

const BRIEF = 'Judge the two candidates against the rubric.\n';
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world({ loggedIn = true, mode = 'ok' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-step-')));
  dirs.push(dir);
  const w = { dir, home: join(dir, 'home'), fake: join(dir, 'fake'), repo: join(dir, 'app'), state: join(dir, 'state') };
  for (const d of [w.home, w.fake, w.repo, join(dir, 'bin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(w.fake, 'codex.json'), JSON.stringify({ loggedIn, mode }));
  writeFileSync(join(dir, 'bin/codex'), FAKE_CODEX(w.fake));
  writeFileSync(join(dir, 'bin/claude'), FAKE_CLAUDE(w.fake));
  chmodSync(join(dir, 'bin/codex'), 0o755);
  chmodSync(join(dir, 'bin/claude'), 0o755);
  git(w.repo, 'init', '-q', '-b', 'main');
  git(w.repo, 'remote', 'add', 'origin', 'https://github.com/o/app.git');
  w.run = (args, { cwd = w.repo, input = BRIEF } = {}) => {
    const { NODE_TEST_CONTEXT, ...outer } = process.env;
    const env = {
      ...outer, HOME: w.home, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FACTORY_STATE: w.state, FACTORY_HOST_USER: userInfo().username,
      GH_TOKEN: 'not-for-codex', CLAUDE_CONFIG_DIR: join(dir, 'not-for-codex'),
    };
    delete env.AGENT_PROFILES;
    const r = spawnSync(join(factory, 'bin/factory'), ['codex', ...args], { cwd, input, encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const read = (name) => (existsSync(join(w.fake, name)) ? readFileSync(join(w.fake, name), 'utf8') : '');
  w.calls = () => read('codex-calls').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  w.execs = () => w.calls().filter((c) => c.args[0] === 'exec');
  w.prompt = () => read('prompt');
  w.claude = () => read('claude-calls');
  w.waits = () => (existsSync(join(w.state, 'codex-waits.jsonl')) ? readFileSync(join(w.state, 'codex-waits.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return w;
}

test('runs the brief on codex exec, read-only in the folder, on the verifier\'s profile with a scrubbed environment, and prints the answer', () => {
  const w = world();
  const r = w.run(['--role', 'arena-runner', '--effort', 'high']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out, 'The answer.\n');
  const [exec] = w.execs();
  assert.equal(exec.home, join(w.home, '.agent-profiles/verifier/codex'));
  for (const name of ['GH_TOKEN', 'CLAUDE_CONFIG_DIR', 'FACTORY_STATE']) assert.ok(!exec.env.includes(name), name);
  assert.equal(exec.args[exec.args.indexOf('-C') + 1], w.repo);
  // No sandbox mode: Codex's own permission profile reads the disk but the seats' denied folders (#182), and writes nothing.
  assert.ok(!exec.args.includes('-s') && !exec.args.includes('--sandbox'), exec.args.join(' '));
  const profile = profileOf(exec.args);
  assert.equal(profile[':root'], 'read');
  for (const d of ['.agent-profiles', '.ssh', '.config/gh', '.claude', '.codex', ...DENY_READ]) assert.equal(profile[join(w.home, d)], 'deny', d);
  // Codex's * stops at one path part, so a glob also denies what lies under what it names.
  for (const d of DENY_READ.filter((x) => x.includes('*'))) assert.equal(profile[`${join(w.home, d)}/**`], 'deny', d);
  // Every .env* file, which the kit denies a session too.
  assert.equal(profile['/**/.env*'], 'deny');
  assert.ok(!Object.values(profile).includes('write'));
  const args = exec.args.join(' ');
  for (const part of ['-c approval_policy="never"', '-c model_reasoning_effort="high"', '--ignore-rules', '--ephemeral']) assert.ok(args.includes(part), part);
  assert.equal(w.prompt(), BRIEF);
  assert.deepEqual(w.waits(), []);
  assert.equal(w.claude(), '');
});

test('waits when the verifier\'s profile is not logged in: exit 3, says so, logs the cause, and runs nothing on Codex or Claude', () => {
  const w = world({ loggedIn: false });
  const r = w.run(['--role', 'cross-judge']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /waits for Codex: .*not logged in/);
  const [wait, ...more] = w.waits();
  assert.deepEqual(more, []);
  assert.deepEqual({ ...wait, at: undefined }, { at: undefined, cause: 'not-logged-in', role: 'cross-judge', repo: 'o/app', cwd: w.repo });
  assert.ok(!Number.isNaN(Date.parse(wait.at)));
  assert.deepEqual(w.execs(), []);
  assert.equal(w.claude(), '');
});

test('waits when Codex is out of quota: exit 3 and the cause no-quota, never Claude', () => {
  const w = world({ mode: 'quota' });
  const r = w.run(['--role', 'interrogate-reviewer']);
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /waits for Codex/);
  assert.deepEqual(w.waits().map((x) => x.cause), ['no-quota']);
  assert.equal(w.claude(), '');
});

test('a review role\'s prompt carries the Human\'s score-and-file sentence from the kit\'s Gate block; a runner\'s does not', () => {
  const sentence = /"(Rate each bug[^"]+)"/.exec(readFileSync(join(factory, 'kit/.gate/gate-section.md'), 'utf8'))[1];
  for (const role of ['interrogate-reviewer', 'cross-judge', 'trail-reviewer', 'verifier']) {
    const w = world();
    assert.equal(w.run(['--role', role]).code, 0, role);
    assert.ok(w.prompt().startsWith(BRIEF), role);
    assert.ok(w.prompt().includes(sentence), role);
  }
  const w = world();
  assert.equal(w.run(['--role', 'architect-runner']).code, 0);
  assert.ok(!w.prompt().includes(sentence));
});

test('refuses any option outside its list, a missing or unknown role and an empty brief, and calls no codex, where the right call runs', () => {
  for (const [args, input] of [
    [['--role', 'cross-judge', '-c', 'sandbox_mode="danger-full-access"'], BRIEF],
    [['--role', 'cross-judge', '--model', 'gpt-5'], BRIEF],
    [['--role', 'cross-judge', '--dangerously-bypass-approvals-and-sandbox'], BRIEF],
    [['--role', 'cross-judge', '--effort', 'max'], BRIEF],
    [['--role', 'reviewer'], BRIEF],
    [['--effort', 'high'], BRIEF],
    [['--role', 'cross-judge', '--role', 'verifier'], BRIEF],
    [['--role', 'cross-judge'], ''],
  ]) {
    const w = world();
    const r = w.run(args, { input });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
    assert.deepEqual(w.calls(), [], args.join(' '));
    assert.deepEqual(w.waits(), [], args.join(' '));
    assert.equal(w.run(['--role', 'cross-judge']).code, 0, `the right call after ${args.join(' ')}`);
    assert.equal(w.execs().length, 1);
  }
});

test('--write gives Codex workspace-write in a folder of the repository, and refuses one outside it', () => {
  const w = world();
  const inside = join(w.repo, '.claude/worktrees/candidate-2');
  mkdirSync(inside, { recursive: true });
  assert.equal(w.run(['--role', 'arena-runner', '--write', inside]).code, 0);
  const [exec] = w.execs();
  assert.equal(exec.args[exec.args.indexOf('-C') + 1], inside);
  assert.ok(!exec.args.includes('-s'), exec.args.join(' '));
  assert.equal(profileOf(exec.args)[inside], 'write');
  assert.equal(profileOf(exec.args)[join(w.home, '.agent-profiles')], 'deny');
  // As Codex's own workspace-write does, the folder's .git, .agents, .codex and .aws stay read-only, so no hook or config is planted
  // that runs later outside the sandbox; at the repository's top folder too, and whether or not they exist yet.
  assert.equal(w.run(['--role', 'arena-runner', '--write', w.repo]).code, 0);
  for (const [folder, args] of [[inside, w.execs()[0].args], [w.repo, w.execs()[1].args]])
    for (const name of ['.git', '.agents', '.codex', '.aws']) assert.equal(profileOf(args)[join(folder, name)], 'read', `${folder}/${name}`);
  const outside = join(w.dir, 'elsewhere');
  mkdirSync(outside);
  const r = w.run(['--role', 'arena-runner', '--write', outside]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(w.execs().length, 2, 'no third exec');
});
