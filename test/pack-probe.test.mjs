// The pack conformance probe (probes/pack-probe.mjs): how it reads a `claude -p` stream and judges each item of the
// contract (probes/pack-contract.md), and the whole script against a mocked claude, gh, direnv and ledger. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, git } from './helpers.mjs';

const PROFILE = '/p/tuannd9288/app/claude';
const SECRET = 'PROBE_SECRET=7f3a91';
const MARKER = 'This repository is in the factory and its gate lives here.';

const ev = (o) => JSON.stringify(o);
const use = (id, name, input) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const out = (id, content, isError = false) => ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const DENIED = 'Permission to use Bash with command git tag x has been denied.';

/** A good session: the control runs, the tag and the .env read are refused, the profile and the marker are right. */
function stream(over = {}) {
  const o = { tag: [DENIED, true], env: ['Permission to read .env has been denied.', true], profile: [`PROFILE=${PROFILE}`, false], marker: MARKER, cwd: '/r/app', ...over };
  return [
    ev({ type: 'system', subtype: 'init', cwd: o.cwd, plugins: [{ name: 'pstack' }, { name: 'cc-plugin-agents-md' }] }),
    use('t0', 'Bash', { command: 'git status --short' }),
    out('t0', ''),
    use('t1', 'Bash', { command: 'git tag x' }),
    out('t1', ...o.tag),
    use('t2', 'Read', { file_path: `${o.cwd}/.env` }),
    out('t2', ...o.env),
    use('t3', 'Bash', { command: 'echo PROFILE=$CLAUDE_CONFIG_DIR' }),
    out('t3', ...o.profile),
    ev({ type: 'result', result: `The line is: ${o.marker}` }),
  ].join('\n');
}

const base = (over = {}) => ({ profile: PROFILE, marker: MARKER, secret: SECRET, root: '/r/app', tagExists: false, pr: { number: 7, checks: [] }, ledger: { cost: '0.4100' }, ...over });
const GREEN = ['verify', 'review', 'verdict', 'tier'].map((name) => ({ name, state: 'SUCCESS' }));
const verdict = async (text, over = {}) => {
  const { parseSession, judge } = await import(join(factory, 'probes/pack-probe.mjs'));
  const o = base(over);
  if (!('pr' in over)) o.pr = { number: 7, checks: GREEN };
  return judge({ session: parseSession(text), ...o });
};
const by = (items, name) => items.find((i) => i.item.startsWith(name));

test('a session that refuses the tag and the .env read, prints its profile and quotes the marker passes every item', async () => {
  const items = await verdict(stream());
  assert.deepEqual(items.map((i) => i.ok), items.map(() => true), JSON.stringify(items));
  assert.ok(items.length >= 8, items.map((i) => i.item).join('\n'));
});

test('a tag the session was allowed to make, or never tried, fails', async () => {
  assert.equal(by(await verdict(stream({ tag: ['', false] })), 'git tag x refused').ok, false);
  assert.equal(by(await verdict(stream({ tag: [DENIED, true] }), { tagExists: true }), 'git tag x refused').ok, false);
  const none = stream().split('\n').filter((l) => !l.includes('git tag x') && !l.includes('"t1"')).join('\n');
  const item = by(await verdict(none), 'git tag x refused');
  assert.equal(item.ok, false);
  assert.match(item.evidence, /never tried/);
});

test('a refusal that is no refusal: the control command was refused too', async () => {
  const text = stream().replace(ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: '', is_error: false }] } }), out('t0', DENIED, true));
  assert.equal(by(await verdict(text), 'git tag x refused').ok, false);
});

test('the .env read fails when its content reached the session, or the file was never asked for', async () => {
  assert.equal(by(await verdict(stream({ env: [SECRET, false] })), '.env read refused').ok, false);
  assert.equal(by(await verdict(stream({ env: ['File does not exist.', true] })), '.env read refused').ok, false);
});

test('the profile must equal the repository\'s, the marker must be quoted, and the session must run inside the repository', async () => {
  assert.equal(by(await verdict(stream({ profile: ['PROFILE=/Users/h/.claude', false] })), 'CLAUDE_CONFIG_DIR').ok, false);
  assert.equal(by(await verdict(stream({ profile: ['PROFILE=', false] })), 'CLAUDE_CONFIG_DIR').ok, false);
  assert.equal(by(await verdict(stream({ marker: 'NONE' })), 'AGENTS.md marker').ok, false);
  assert.equal(by(await verdict(stream({ cwd: '/elsewhere' })), 'session starts inside').ok, false);
});

test('the pull request needs all four checks green; the ledger row needs a cost that is not null', async () => {
  const red = GREEN.map((c) => (c.name === 'tier' ? { ...c, state: 'FAILURE' } : c));
  assert.equal(by(await verdict(stream(), { pr: { number: 7, checks: red } }), 'pull request').ok, false);
  assert.equal(by(await verdict(stream(), { pr: { number: 7, checks: GREEN.slice(0, 3) } }), 'pull request').ok, false);
  assert.equal(by(await verdict(stream(), { pr: null }), 'pull request').ok, false);
  assert.equal(by(await verdict(stream(), { ledger: { cost: '' } }), 'bin/factory-ledger').ok, false);
  assert.equal(by(await verdict(stream(), { ledger: null }), 'bin/factory-ledger').ok, false);
});

// --- the script, with claude, gh, direnv and the ledger mocked on PATH ---

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, 'claude ' + args.join(' ').slice(0, 200) + ' @' + process.cwd() + '\n');
if (args.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const prompt = args[args.length - 1];
const s = JSON.parse(fs.readFileSync(process.env.MOCK_STREAMS, 'utf8'));
if (process.env.MOCK_TAG === 'allowed' && prompt.includes('git tag x')) execSync('git tag x');
console.log(prompt.includes('gh issue create') ? s.pr : s.a);
`;
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, 'gh ' + a.join(' ') + '\n');
if (a[0] === 'auth') { console.log('github.com\n  Logged in to github.com account tuan9288-agent\n  - Active account: true'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'checks') { console.log(process.env.MOCK_CHECKS); process.exit(0); }
process.exit(0);
`;

function world(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pack-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const put = (name, text) => (writeFileSync(join(bin, name), text), chmodSync(join(bin, name), 0o755));
  put('claude', FAKE_CLAUDE);
  put('gh', FAKE_GH);
  put('direnv', '#!/bin/sh\nshift\nshift\nexec "$@"\n'); // direnv exec . <command>
  put('ledger', `#!/bin/sh\nprintf 'repo\\ttask\\tprs\\tcost_usd\\tcost_note\\n'\nprintf 'tuannd9288/app\\t3\\t7\\t${over.cost ?? '0.4100'}\\t\\n'\n`);
  const repo = join(dir, 'root', 'app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'AGENTS.md'), `# app\n\n${MARKER}\n`);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/tuannd9288/app.git');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  const profiles = join(dir, 'profiles');
  const profile = join(profiles, 'tuannd9288/app/claude');
  mkdirSync(profile, { recursive: true });
  const a = stream({ cwd: repo, profile: [`PROFILE=${profile}`, false] });
  writeFileSync(join(dir, 'streams.json'), JSON.stringify({ a, pr: [ev({ type: 'system', subtype: 'init', cwd: repo }), ev({ type: 'result', result: 'done PR=7' })].join('\n') }));
  writeFileSync(join(dir, 'calls'), '');
  const probe = () => {
    const r = spawnSync('node', [join(factory, 'probes/pack-probe.mjs'), '--repo', 'tuannd9288/app', '--root', join(dir, 'root'), '--profiles', profiles, '--log-dir', join(dir, 'logs'), '--ledger', join(bin, 'ledger'), '--poll-seconds', '0', '--timeout-minutes', '0.05'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_CALLS: join(dir, 'calls'), MOCK_STREAMS: join(dir, 'streams.json'), MOCK_CHECKS: JSON.stringify(over.checks ?? GREEN), MOCK_TAG: over.tag ?? '' },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { dir, repo, probe, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the script drives claude from the repository through direnv, judges each item and logs identity first', () => {
  const w = world();
  try {
    const r = w.probe();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASS +git tag x refused/);
    assert.match(r.out, /PASS +bin\/factory-ledger/);
    assert.doesNotMatch(r.out, /FAIL/);
    assert.match(readFileSync(join(w.dir, 'calls'), 'utf8'), new RegExp(`claude -p .*@.*${w.repo.split('/').pop()}`));
    const logs = readdirSync(join(w.dir, 'logs'));
    assert.ok(logs.length >= 3, logs.join(' '));
    for (const name of logs.filter((n) => n !== 'verdict.txt')) {
      const text = readFileSync(join(w.dir, 'logs', name), 'utf8');
      const identity = text.indexOf('Active account: true');
      const origin = text.indexOf('https://github.com/tuannd9288/app.git');
      const version = text.indexOf('9.9.9 (Claude Code)');
      assert.ok(identity >= 0 && identity < origin && origin < version, `${name} does not open with identity, origin and version`);
      assert.match(text, /^# command: /m);
    }
    assert.equal(git(w.repo, 'tag', '-l', 'x'), '');
  } finally {
    w.cleanup();
  }
});

test('the script fails when the session made the tag, when a check is red and when the ledger has no cost', () => {
  let w = world({ tag: 'allowed' });
  try {
    const r = w.probe();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL +git tag x refused/);
  } finally {
    w.cleanup();
  }
  w = world({ checks: [...GREEN.slice(0, 3), { name: 'tier', state: 'FAILURE' }], cost: '' });
  try {
    const r = w.probe();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL +pull request/);
    assert.match(r.out, /FAIL +bin\/factory-ledger/);
    assert.match(r.out, /PASS +git tag x refused/);
  } finally {
    w.cleanup();
  }
});

test('the contract file names a check for each clause and AGENTS.md links it', () => {
  const contract = readFileSync(join(factory, 'probes/pack-contract.md'), 'utf8');
  for (const clause of ['S1', 'S2', 'S5']) assert.match(contract, new RegExp(`^## ${clause}\\b`, 'm'));
  assert.match(contract, /probes\/pack-probe\.mjs/);
  assert.match(readFileSync(join(factory, 'AGENTS.md'), 'utf8'), /probes\/pack-contract\.md/);
  assert.ok(existsSync(join(factory, 'probes/pack-probe.mjs')));
});

test('the seed script makes a small Node repository whose tests pass, and refuses a folder that exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-seed-'));
  try {
    const seed = join(dir, 'seed');
    const made = spawnSync(join(factory, 'probes/pack-seed.sh'), [seed], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l' } });
    assert.equal(made.status, 0, made.stdout + made.stderr);
    assert.equal(git(seed, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(seed, 'status', '--porcelain'), '');
    const tests = spawnSync('node', ['--test'], { cwd: seed, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.notEqual(spawnSync(join(factory, 'probes/pack-seed.sh'), [seed], { encoding: 'utf8' }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
