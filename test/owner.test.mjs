// The admin step of taking a repository in, bin/onboard-owner, against a fake GitHub that keeps the repository's
// settings in a file; and the team's step, bin/onboard, refusing to open the kit pull request out of turn. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

// A fake gh that answers the REST calls bin/onboard-owner makes from $GH_STATE and logs each call to $GH_CALLS.
// `ignore` names a kind of write the fake accepts and drops, so a setting does not read back as set.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, args.join(' ') + '\n');
let method = 'GET', path = '', input;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '-X' || args[i] === '--method') method = args[++i];
  else if (args[i] === '--input') input = args[++i];
  else if (!args[i].startsWith('-') && !path) path = args[i];
}
const body = input === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
const done = (v) => { fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state)); if (v !== undefined) process.stdout.write(JSON.stringify(v)); process.exit(0); };
const missing = () => { process.stderr.write('gh: Not Found (HTTP 404)\n'); process.exit(1); };
const repo = 'repos/' + state.repo.full_name;
const agent = state.agent;
const kept = (kind) => state.ignore !== kind;
path = path.replace(/^\//, '');
// #155: the repository's Actions variables, as gh variable list --json name,value prints them.
if (args[0] === 'variable' && args[1] === 'list') done(state.variables ?? []);
if (args[0] !== 'api') process.exit(1);
if (path === 'user') done({ login: state.login });
if (path.startsWith('apps/')) state.apps?.[path.slice(5)] ? done(state.apps[path.slice(5)]) : missing();
if (path === repo) done(state.repo);
if (path.startsWith(repo + '/contents/.gate/kit-files')) state.kitLanded ? done({ path: '.gate/kit-files' }) : missing();
if (path === repo + '/collaborators/' + agent + '/permission') {
  if (!state.collaborator && state.permission404) missing();
  done({ permission: state.collaborator ?? 'none', role_name: state.collaborator ?? 'none' });
}
if (path === repo + '/collaborators/' + agent && method === 'PUT') {
  if (kept('collaborator') && !state.collaborator && !state.invitations.length) state.invitations.push({ id: 7, invitee: { login: agent }, permissions: 'write' });
  done();
}
if (path === repo + '/invitations') done(state.invitations);
if (path.startsWith(repo + '/rulesets') && !/rulesets\/\d+/.test(path)) {
  if (method === 'POST') { const r = { id: state.next++, source: state.repo.full_name, node_id: 'x', ...body }; if (kept('rulesets')) state.rulesets.push(r); done(r); }
  done(state.rulesets.map(({ id, name }) => ({ id, name })));
}
const one = /rulesets\/(\d+)$/.exec(path);
if (one) {
  const i = state.rulesets.findIndex((r) => r.id === Number(one[1]));
  if (i < 0) missing();
  if (method === 'PUT') { if (kept('rulesets')) state.rulesets[i] = { ...state.rulesets[i], ...body }; done(state.rulesets[i]); }
  if (method === 'DELETE') { state.rulesets.splice(i, 1); done(); }
  // GitHub answers with defaults the request did not set; a read-back compares only what was asked for.
  const r = state.rulesets[i];
  const read = { ...r, rules: r.rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { required_reviewers: [], ...x.parameters } } : x)) };
  // So does the tag ruleset: a bypass actor with a field of its own, a parameter on the update rule, a top-level field.
  if (r.target === 'tag') done({ ...read, current_user_can_bypass: 'never', bypass_actors: read.bypass_actors.map((b) => ({ ...b, actor_name: 'admin' })), rules: read.rules.map((x) => (x.type === 'update' ? { ...x, parameters: { update_allows_fetch_and_merge: false } } : x)) });
  done(read);
}
// #210: an Actions variable is created by a POST and changed by a PATCH of its name.
if (path === repo + '/actions/variables' && method === 'POST') {
  state.variables ??= [];
  if (kept('variables')) state.variables.push({ name: body.name, value: body.value });
  done();
}
const named = /\/actions\/variables\/(\w+)$/.exec(path);
if (named && path.startsWith(repo) && method === 'PATCH') {
  const v = (state.variables ?? []).find((x) => x.name === named[1]);
  if (!v) missing();
  if (kept('variables')) v.value = body.value;
  done();
}
const env = repo + '/environments/reviewer';
if (path === env) {
  if (method === 'PUT') { if (kept('environment')) state.environment = { name: 'reviewer', ...body }; done(state.environment ?? {}); }
  state.environment ? done(state.environment) : missing();
}
if (path === env + '/deployment-branch-policies') {
  if (!state.environment) missing();
  state.environment.policies ??= [];
  if (method === 'POST') { if (kept('environment')) state.environment.policies.push({ id: 1, ...body }); done(body); }
  done({ total_count: state.environment.policies.length, branch_policies: state.environment.policies });
}
process.stderr.write('fake gh: no answer for ' + method + ' ' + path + '\n');
process.exit(1);
`;

function world(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  // The owner script holds the Human's authority: it must never run the target's code, so it never needs git.
  writeFileSync(join(dir, 'git'), '#!/bin/sh\necho "$*" >>"$GIT_CALLS"\nexit 1\n');
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'git'), 0o755);
  const state = {
    login: 'tuannd9288',
    agent: 'tuan9288-agent',
    repo: { id: 1234, full_name: 'tuannd9288/app', owner: { login: 'tuannd9288' }, default_branch: 'main', permissions: { admin: true } },
    kitLanded: false,
    collaborator: null,
    invitations: [],
    rulesets: [],
    environment: null,
    next: 100,
    ...over,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(join(dir, 'git-calls'), '');
  const owner = (args) => {
    const out = spawnSync(join(factory, 'bin/onboard-owner'), args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_STATE: join(dir, 'state.json'), GH_CALLS: join(dir, 'calls'), GIT_CALLS: join(dir, 'git-calls') },
    });
    return { code: out.status, out: out.stdout + out.stderr };
  };
  return {
    dir,
    owner,
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
    set: (patch) => writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), ...patch })),
    writes: () => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((l) => / -X (PUT|POST|DELETE|PATCH) /.test(l)),
    clear: () => writeFileSync(join(dir, 'calls'), ''),
    gitCalls: () => readFileSync(join(dir, 'git-calls'), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('the owner script refuses a repository other than the one named, a login without admin, and the agents\' login', () => {
  const w = world();
  try {
    let out = w.owner(['tuannd9288/app', '--id', '9999', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /repository id 1234, not 9999/);
    out = w.owner(['tuannd9288/app', '--apply']);
    assert.equal(out.code, 2, out.out);
    w.set({ login: 'tuan9288-agent' });
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /runs as the Human, the repository's owner, not as the agents' account/);
    w.set({ login: 'tuannd9288', repo: { ...w.state().repo, permissions: { admin: false } } });
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /no admin right/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('the owner script shows every change it would make, and makes none without --apply', () => {
  const w = world();
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /PUT repos\/tuannd9288\/app\/collaborators\/tuan9288-agent \{"permission":"push"\}/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-branches".*"~ALL".*"non_fast_forward"/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-tags","target":"tag".*"~ALL".*"creation".*"update".*"deletion"/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-bootstrap"/);
    assert.match(out.out, /PUT repos\/tuannd9288\/app\/environments\/reviewer \{"deployment_branch_policy":\{"protected_branches":false,"custom_branch_policies":true\}\}/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/environments\/reviewer\/deployment-branch-policies \{"name":"main","type":"branch"\}/);
    assert.match(out.out, /dry run: nothing changed; rerun with --apply/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('the owner script applies, reads back what it set, and on a second run changes nothing; it never runs git', () => {
  const w = world();
  try {
    let out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /read back: every setting as planned/);
    assert.match(out.out, /waiting: tuan9288-agent accepts the invitation/);
    const s = w.state();
    assert.deepEqual(s.rulesets.map((r) => r.name).sort(), ['factory-bootstrap', 'factory-branches', 'factory-claims', 'factory-tags']);
    assert.deepEqual(s.environment.policies.map((p) => p.name), ['main']);
    w.set({ collaborator: 'write', invitations: [] });
    w.clear();
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.writes(), []);
    assert.doesNotMatch(out.out, /waiting:/);
    assert.equal(w.gitCalls(), '');
  } finally {
    w.cleanup();
  }
});

test('once the kit is on main, the owner script puts the gate\'s ruleset in, then takes the bootstrap one out', () => {
  const w = world();
  try {
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    w.set({ kitLanded: true, collaborator: 'write', invitations: [] });
    w.clear();
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    const writes = w.writes();
    const gate = writes.findIndex((l) => / -X POST repos\/tuannd9288\/app\/rulesets /.test(l));
    const drop = writes.findIndex((l) => / -X DELETE repos\/tuannd9288\/app\/rulesets\/\d+/.test(l));
    assert.ok(gate >= 0 && drop > gate, writes.join('\n'));
    assert.deepEqual(w.state().rulesets.map((r) => r.name).sort(), ['factory-branches', 'factory-claims', 'factory-gate', 'factory-tags']);
  } finally {
    w.cleanup();
  }
});

test('with GATE_REVIEWER=entire the gate requires verify, tier and Entire Gates from Entire\'s App, not review or verdict (#155)', async () => {
  const { ENTIRE_APP } = await import('../bin/lib/owner.mjs');
  const app = { [ENTIRE_APP.slug]: { id: ENTIRE_APP.id, slug: ENTIRE_APP.slug } };
  const w = world({ kitLanded: true, collaborator: 'write', variables: [{ name: 'GATE_REVIEWER', value: 'entire' }], apps: app });
  try {
    let out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /GATE_REVIEWER is entire/);
    assert.match(out.out, /read back: every setting as planned/);
    const gate = w.state().rulesets.find((r) => r.name === 'factory-gate');
    const checks = gate.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
    assert.deepEqual(checks, [{ context: 'verify', integration_id: 15368 }, { context: 'tier', integration_id: 15368 }, { context: 'Entire Gates', integration_id: ENTIRE_APP.id }]);
    // A second run changes nothing; the kit's own ruleset, with review and verdict, comes back only with the variable gone.
    w.clear();
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.writes(), []);
    w.set({ variables: [] });
    out = w.owner(['tuannd9288/app', '--id', '1234']);
    assert.match(out.out, /PUT repos\/tuannd9288\/app\/rulesets\/\d+ \{"name":"factory-gate".*"context":"review"/);
  } finally {
    w.cleanup();
  }
});

test('an Entire App that GitHub does not know by that slug and id is refused before anything changes', async () => {
  const { ENTIRE_APP } = await import('../bin/lib/owner.mjs');
  for (const apps of [{}, { [ENTIRE_APP.slug]: { id: ENTIRE_APP.id + 1, slug: ENTIRE_APP.slug } }]) {
    const w = world({ kitLanded: true, collaborator: 'write', variables: [{ name: 'GATE_REVIEWER', value: 'entire' }], apps });
    try {
      const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, new RegExp(`Entire's App ${ENTIRE_APP.slug}`));
      assert.deepEqual(w.writes(), []);
    } finally {
      w.cleanup();
    }
  }
});

// #210: the four values, one option each, as bin/onboard-owner takes them.
const MAIN = '["self-hosted","macOS","main"]';
const PR = '["self-hosted","macOS","pr"]';
const TRUSTED = '["self-hosted","macOS","trusted"]';
const FOUR = ['--runner', MAIN, '--pr-runner', PR, '--trusted-runner', TRUSTED, '--reviewer', 'claude'];
const variable = (name, value) => `POST repos/tuannd9288/app/actions/variables ${JSON.stringify({ name, value })}`;

test('the owner script names the four gate variables among the changes it would make, and makes none without --apply (#210)', () => {
  const w = world();
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', ...FOUR]);
    assert.equal(out.code, 0, out.out);
    for (const [name, value] of [['GATE_RUNNER', MAIN], ['GATE_PR_RUNNER', PR], ['GATE_TRUSTED_RUNNER', TRUSTED], ['GATE_REVIEWER', 'claude']])
      assert.ok(out.out.includes(variable(name, value)), `${name} not among the changes:\n${out.out}`);
    assert.match(out.out, /dry run: nothing changed; rerun with --apply/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('the owner script sets the four gate variables, reads them back, and a second run with the same values changes nothing (#210)', () => {
  const w = world();
  try {
    let out = w.owner(['tuannd9288/app', '--id', '1234', ...FOUR, '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /done {4}variable GATE_RUNNER/);
    assert.match(out.out, /read back: every setting as planned/);
    const held = Object.fromEntries(w.state().variables.map((v) => [v.name, v.value]));
    assert.deepEqual(held, { GATE_RUNNER: MAIN, GATE_PR_RUNNER: PR, GATE_TRUSTED_RUNNER: TRUSTED, GATE_REVIEWER: 'claude' });
    w.set({ collaborator: 'write', invitations: [] });
    w.clear();
    out = w.owner(['tuannd9288/app', '--id', '1234', ...FOUR, '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.writes(), []);
    assert.match(out.out, /nothing to change/);
  } finally {
    w.cleanup();
  }
});

test('the variables are set before the gate\'s ruleset, which follows the GATE_REVIEWER being set (#210, #155)', async () => {
  const { ENTIRE_APP } = await import('../bin/lib/owner.mjs');
  const apps = { [ENTIRE_APP.slug]: { id: ENTIRE_APP.id, slug: ENTIRE_APP.slug } };
  const w = world({ kitLanded: true, collaborator: 'write', apps });
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', ...FOUR.slice(0, 6), '--reviewer', 'entire', '--apply']);
    assert.equal(out.code, 0, out.out);
    const writes = w.writes();
    const last = writes.map((l, i) => (/\/actions\/variables/.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const gate = writes.findIndex((l) => / -X POST repos\/tuannd9288\/app\/rulesets /.test(l));
    assert.ok(last >= 0 && gate > last, writes.join('\n'));
    const checks = w.state().rulesets.find((r) => r.name === 'factory-gate').rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
    assert.ok(checks.some((c) => c.context === ENTIRE_APP.check), JSON.stringify(checks));
  } finally {
    w.cleanup();
  }
});

test('on the first run GitHub may answer 404 for the permission of an account not yet a collaborator', () => {
  // GitHub's docs give this endpoint two answers, 200 and 404 "Resource not found".
  const w = world({ permission404: true });
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /done {4}collaborator tuan9288-agent \(write\)/);
  } finally {
    w.cleanup();
  }
});

test('a tag ruleset whose bypass actor was changed is put back, and one that reads back as set is left alone', () => {
  const w = world();
  try {
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    w.set({ collaborator: 'write', invitations: [] });
    const rulesets = w.state().rulesets.map((r) => (r.name === 'factory-tags' ? { ...r, bypass_actors: [] } : r));
    w.set({ rulesets });
    w.clear();
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    const tagsId = w.state().rulesets.find((r) => r.name === 'factory-tags').id;
    const writes = w.writes();
    assert.equal(writes.length, 1, writes.join('\n'));
    assert.match(writes[0], new RegExp(` -X PUT repos/tuannd9288/app/rulesets/${tagsId} `));
    assert.deepEqual(w.state().rulesets.find((r) => r.name === 'factory-tags').bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
  } finally {
    w.cleanup();
  }
});

test('a second bypass actor on the live tag ruleset is taken out: exactly one PUT, to the factory-tags id', () => {
  const w = world();
  try {
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    w.set({ collaborator: 'write', invitations: [] });
    const admin = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' };
    w.set({ rulesets: w.state().rulesets.map((r) => (r.name === 'factory-tags' ? { ...r, bypass_actors: [admin, { actor_id: 6, actor_type: 'RepositoryRole', bypass_mode: 'always' }] } : r)) });
    w.clear();
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    const tagsId = w.state().rulesets.find((r) => r.name === 'factory-tags').id;
    const writes = w.writes();
    assert.equal(writes.length, 1, writes.join('\n'));
    assert.match(writes[0], new RegExp(` -X PUT repos/tuannd9288/app/rulesets/${tagsId} `));
    assert.deepEqual(w.state().rulesets.find((r) => r.name === 'factory-tags').bypass_actors, [admin]);
  } finally {
    w.cleanup();
  }
});

test('factory-claims: a claim ref cannot be deleted or rewritten, with no bypass, and no other ref is named', () => {
  const claims = JSON.parse(readFileSync(join(factory, 'bin/rulesets/claims.json'), 'utf8'));
  assert.equal(claims.name, 'factory-claims');
  assert.equal(claims.target, 'branch');
  assert.equal(claims.enforcement, 'active');
  assert.deepEqual(claims.conditions.ref_name, { include: ['refs/heads/claim/**'], exclude: [] });
  assert.deepEqual(claims.rules.map((r) => r.type).sort(), ['deletion', 'non_fast_forward']);
  assert.deepEqual(claims.bypass_actors, []);
});

test('the owner script sets factory-claims before the kit lands and keeps it after, and a second run changes nothing', () => {
  const w = world();
  try {
    const dry = w.owner(['tuannd9288/app', '--id', '1234']);
    assert.match(dry.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-claims","target":"branch".*"refs\/heads\/claim\/\*\*".*"deletion"/);
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.ok(w.state().rulesets.some((r) => r.name === 'factory-claims'));
    w.set({ kitLanded: true, collaborator: 'write', invitations: [] });
    w.clear();
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.ok(w.state().rulesets.some((r) => r.name === 'factory-claims'));
    w.clear();
    const again = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('a setting that does not read back as set leaves the onboarding incomplete', () => {
  const w = world({ ignore: 'rulesets' });
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /incomplete: .*factory-branches/);
    assert.match(out.out, /incomplete: .*factory-tags/);
  } finally {
    w.cleanup();
  }
});

test('the factory\'s rulesets: no rewrite on any branch, and one approval of the last push on main before the kit', () => {
  const read = (name) => JSON.parse(readFileSync(join(factory, 'bin/rulesets', name), 'utf8'));
  const branches = read('branches.json');
  assert.deepEqual(branches.conditions.ref_name.include, ['~ALL']);
  assert.deepEqual(branches.rules, [{ type: 'non_fast_forward' }]);
  assert.deepEqual(branches.bypass_actors, []);
  const tags = read('tags.json');
  assert.equal(tags.target, 'tag');
  assert.equal(tags.enforcement, 'active');
  assert.deepEqual(tags.conditions.ref_name, { include: ['~ALL'], exclude: [] });
  assert.deepEqual(tags.rules, [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }]);
  assert.deepEqual(tags.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], 'only a repository admin');
  const bootstrap = read('bootstrap.json');
  assert.deepEqual(bootstrap.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.deepEqual(bootstrap.bypass_actors, []);
  assert.ok(!bootstrap.rules.some((r) => r.type === 'required_status_checks'), 'no check exists before the kit lands');
  const pr = bootstrap.rules.find((r) => r.type === 'pull_request').parameters;
  assert.equal(pr.required_approving_review_count, 1);
  assert.equal(pr.require_last_push_approval, true);
  assert.equal(pr.require_code_owner_review, false, 'no CODEOWNERS exists before the kit lands');
  assert.deepEqual(pr.allowed_merge_methods, ['merge']);
});

test('onboard opens the kit pull request only as the agents\' account, after the owner script ran', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-turn-'));
  try {
    writeFileSync(
      join(dir, 'gh'),
      '#!/bin/sh\ncase "$*" in\n  "api user"*) echo "$LOGIN" ;;\n  *rules/branches/main*) echo "$RULES" ;;\n  *) exit 1 ;;\nesac\n',
    );
    chmodSync(join(dir, 'gh'), 0o755);
    const onboard = (env) =>
      spawnSync(join(factory, 'bin/onboard'), ['https://github.com/tuannd9288/app.git'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), ...env },
      });
    let out = onboard({ LOGIN: 'tuannd9288', RULES: '[{"type":"pull_request"}]' });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stdout + out.stderr, /opens the kit pull request as the agents' account \(tuan9288-agent\), not as tuannd9288/);
    out = onboard({ LOGIN: 'tuan9288-agent', RULES: '[]' });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stdout + out.stderr, /main has no pull request rule: bin\/onboard-owner runs first/);
    assert.ok(!existsSync(join(dir, 'root/app')), 'cloned before refusing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the factory\'s tools run the same started through a symlinked directory, as under /var/folders on macOS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linked-'));
  try {
    symlinkSync(join(factory, 'bin'), join(dir, 'bin'));
    // factory-queue records a run that fails before its repository loop, a usage error among them (#35).
    const env = { ...process.env, FACTORY_STATE: join(dir, 'state'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_ROOT: join(dir, 'root') };
    for (const tool of ['factory-ledger', 'factory-queue', 'onboard-owner', 'kit-evidence']) {
      const direct = spawnSync(join(factory, 'bin', tool), ['bogus'], { encoding: 'utf8', env });
      const linked = spawnSync(join(dir, 'bin', tool), ['bogus'], { encoding: 'utf8', env });
      assert.notEqual(direct.status, 0, tool);
      assert.equal(linked.status, direct.status, `${tool}: ${linked.stdout}${linked.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
