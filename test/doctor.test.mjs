// bin/onboard-doctor, which reads a repository the factory has taken in and prints one line per check, against a fake
// gh (the fake of test/owner.test.mjs, with the calls the doctor adds), a factory clone made for each test, and local
// git repositories. The target is built by the real bin/onboard, so the kit it holds is the kit's own. No network.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';
import { wanted } from '../bin/lib/owner.mjs';

// A fake gh that answers the reads the doctor makes from $GH_STATE and logs each call to $GH_CALLS. A call that is not
// a read is answered with a failure, so a doctor that wrote would also fail here, besides being seen in the log.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\n');
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const missing = () => { process.stderr.write('gh: Not Found (HTTP 404)\n'); process.exit(1); };
if (args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a))) { process.stderr.write('fake gh: not a read\n'); process.exit(1); }
if (args[0] === 'variable' && args[1] === 'list') out(state.variables ?? []);
if (args[0] === 'pr' && args[1] === 'list') out(state.prs ?? []);
if (args[0] === 'pr' && args[1] === 'checks') {
  const checks = (state.checks ?? {})[args[2]];
  if (!checks) { process.stderr.write('no checks reported\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(checks));
  process.exit(checks.every((c) => c.state === 'SUCCESS') ? 0 : 1);
}
if (args[0] !== 'api') process.exit(1);
const path = args[1].replace(/^\//, '');
const repo = 'repos/' + state.repo.full_name;
if (path === 'user') out({ login: state.login });
if (path === repo) out(state.repo);
if (path.startsWith(repo + '/contents/.gate/kit-files')) state.kitLanded ? out({ path: '.gate/kit-files' }) : missing();
if (path === repo + '/collaborators/' + state.agent + '/permission') out({ permission: state.collaborator ?? 'none' });
if (path === repo + '/invitations') out(state.invitations ?? []);
if (path.startsWith(repo + '/rulesets') && !/rulesets\/\d+/.test(path)) out(state.rulesets.map(({ id, name }) => ({ id, name })));
const one = /rulesets\/(\d+)$/.exec(path);
if (one) { const r = state.rulesets.find((x) => x.id === Number(one[1])); r ? out(r) : missing(); }
const env = repo + '/environments/reviewer';
if (path === env) state.environment ? out(state.environment) : missing();
if (path === env + '/deployment-branch-policies') state.environment ? out({ branch_policies: state.environment.policies ?? [] }) : missing();
process.stderr.write('fake gh: no answer for ' + path + '\n');
process.exit(1);
`;

const FAKE_TOKEN = 'ghp_FAKEtoken0123456789';
const REVIEWER_VALUE = 'zz-reviewer-value-not-entire';
const OTHER_VALUE = 'zz-other-variable-value';
const LABELS = ['settings', 'gate-block', 'verify', 'claude-md', 'size', 'kit-evidence'];
const BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };

let dir;
let fake;
let fac;
let target;
let kitMerge;

/** A copy of the factory's code at one commit that origin/main also names, as a clone of it would be. */
function makeFactory(into, parts) {
  mkdirSync(into);
  for (const part of parts) run(factory, 'cp', ['-R', join(factory, part), join(into, part)]);
  git(into, 'init', '-q', '-b', 'main');
  commit(into, {}, 'the factory');
  git(into, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return into;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  fake = join(dir, 'fake');
  mkdirSync(fake);
  writeFileSync(join(fake, 'gh'), FAKE_GH);
  chmodSync(join(fake, 'gh'), 0o755);
  fac = makeFactory(join(dir, 'factory'), ['bin', 'kit', 'packs', 'modules']);
  // The target: an app, the kit laid on factory/kit by the real onboard, and that branch merged into main by a merge commit.
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, APP, 'start');
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
  mkdirSync(join(dir, 'root'));
  const onboard = run(dir, join(fac, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr'], {
    ...quiet,
    FACTORY_ROOT: join(dir, 'root'),
    AGENT_PROFILES: join(dir, 'profiles'),
    XDG_DATA_HOME: join(dir, 'xdg'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
  });
  assert.equal(onboard.code, 0, onboard.out);
  const clone = join(dir, 'root', 'app');
  git(clone, 'switch', '-q', 'main');
  git(clone, 'merge', '-q', '--no-ff', 'factory/kit', '-m', 'Merge pull request #5 from tuannd9288/factory/kit');
  git(clone, 'push', '-q', 'origin', 'main');
  target = join(dir, 'app.git');
  kitMerge = git(clone, 'rev-parse', 'HEAD');
  // A second kit pull request, a kit-update's, whose branch changes a kit file the kit does not let it change.
  git(clone, 'switch', '-q', '-c', 'factory/kit-bad', `${kitMerge}^2`);
  write(clone, { '.gate/bin/verify': `${readFileSync(join(clone, '.gate/bin/verify'), 'utf8')}# not the kit's\n` });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'tamper');
  git(clone, 'switch', '-q', 'main');
  git(clone, 'merge', '-q', '--no-ff', 'factory/kit-bad', '-m', 'Merge pull request #6 from tuannd9288/factory/kit-bad');
  git(clone, 'push', '-q', 'origin', 'main:refs/heads/tampered');
  git(clone, 'reset', '-q', '--hard', kitMerge);
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** A bare clone of the target with `files` committed on top of its main (an AGENTS.md that does not fit, say). */
function variant(name, files) {
  const work = join(dir, `${name}-work`);
  git(dir, 'clone', '-q', target, work);
  const head = commit(work, files, 'change');
  git(dir, 'clone', '-q', '--bare', work, join(dir, `${name}.git`));
  return { url: join(dir, `${name}.git`), head };
}

/** What the fake GitHub holds of a repository that is as the factory wants it, with `over` laid over it. */
function state(head, over = {}) {
  const want = wanted({ kitLanded: true, branch: 'main', reviewer: '' });
  return {
    login: 'tuannd9288',
    agent: 'tuan9288-agent',
    repo: { id: 1234, full_name: 'tuannd9288/app', owner: { login: 'tuannd9288' }, default_branch: 'main', permissions: { admin: true } },
    kitLanded: true,
    collaborator: 'write',
    invitations: [],
    rulesets: want.rulesets.map((r, i) => ({ ...r, id: 100 + i })),
    environment: { name: 'reviewer', deployment_branch_policy: BRANCH_POLICY, policies: [{ name: 'main', type: 'branch' }] },
    variables: [{ name: 'GATE_REVIEWER', value: REVIEWER_VALUE }, { name: 'OTHER', value: OTHER_VALUE }],
    prs: [
      { number: 5, headRefName: 'factory/kit', mergeCommit: { oid: kitMerge }, mergedAt: '2026-10-01T00:00:00Z' },
      { number: 7, headRefName: 'topic', mergeCommit: { oid: head }, mergedAt: '2026-10-02T00:00:00Z' },
    ],
    checks: { 7: [{ name: 'verify', state: 'SUCCESS' }, { name: 'tier', state: 'SUCCESS' }] },
    ...over,
  };
}

/** One doctor run: `held` is the fake GitHub's state, `url` the repository's clone, `bin` the factory it runs from. */
function doctor({ held, url = target, bin = fac, args = ['tuannd9288/app', '--id', '1234'], env = {} }) {
  const work = mkdtempSync(join(dir, 'run-'));
  const tmp = join(work, 'tmp');
  mkdirSync(tmp);
  writeFileSync(join(work, 'state.json'), JSON.stringify(held));
  writeFileSync(join(work, 'calls'), '');
  const r = spawnSync(join(bin, 'bin/onboard-doctor'), args, {
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, ...quiet, PATH: `${fake}:${process.env.PATH}`, GH_STATE: join(work, 'state.json'), GH_CALLS: join(work, 'calls'), GH_TOKEN: FAKE_TOKEN, DOCTOR_CLONE_URL: url, TMPDIR: tmp, ...env },
  });
  const out = `${r.stdout}${r.stderr}`;
  const lines = Object.fromEntries(LABELS.map((label) => [label, out.split('\n').find((l) => new RegExp(`^\\S+\\s+${label}\\s`).test(l))]));
  return { code: r.status, out, lines, left: readdirSync(tmp), calls: readFileSync(join(work, 'calls'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const mark = (line) => line?.split(/\s+/)[0];

/** The doctor's verdict on each check: ok or RED. */
const marks = (r) => Object.fromEntries(LABELS.map((label) => [label, mark(r.lines[label])]));
const green = Object.fromEntries(LABELS.map((label) => [label, 'ok']));

test('a repository as the factory wants it: every line ok, exit 0, one line a check within 120 columns', () => {
  const r = doctor({ held: state(kitMerge) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(marks(r), green, r.out);
  for (const line of Object.values(r.lines)) assert.ok(line.length <= 120, line);
  assert.deepEqual(r.left, [], 'the bare clone is removed');
});

test('settings: red names each call left, and when the kit is not on the default branch', () => {
  let r = doctor({ held: state(kitMerge, { environment: null, collaborator: 'none' }) });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(marks(r), { ...green, settings: 'RED' }, r.out);
  assert.match(r.lines.settings, /environment reviewer/);
  assert.match(r.lines.settings, /collaborator tuan9288-agent/);
  r = doctor({ held: state(kitMerge, { kitLanded: false }) });
  assert.equal(r.code, 1, r.out);
  assert.equal(mark(r.lines.settings), 'RED');
  const extra = { name: 'reviewer', deployment_branch_policy: BRANCH_POLICY, policies: [{ name: 'main', type: 'branch' }, { name: 'dev', type: 'branch' }] };
  r = doctor({ held: state(kitMerge, { environment: extra }) });
  assert.equal(r.code, 1, r.out);
  assert.equal(mark(r.lines.settings), 'RED');
  assert.match(r.lines.settings, /dev/);
});

test('gate-block: red when the block is not .gate/gate-section.md byte for byte, or is gone', () => {
  const text = readFileSync(join(dir, 'root/app/AGENTS.md'), 'utf8');
  for (const [name, agents] of [['edited', text.replace('## Gate', '## Gate!')], ['gone', '# app\n']]) {
    const v = variant(`block-${name}`, { 'AGENTS.md': agents });
    const r = doctor({ held: state(v.head), url: v.url });
    assert.equal(r.code, 1, r.out);
    assert.equal(mark(r.lines['gate-block']), 'RED', r.out);
    assert.equal(mark(r.lines.settings), 'ok');
  }
});

test('verify: red when no merged pull request has the head as its merge commit, and when its verify is not a success', () => {
  const v = variant('plain3', {});
  let r = doctor({ held: state(v.head, { prs: [] }), url: v.url });
  assert.equal(r.code, 1, r.out);
  assert.equal(mark(r.lines.verify), 'RED', r.out);
  r = doctor({ held: state(v.head, { checks: { 7: [{ name: 'verify', state: 'FAILURE' }] } }), url: v.url });
  assert.equal(r.code, 1, r.out);
  assert.equal(mark(r.lines.verify), 'RED', r.out);
  r = doctor({ held: state(v.head, { checks: { 7: [{ name: 'tier', state: 'SUCCESS' }] } }), url: v.url });
  assert.equal(mark(r.lines.verify), 'RED', r.out);
  r = doctor({ held: state(v.head), url: v.url });
  assert.equal(mark(r.lines.verify), 'ok', r.out);
});

test('claude-md: red when CLAUDE.md does not import AGENTS.md', () => {
  const v = variant('claude', { 'CLAUDE.md': 'Read AGENTS.md\n' });
  const r = doctor({ held: state(v.head), url: v.url });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(marks(r), { ...green, 'claude-md': 'RED' }, r.out);
});

test('size: red when AGENTS.md is over 150 lines', () => {
  const v = variant('size', { 'AGENTS.md': `${readFileSync(join(dir, 'root/app/AGENTS.md'), 'utf8')}${'a line\n'.repeat(200)}` });
  const r = doctor({ held: state(v.head), url: v.url });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(marks(r), { ...green, size: 'RED' }, r.out);
});

test('kit-evidence: red when the last kit pull request does not carry the kit; and a repository with none', () => {
  const tampered = git(target, 'rev-parse', 'refs/heads/tampered');
  const url = join(dir, 'tampered.git');
  git(dir, 'clone', '-q', '--bare', target, url);
  git(url, 'update-ref', 'refs/heads/main', tampered);
  const held = state(tampered);
  held.prs.push({ number: 6, headRefName: 'factory/kit-bad', mergeCommit: { oid: tampered }, mergedAt: '2026-10-03T00:00:00Z' });
  held.checks[6] = [{ name: 'verify', state: 'SUCCESS' }];
  let r = doctor({ held, url });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(marks(r), { ...green, 'kit-evidence': 'RED' }, r.out);
  r = doctor({ held: state(kitMerge, { prs: [{ number: 7, headRefName: 'topic', mergeCommit: { oid: kitMerge }, mergedAt: '2026-10-02T00:00:00Z' }] }) });
  assert.equal(mark(r.lines['kit-evidence']), 'RED', r.out);
});

test('every gh call is a read: a GET with its query in the path, or a list or a view that changes nothing', () => {
  const r = doctor({ held: state(kitMerge) });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.calls.length > 8);
  for (const args of r.calls) {
    assert.ok(!args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a)), JSON.stringify(args));
    if (args[0] === 'api') assert.deepEqual(args.filter((a) => a.startsWith('-')), [], JSON.stringify(args));
    else assert.ok(['variable list', 'pr list', 'pr checks'].includes(`${args[0]} ${args[1]}`), JSON.stringify(args));
  }
});

test('no variable value and no token reaches the output, green or red', () => {
  for (const [held, code] of [[state(kitMerge), 0], [state(kitMerge, { environment: null, kitLanded: false, prs: [] }), 1]]) {
    const r = doctor({ held });
    assert.equal(r.code, code, r.out);
    for (const secret of [FAKE_TOKEN, REVIEWER_VALUE, OTHER_VALUE]) assert.ok(!r.out.includes(secret), `${secret} printed:\n${r.out}`);
  }
});

test('it refuses to run from a commit that is not on origin/main, or from a kit with a stray file, before it calls gh', () => {
  const off = makeFactory(join(dir, 'off'), ['bin', 'kit']);
  commit(off, { 'bin/more': 'x\n' }, 'not on origin/main');
  let r = doctor({ held: state(kitMerge), bin: off });
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(r.calls, []);
  const stray = makeFactory(join(dir, 'stray'), ['bin', 'kit']);
  writeFileSync(join(stray, '.git/info/exclude'), 'kit/ignored\n');
  for (const [path, edit] of [['bin/untracked', false], ['kit/ignored', false], ['bin/onboard-doctor', true]]) {
    if (edit) appendFileSync(join(stray, path), '# edited\n');
    else writeFileSync(join(stray, path), 'x\n');
    r = doctor({ held: state(kitMerge), bin: stray });
    assert.equal(r.code, 2, `${path}: ${r.out}`);
    assert.deepEqual(r.calls, []);
    if (edit) git(stray, 'checkout', '-q', '--', path);
    else rmSync(join(stray, path));
  }
});

test('it refuses what onboard-owner refuses: the agents\' login, another id, a renamed repository, no admin right', () => {
  const held = state(kitMerge);
  const refused = (over, args = ['tuannd9288/app', '--id', '1234']) => doctor({ held: { ...held, ...over }, args });
  assert.equal(refused({ login: 'tuan9288-agent' }).code, 2);
  assert.equal(refused({}, ['tuannd9288/app', '--id', '9999']).code, 2);
  assert.equal(refused({}, ['tuannd9288/app']).code, 2);
  assert.equal(refused({ repo: { ...held.repo, full_name: 'tuannd9288/renamed' } }).code, 2);
  assert.equal(refused({ repo: { ...held.repo, permissions: { admin: false } } }).code, 2);
  assert.equal(refused({}).code, 0);
});

test('DOCTOR_CLONE_URL takes only an absolute local folder', () => {
  for (const url of ['relative/app.git', 'https://example.invalid/app.git', join(dir, 'missing.git')]) {
    const r = doctor({ held: state(kitMerge), url });
    assert.equal(r.code, 2, `${url}: ${r.out}`);
  }
});

test('settings: a line red with many calls left prints every call whole, over more lines, none cut', () => {
  const held = state(kitMerge, { rulesets: [], environment: null, collaborator: 'none' });
  const r = doctor({ held });
  assert.equal(r.code, 1, r.out);
  const whats = ['collaborator tuan9288-agent (write)', 'environment reviewer', 'environment reviewer deploys from main', ...wanted({ kitLanded: true, branch: 'main', reviewer: '' }).rulesets.map((x) => `ruleset ${x.name}`)];
  assert.ok(whats.length >= 3);
  for (const what of whats) assert.ok(r.out.includes(what), `${what} is not in:\n${r.out}`);
  const start = r.out.split('\n').findIndex((l) => /^RED\s+settings\s/.test(l));
  const block = r.out.split('\n').slice(start, start + 1 + r.out.split('\n').slice(start + 1).findIndex((l) => /^\S/.test(l)));
  assert.ok(block.length > 1, 'it goes on the lines after');
  for (const line of block) assert.ok(line.length <= 120, line);
  assert.ok(/\[[^\]]+\]$/.test(block[0]), 'the reads stay on the first line');
  assert.ok(!r.out.includes('…'));
});

test('kit-evidence: a red line names the first failing path and counts the others', () => {
  const tampered = git(target, 'rev-parse', 'refs/heads/tampered');
  const url = join(dir, 'tampered-named.git');
  git(dir, 'clone', '-q', '--bare', target, url);
  git(url, 'update-ref', 'refs/heads/main', tampered);
  const held = state(tampered);
  held.prs.push({ number: 6, headRefName: 'factory/kit-bad', mergeCommit: { oid: tampered }, mergedAt: '2026-10-03T00:00:00Z' });
  held.checks[6] = [{ name: 'verify', state: 'SUCCESS' }];
  const r = doctor({ held, url });
  assert.equal(mark(r.lines['kit-evidence']), 'RED', r.out);
  assert.ok(r.out.includes('.gate/bin/verify'), r.out);
});

test('an exit after a gh call lists the calls already made: a refusal, and a clone that fails', () => {
  let r = doctor({ held: state(kitMerge), args: ['tuannd9288/app', '--id', '9999'] });
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes('gh api user') && r.out.includes('gh api repos/tuannd9288/app\n'), r.out);
  const empty = join(dir, 'not-a-repository');
  mkdirSync(empty);
  r = doctor({ held: state(kitMerge), url: empty });
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes('gh api user') && r.out.includes('gh api repos/tuannd9288/app\n'), r.out);
  assert.deepEqual(r.left, []);
});

test('a green settings line is one line, and its tag names every read it makes', () => {
  const r = doctor({ held: state(kitMerge) });
  const lines = r.out.split('\n');
  const at = lines.findIndex((l) => /^ok\s+settings\s/.test(l));
  assert.ok(lines[at].length <= 120 && /^ok\s/.test(lines[at + 1]), r.out);
  for (const read of ['rulesets', 'environment', 'collaborator', 'invitations', 'kit-files', 'variables']) assert.ok(lines[at].includes(read), `${read}: ${lines[at]}`);
});

test('kit-evidence is called with --human, as bin/onboard and bin/kit-update call it', () => {
  const stub = makeFactory(join(dir, 'stub'), ['bin', 'kit']);
  writeFileSync(join(stub, 'bin/kit-evidence'), '#!/usr/bin/env bash\necho "$@" >>"$EVIDENCE_ARGS"\necho kit-evidence: PASS\n');
  git(stub, 'add', '-A');
  git(stub, 'commit', '-qm', 'a kit-evidence that records its arguments');
  git(stub, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  for (const [env, human] of [[{}, 'tuannd9288'], [{ FACTORY_HUMAN: 'someone-else' }, 'someone-else']]) {
    const args = join(dir, `evidence-args-${human}`);
    writeFileSync(args, '');
    const r = doctor({ held: state(kitMerge), bin: stub, env: { ...env, EVIDENCE_ARGS: args } });
    assert.equal(mark(r.lines['kit-evidence']), 'ok', r.out);
    assert.match(readFileSync(args, 'utf8'), new RegExp(` --human ${human}$`, 'm'));
  }
});
