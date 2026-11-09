// The admin step of taking a repository in, bin/onboard-owner, against a fake GitHub that keeps the repository's
// settings in a file; and the team's step, bin/onboard, refusing to open the kit pull request out of turn. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { GATE, MAIN, TRUSTED, render } from '../bin/lib/gate-settings.mjs';
import { gh } from '../bin/lib/owner.mjs';

/** The three gate workflows as main holds them once bin/onboard filled them in with `values` (#335). */
const onMain = (values) => Object.fromEntries([MAIN, GATE, TRUSTED].map((p) => [p, render(p, readFileSync(join(factory, 'kit', p), 'utf8'), values)]));

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
  else if (args[i] === '-H') i++;
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
// #139: the repository's own settings are changed by a PATCH of its path.
if (path === repo && method === 'PATCH') {
  if (kept('repository')) Object.assign(state.repo, body);
  done(state.repo);
}
if (path === repo) done(state.repo);
if (path.startsWith(repo + '/contents/.gate/kit-files')) state.kitLanded ? done({ path: '.gate/kit-files' }) : missing();
// #335: a file on main, as the contents API gives it, base64; #337: a folder of them, as a list.
if (path.startsWith(repo + '/contents/')) {
  const file = decodeURIComponent(path.slice((repo + '/contents/').length).split('?')[0]);
  const text = (state.files ?? {})[file];
  const inside = Object.keys(state.files ?? {}).filter((p) => p.startsWith(file + '/') && !p.slice(file.length + 1).includes('/'));
  if (text === undefined && inside.length) done(inside.map((p) => ({ type: 'file', name: p.split('/').pop(), path: p })));
  text === undefined ? missing() : done({ path: file, encoding: 'base64', content: Buffer.from(text).toString('base64') });
}
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
  if (method === 'PUT') { (state.puts ??= []).push(body); if (kept('rulesets')) state.rulesets[i] = { ...state.rulesets[i], ...body }; done(state.rulesets[i]); }
  if (method === 'DELETE') { state.rulesets.splice(i, 1); done(); }
  // GitHub answers with defaults the request did not set; a read-back compares only what was asked for.
  const r = state.rulesets[i];
  const read = { ...r, rules: r.rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { required_reviewers: [], ...x.parameters } } : x)) };
  // So does the tag ruleset: a bypass actor with a field of its own, a parameter on the update rule, a top-level field.
  if (r.target === 'tag') done({ ...read, current_user_can_bypass: 'never', bypass_actors: read.bypass_actors.map((b) => ({ ...b, actor_name: 'admin' })), rules: read.rules.map((x) => (x.type === 'update' ? { ...x, parameters: { update_allows_fetch_and_merge: false } } : x)) });
  done(read);
}
// #333: the rules in force on the default branch, which the merge switch is read from: every rule of every active branch ruleset.
// With --slurp, as gh gives it, the list is a page of a list of pages.
// A call that does not ask for every page fails, so a command that drops --paginate or --slurp turns a test red.
if (path === repo + '/rules/branches/main') {
  if (!args.includes('--paginate') || !args.includes('--slurp')) { process.stderr.write('fake gh: the rules are asked without --paginate --slurp\n'); process.exit(1); }
  const list = state.rulesets.filter((r) => r.target === 'branch' && r.enforcement === 'active').flatMap((r) => r.rules.map((x) => ({ ...x, ruleset_id: r.id })));
  done([list]);
}
// #337: the repository's Actions event policies, whose endpoints are documented for one API version, which a call must name.
if (path.startsWith(repo + '/actions/policies')) {
  if (!args.includes('X-GitHub-Api-Version: 2026-03-10')) { process.stderr.write('fake gh: an Actions policies call without its API version\n'); process.exit(1); }
  state.actionsPolicies ??= [];
  const id = /actions\/policies\/(\d+)$/.exec(path)?.[1];
  if (method === 'POST') { const p = { id: state.next++, target: 'actions', source_type: 'repository', ...body }; if (kept('policy')) state.actionsPolicies.push(p); done(p); }
  if (id && method === 'PUT') {
    const i = state.actionsPolicies.findIndex((p) => p.id === Number(id));
    if (i < 0) missing();
    if (kept('policy')) state.actionsPolicies[i] = { ...state.actionsPolicies[i], ...body };
    done(state.actionsPolicies[i]);
  }
  // As GitHub answers (tuannd9288/factory, 2026-11-07): a policy read by its id carries its conditions and rules, a list entry does not.
  if (id) { const p = state.actionsPolicies.find((x) => x.id === Number(id)); p ? done(p) : missing(); }
  done({ total_count: state.actionsPolicies.length, policies: state.actionsPolicies.map(({ conditions, rules, ...entry }) => entry) });
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
    agent: 'nami9288',
    repo: { id: 1234, full_name: 'tuannd9288/app', owner: { login: 'tuannd9288' }, default_branch: 'main', permissions: { admin: true }, allow_auto_merge: true },
    kitLanded: false,
    collaborator: null,
    invitations: [],
    rulesets: [],
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
    w.set({ login: 'nami9288' });
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

test('the owner script offers no reviewer: the gate requires verify and tier alone, and no reviewer environment is made (FAC-100)', () => {
  const w = world({ kitLanded: true, collaborator: 'write', invitations: [], files: onMain({}) });
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    const gate = w.state().rulesets.find((r) => r.name === 'factory-gate');
    const checks = gate.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context);
    assert.deepEqual(checks, ['verify', 'tier']);
    assert.ok(!w.writes().some((l) => l.includes('environments/reviewer')), w.writes().join('\n'));
    assert.doesNotMatch(out.out, /reviewer/);
  } finally {
    w.cleanup();
  }
});

/** The kit's gate-trusted.yml as a main on the kit before FAC-100 held it with the reviewer entire (#155): the line its tier read. */
const oldEntire = (files) => ({ ...files, [TRUSTED]: files[TRUSTED].replace(/^env:\n/m, "env:\n  GATE_REVIEWER: 'entire'\n") });
const checksOf = (w) => w.state().rulesets.find((r) => r.name === 'factory-gate').rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context);

test('a main on the kit before FAC-100 that names the reviewer entire keeps the Entire ruleset until its kit update, then gets verify and tier (#155, FAC-102)', async () => {
  const { ENTIRE_APP } = await import('../bin/lib/owner.mjs');
  const apps = { [ENTIRE_APP.slug]: { id: ENTIRE_APP.id, slug: ENTIRE_APP.slug } };
  const old = oldEntire(onMain({}));
  assert.notEqual(old[TRUSTED], onMain({})[TRUSTED]);
  const w = world({ kitLanded: true, collaborator: 'write', invitations: [], apps, files: old });
  try {
    let out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(checksOf(w), ['verify', 'tier', ENTIRE_APP.check]);
    const pinned = w.state().rulesets.find((r) => r.name === 'factory-gate').rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.at(-1);
    assert.equal(pinned.integration_id, ENTIRE_APP.id);
    w.clear();
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.writes(), []);
    // Its kit update lands: main names no reviewer, and the next run puts the kit's gate in.
    w.set({ files: onMain({}) });
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(checksOf(w), ['verify', 'tier']);
  } finally {
    w.cleanup();
  }
});

test('an Entire App that GitHub does not know by that slug and id is refused before anything changes', async () => {
  const { ENTIRE_APP } = await import('../bin/lib/owner.mjs');
  for (const apps of [{}, { [ENTIRE_APP.slug]: { id: ENTIRE_APP.id + 1, slug: ENTIRE_APP.slug } }]) {
    const w = world({ kitLanded: true, collaborator: 'write', files: oldEntire(onMain({})), apps });
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

test('the owner script shows every change it would make, and makes none without --apply', () => {
  const w = world();
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /PUT repos\/tuannd9288\/app\/collaborators\/nami9288 \{"permission":"push"\}/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-branches".*"~DEFAULT_BRANCH".*"non_fast_forward"/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-tags","target":"tag".*"~ALL".*"creation".*"update".*"deletion"/);
    assert.match(out.out, /POST repos\/tuannd9288\/app\/rulesets \{"name":"factory-bootstrap"/);
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
    assert.match(out.out, /waiting: nami9288 accepts the invitation/);
    const s = w.state();
    assert.deepEqual(s.rulesets.map((r) => r.name).sort(), ['factory-bootstrap', 'factory-branches', 'factory-claims', 'factory-tags']);
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

test('once the kit is on main, the owner script puts the gate\'s ruleset in, then takes the bootstrap one out, and sets the Actions event policy main\'s workflows need (#337)', () => {
  const w = world();
  try {
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.state().actionsPolicies ?? [], [], 'no policy before the kit is on main');
    w.set({ kitLanded: true, collaborator: 'write', invitations: [], files: onMain({}) });
    w.clear();
    // The policy allows the one workflow on main that runs on pull_request_target the events its on: block names.
    const policy = { name: 'factory gate: pull_request_target', enforcement: 'active', conditions: { workflow_path: { include: [TRUSTED], exclude: [] } }, rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['pull_request_target'] } }] };
    const dry = w.owner(['tuannd9288/app', '--id', '1234']);
    assert.ok(dry.out.includes(`change  Actions event policy "${policy.name}": POST repos/tuannd9288/app/actions/policies ${JSON.stringify(policy)}`), dry.out);
    assert.deepEqual(w.writes(), []);
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    const writes = w.writes();
    const gate = writes.findIndex((l) => / -X POST repos\/tuannd9288\/app\/rulesets /.test(l));
    const drop = writes.findIndex((l) => / -X DELETE repos\/tuannd9288\/app\/rulesets\/\d+/.test(l));
    assert.ok(gate >= 0 && drop > gate, writes.join('\n'));
    assert.deepEqual(w.state().rulesets.map((r) => r.name).sort(), ['factory-branches', 'factory-claims', 'factory-gate', 'factory-tags']);
    assert.ok(writes.includes('api -X POST -H X-GitHub-Api-Version: 2026-03-10 repos/tuannd9288/app/actions/policies --input -'), writes.join('\n'));
    const [{ id, target, source_type, ...set }] = w.state().actionsPolicies;
    assert.deepEqual(set, policy);
    assert.match(out.out, /read back: every setting as planned/);
    // A second run changes nothing; a policy that drifted is put back by its id.
    w.clear();
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.writes(), []);
    w.set({ actionsPolicies: [{ ...w.state().actionsPolicies[0], rules: [{ type: 'restrict_action_events', parameters: { allowed_events: ['pull_request'] } }] }] });
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.writes(), [`api -X PUT -H X-GitHub-Api-Version: 2026-03-10 repos/tuannd9288/app/actions/policies/${id} --input -`]);
    assert.deepEqual(w.state().actionsPolicies[0].rules, policy.rules);
    // GitHub's echo may drop the empty exclude and give the lists in another order: the same policy plans no PUT, and a
    // different event still plans one. Two workflows on pull_request_target and two events, so an order can differ.
    const kit = onMain({});
    const two = { ...kit, [GATE]: kit[GATE].replace(/^on:\n {2}pull_request:\n/m, 'on:\n  pull_request_target:\n'), [TRUSTED]: kit[TRUSTED].replace(/^on:\n/m, 'on:\n  workflow_dispatch:\n') };
    assert.ok(two[GATE] !== kit[GATE] && two[TRUSTED] !== kit[TRUSTED]);
    w.set({ files: two });
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    const live = w.state().actionsPolicies[0];
    assert.deepEqual([...live.conditions.workflow_path.include].sort(), [GATE, TRUSTED].sort());
    assert.deepEqual(live.rules[0].parameters.allowed_events, ['pull_request_target', 'workflow_dispatch']);
    const { exclude, ...path } = live.conditions.workflow_path;
    const echo = (events) => ({ ...live, conditions: { workflow_path: { ...path, include: [...path.include].reverse() } }, rules: [{ type: 'restrict_action_events', parameters: { allowed_events: events } }] });
    w.set({ actionsPolicies: [echo(['workflow_dispatch', 'pull_request_target'])] });
    w.clear();
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.writes(), [], 'the same policy in another order, without its empty exclude');
    w.set({ actionsPolicies: [echo(['workflow_dispatch', 'push'])] });
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.writes(), [`api -X PUT -H X-GitHub-Api-Version: 2026-03-10 repos/tuannd9288/app/actions/policies/${id} --input -`]);
    // FAC-48: a policy set outside this script (the direct POSTs on three repositories, 2026-11-07) is found by name, read by its id,
    // and holds, with no PUT.
    w.set({ actionsPolicies: [{ ...w.state().actionsPolicies[0], id: 11817 }] });
    w.clear();
    assert.equal(w.owner(['tuannd9288/app', '--id', '1234', '--apply']).code, 0);
    assert.deepEqual(w.writes(), [], 'a policy that already holds, under an id this script did not make');
  } finally {
    w.cleanup();
  }
});

test('the three options that set repository variables are refused with nothing called, and --reviewer is unknown (FAC-100); no run writes a variable (#335)', () => {
  for (const extra of [['--runner', '"ubuntu-latest"'], ['--pr-runner', '["self-hosted","macOS"]'], ['--trusted-runner', '"ubuntu-latest"']]) {
    const w = world();
    try {
      const out = w.owner(['tuannd9288/app', '--id', '1234', ...extra, '--apply']);
      assert.equal(out.code, 2, `${extra.join(' ')}\n${out.out}`);
      assert.match(out.out, new RegExp(`${extra[0]} is not this command's \\(#335\\): the gate's settings are in the workflows on main`));
      assert.equal(readFileSync(join(w.dir, 'calls'), 'utf8'), '', `${extra.join(' ')} reached GitHub`);
    } finally {
      w.cleanup();
    }
  }
  for (const extra of [['--runer', '"ubuntu-latest"'], ['--reviewer', 'claude'], ['--id']]) {
    const w = world();
    try {
      const out = w.owner(['tuannd9288/app', ...(extra[0] === '--id' ? [] : ['--id', '1234']), ...extra]);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /usage: bin\/onboard-owner <owner\/name> --id <repository id> \[--apply\]/);
      assert.equal(readFileSync(join(w.dir, 'calls'), 'utf8'), '');
    } finally {
      w.cleanup();
    }
  }
  const w = world({ kitLanded: true, collaborator: 'write', files: onMain({}), variables: [{ name: 'GATE_RUNNER', value: '["self-hosted","zz-held-runner"]' }, { name: 'OTHER', value: 'zz-other-value' }] });
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.writes().filter((l) => /actions\/variables/.test(l)), []);
    for (const secret of ['zz-held-runner', 'zz-other-value']) assert.ok(!out.out.includes(secret), `${secret} printed:\n${out.out}`);
  } finally {
    w.cleanup();
  }
});

test('allow auto-merge is listed, turned on by --apply, read back, and said to be on when it is (#139)', () => {
  const patch = 'api -X PATCH repos/tuannd9288/app --input -';
  const turnOff = (x) => x.set({ repo: { ...x.state().repo, allow_auto_merge: false } });
  const w = world();
  try {
    turnOff(w);
    let out = w.owner(['tuannd9288/app', '--id', '1234']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /change  allow auto-merge: PATCH repos\/tuannd9288\/app \{"allow_auto_merge":true\}/);
    assert.deepEqual(w.writes(), []);
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.writes().filter((l) => l.includes(' PATCH ')), [patch]);
    assert.equal(w.state().repo.allow_auto_merge, true);
    assert.match(out.out, /read back: every setting as planned/);
    w.clear();
    out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /onboard-owner: allow auto-merge is on/);
    assert.doesNotMatch(out.out, /change  allow auto-merge/);
    assert.deepEqual(w.writes().filter((l) => l.includes(' PATCH ')), []);
  } finally {
    w.cleanup();
  }
  const dropped = world({ ignore: 'repository' });
  try {
    turnOff(dropped);
    const out = dropped.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /incomplete: .*allow auto-merge/);
  } finally {
    dropped.cleanup();
  }
});

test('on the first run GitHub may answer 404 for the permission of an account not yet a collaborator', () => {
  // GitHub's docs give this endpoint two answers, 200 and 404 "Resource not found".
  const w = world({ permission404: true });
  try {
    const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /done {4}collaborator nami9288 \(write\)/);
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
    w.set({ kitLanded: true, collaborator: 'write', invitations: [], files: onMain({}) });
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

// #333: the merge switch is the two review parameters of the factory-gate ruleset; only the owner's login moves it.
const ME = ['tuannd9288/app', '--id', '1234'];
const inForce = (over = {}) => world({ kitLanded: true, collaborator: 'write', files: onMain({}), ...over });
const gateOf = (w) => w.state().rulesets.find((r) => r.name === 'factory-gate');
const reviewOf = (w) => {
  const p = gateOf(w).rules.find((r) => r.type === 'pull_request').parameters;
  return [p.required_approving_review_count, p.require_code_owner_review];
};
/** The gate with its review parameters set, as the Human's own click in Settings would leave it. */
const setReview = (w, count, owner) =>
  w.set({ rulesets: w.state().rulesets.map((r) => (r.name !== 'factory-gate' ? r : { ...r, rules: r.rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, required_approving_review_count: count, require_code_owner_review: owner } } : x)) })) });
const POSITIONS = [['all', 0, false], ['1-2', 0, true], ['none', 1, true]];

test('the factory\'s own repository gets only the Actions event policy its workflows on pull_request_target need, and no kit setting (#337)', () => {
  // Its main as this checkout holds it: approval.yml runs on pull_request_target, verify.yml on pull_request and push.
  const files = Object.fromEntries(['.github/workflows/approval.yml', '.github/workflows/verify.yml'].map((p) => [p, readFileSync(join(factory, p), 'utf8')]));
  const own = { id: 50, name: 'factory', target: 'branch', enforcement: 'active', rules: [] };
  const w = world({ repo: { id: 1234, full_name: 'tuannd9288/factory', owner: { login: 'tuannd9288' }, default_branch: 'main', permissions: { admin: true }, allow_auto_merge: false }, files, rulesets: [own] });
  const me = ['tuannd9288/factory', '--id', '1234'];
  try {
    const dry = w.owner(me);
    assert.equal(dry.code, 0, dry.out);
    assert.deepEqual(dry.out.split('\n').filter((l) => l.startsWith('  change  ')).map((l) => l.slice(0, l.indexOf('": ') + 1)), ['  change  Actions event policy "factory gate: pull_request_target"'], dry.out);
    assert.deepEqual(w.writes(), []);
    const out = w.owner([...me, '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.writes(), ['api -X POST -H X-GitHub-Api-Version: 2026-03-10 repos/tuannd9288/factory/actions/policies --input -']);
    const [{ conditions, rules }] = w.state().actionsPolicies;
    assert.deepEqual(conditions.workflow_path, { include: ['.github/workflows/approval.yml'], exclude: [] });
    assert.deepEqual(rules, [{ type: 'restrict_action_events', parameters: { allowed_events: ['pull_request_target'] } }]);
    assert.deepEqual(w.state().rulesets, [own], 'its own ruleset stays, and no kit ruleset goes there');
    assert.equal(w.state().repo.allow_auto_merge, false);
    assert.match(out.out, /read back: the Actions event policy as planned/);
    w.clear();
    assert.equal(w.owner([...me, '--apply']).code, 0);
    assert.deepEqual(w.writes(), []);
    assert.equal(w.owner([...me, '--merge', 'all', '--apply']).code, 2);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('a gate put in new starts at 1-2, and the run names the position it reads, the bootstrap ruleset\'s being none (#333)', () => {
  const w = inForce();
  try {
    const out = w.owner([...ME, '--apply']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /the merge switch on main is 1-2/);
    assert.deepEqual(reviewOf(w), [0, true]);
  } finally {
    w.cleanup();
  }
  const before = world();
  try {
    assert.equal(before.owner([...ME, '--apply']).code, 0);
    before.set({ kitLanded: true, collaborator: 'write', invitations: [], files: onMain({}) });
    const out = before.owner(ME);
    assert.match(out.out, /the merge switch on main is none/);
  } finally {
    before.cleanup();
  }
});

test('a changed factory-gate is put back with the review parameters it holds, not the kit\'s (#333)', () => {
  for (const [position, count, owner] of POSITIONS) {
    const w = inForce();
    try {
      assert.equal(w.owner([...ME, '--apply']).code, 0);
      setReview(w, count, owner);
      // Another change to the ruleset: a required check taken out.
      w.set({ rulesets: w.state().rulesets.map((r) => (r.name !== 'factory-gate' ? r : { ...r, rules: r.rules.map((x) => (x.type === 'required_status_checks' ? { ...x, parameters: { ...x.parameters, required_status_checks: x.parameters.required_status_checks.filter((c) => c.context !== 'tier') } } : x)) })) });
      w.clear();
      const out = w.owner([...ME, '--apply']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, new RegExp(`the merge switch on main is ${position}`));
      const writes = w.writes();
      assert.equal(writes.length, 1, writes.join('\n'));
      assert.match(writes[0], new RegExp(` -X PUT repos/tuannd9288/app/rulesets/${gateOf(w).id} `));
      assert.deepEqual(reviewOf(w), [count, owner], position);
      const checks = gateOf(w).rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context);
      assert.ok(checks.includes('tier'), 'the rest of the ruleset is the kit\'s again');
    } finally {
      w.cleanup();
    }
  }
});

test('--merge sets the two parameters and nothing else: a dry run without --apply, read back with it, and a second run changes nothing (#333)', () => {
  const w = inForce();
  try {
    assert.equal(w.owner([...ME, '--apply']).code, 0);
    const masked = () => JSON.stringify(gateOf(w).rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, required_reviewers: undefined, required_approving_review_count: 0, require_code_owner_review: 0 } } : x)));
    const rest = masked();
    for (const [position, count, owner] of [POSITIONS[0], POSITIONS[2], POSITIONS[1]]) {
      const was = reviewOf(w);
      w.clear();
      let out = w.owner([...ME, '--merge', position]);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, new RegExp(`change  ruleset factory-gate: PUT repos/tuannd9288/app/rulesets/\\d+: required_approving_review_count ${was[0]} -> ${count}, require_code_owner_review ${was[1]} -> ${owner}; the rest of the ruleset is left as it is`));
      assert.match(out.out, /dry run: nothing changed; rerun with --apply/);
      assert.deepEqual(w.writes(), []);
      assert.deepEqual(reviewOf(w), was, 'a dry run moved the switch');
      w.clear();
      out = w.owner([...ME, '--merge', position, '--apply']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, new RegExp(`read back: the merge switch is ${position}`));
      assert.equal(w.writes().length, 1, w.writes().join('\n'));
      assert.deepEqual(reviewOf(w), [count, owner]);
      assert.equal(masked(), rest, 'only the two review parameters moved');
      w.clear();
      out = w.owner([...ME, '--merge', position, '--apply']);
      assert.equal(out.code, 0, out.out);
      assert.deepEqual(w.writes(), []);
    }
  } finally {
    w.cleanup();
  }
});

test('--merge reads back the position from the rules in force, and a write that did not take leaves the run incomplete (#333)', () => {
  const w = inForce();
  try {
    assert.equal(w.owner([...ME, '--apply']).code, 0);
    w.set({ ignore: 'rulesets' });
    const out = w.owner([...ME, '--merge', 'all', '--apply']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /incomplete: the merge switch reads 1-2, not all/);
  } finally {
    w.cleanup();
  }
});

test('--merge on a repository that has drifted from the kit changes the two parameters and nothing else (#333)', () => {
  const w = inForce();
  try {
    assert.equal(w.owner([...ME, '--apply']).code, 0);
    // Auto-merge off, as zalo-gateway has it, and a ruleset gone.
    w.set({ repo: { ...w.state().repo, allow_auto_merge: false }, rulesets: w.state().rulesets.filter((r) => r.name !== 'factory-claims') });
    w.clear();
    const dry = w.owner([...ME, '--merge', 'all']);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /change  ruleset factory-gate: PUT/);
    assert.match(dry.out, /not changed  allow auto-merge: .*--merge moves the merge switch only/);
    assert.match(dry.out, /not changed  ruleset factory-claims:/);
    assert.deepEqual(w.writes(), []);
    const out = w.owner([...ME, '--merge', 'all', '--apply']);
    assert.equal(out.code, 0, out.out);
    const writes = w.writes();
    assert.equal(writes.length, 1, writes.join('\n'));
    assert.match(writes[0], new RegExp(` -X PUT repos/tuannd9288/app/rulesets/${gateOf(w).id} `));
    assert.deepEqual(reviewOf(w), [0, false]);
    assert.equal(w.state().repo.allow_auto_merge, false, 'allow auto-merge stays off');
    assert.ok(!w.state().rulesets.some((r) => r.name === 'factory-claims'));
    assert.match(out.out, /read back: the merge switch is all/);
  } finally {
    w.cleanup();
  }
});

test('--merge writes the live gate ruleset back with the two parameters changed, and whatever else differs from the kit stays (#333)', () => {
  const w = inForce();
  try {
    assert.equal(w.owner([...ME, '--apply']).code, 0);
    // Drift inside the ruleset: a required check taken out and one added, and fields GitHub reads back but does not take.
    const drifted = w.state().rulesets.map((r) =>
      r.name !== 'factory-gate'
        ? r
        : {
            ...r,
            source_type: 'Repository',
            created_at: '2026-11-01T00:00:00Z',
            _links: { self: { href: 'x' } },
            current_user_can_bypass: 'never',
            rules: r.rules.map((x) => (x.type === 'required_status_checks' ? { ...x, parameters: { ...x.parameters, required_status_checks: [...x.parameters.required_status_checks.filter((c) => c.context !== 'tier'), { context: 'extra', integration_id: 15368 }] } } : x)),
          },
    );
    w.set({ rulesets: drifted });
    const live = JSON.parse(JSON.stringify(gateOf(w)));
    w.clear();
    const dry = w.owner([...ME, '--merge', 'none']);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /change  ruleset factory-gate: PUT repos\/tuannd9288\/app\/rulesets\/\d+: required_approving_review_count 0 -> 1, require_code_owner_review true -> true; the rest of the ruleset is left as it is/);
    assert.deepEqual(w.writes(), []);
    const out = w.owner([...ME, '--merge', 'none', '--apply']);
    assert.equal(out.code, 0, out.out);
    const body = w.state().puts.at(-1);
    assert.deepEqual(Object.keys(body).sort(), ['bypass_actors', 'conditions', 'enforcement', 'name', 'rules', 'target'], 'only what GitHub takes back');
    const checks = body.rules.find((x) => x.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context);
    assert.ok(checks.includes('extra') && !checks.includes('tier'), `the live difference stayed: ${checks}`);
    // (The fake's read adds required_reviewers: [], as GitHub does; it is not a difference.)
    const mask = (rules) => JSON.stringify(rules.map((x) => (x.type === 'pull_request' ? { ...x, parameters: { ...x.parameters, required_reviewers: undefined, required_approving_review_count: 0, require_code_owner_review: 0 } } : x)));
    assert.equal(mask(body.rules), mask(live.rules), 'only the two parameters changed');
    for (const key of ['name', 'target', 'enforcement', 'bypass_actors', 'conditions']) assert.deepEqual(body[key], live[key], key);
    assert.deepEqual(reviewOf(w), [1, true]);
    assert.match(out.out, /read back: the merge switch is none/);
  } finally {
    w.cleanup();
  }
});

test('--merge is refused with one line when the live gate ruleset has no pull_request rule (#333)', () => {
  const w = inForce();
  try {
    assert.equal(w.owner([...ME, '--apply']).code, 0);
    w.set({ rulesets: w.state().rulesets.map((r) => (r.name !== 'factory-gate' ? r : { ...r, rules: r.rules.filter((x) => x.type !== 'pull_request') })) });
    w.clear();
    const out = w.owner([...ME, '--merge', 'all', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /--merge: the factory-gate ruleset has no pull_request rule with both review parameters, so there is no switch to move/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('--merge is refused while the gate ruleset is not in force, and the bootstrap ruleset is left (#333)', () => {
  const w = world();
  try {
    assert.equal(w.owner([...ME, '--apply']).code, 0);
    w.set({ kitLanded: true, collaborator: 'write', invitations: [], files: onMain({}) });
    w.clear();
    const out = w.owner([...ME, '--merge', 'all', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /--merge moves the switch of the factory-gate ruleset, which is not in force on main yet/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('--merge is refused with a value that is no position, without a value, before the kit is on main, and under the agents\' login (#333)', () => {
  for (const extra of [['--merge', 'sideways'], ['--merge'], ['--merge', 'ALL']]) {
    const w = inForce();
    try {
      const out = w.owner([...ME, ...extra, '--apply']);
      assert.equal(out.code, 2, `${extra.join(' ')}\n${out.out}`);
      assert.match(out.out, /usage: bin\/onboard-owner <owner\/name> --id <repository id> \[--apply\] \[--merge all\|1-2\|none\]/);
      assert.equal(readFileSync(join(w.dir, 'calls'), 'utf8'), '', 'it reached GitHub');
    } finally {
      w.cleanup();
    }
  }
  let w = world();
  try {
    const out = w.owner([...ME, '--merge', 'all', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /--merge .*the kit is not on main/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
  w = inForce({ login: 'nami9288' });
  try {
    const out = w.owner([...ME, '--merge', 'all', '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /runs as the Human, the repository's owner, not as the agents' account/);
    assert.deepEqual(w.writes(), []);
  } finally {
    w.cleanup();
  }
});

test('on a main where the kit has landed, no guess is made at the events an Actions event policy must allow: an on: block not in the kit\'s form stops the run (#337)', () => {
  const kit = onMain({});
  const inline = { ...kit, [TRUSTED]: kit[TRUSTED].replace(/^on:\n {2}pull_request_target:\n {4}types: .*$/m, 'on: [pull_request_target]') };
  assert.notEqual(inline[TRUSTED], kit[TRUSTED]);
  const w = world({ kitLanded: true, collaborator: 'write', files: inline });
  try {
    const out = w.owner([...ME, '--apply']);
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /gate-trusted\.yml on main has no on: block in the kit's form/);
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
  assert.deepEqual(branches.conditions.ref_name.include, ['~DEFAULT_BRANCH', 'refs/heads/main', 'refs/heads/claim/**']);
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
    assert.match(out.stdout + out.stderr, /opens the kit pull request as the agents' account \(nami9288\), not as tuannd9288/);
    out = onboard({ LOGIN: 'nami9288', RULES: '[]' });
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

test('forcePush defaults to pstack, and off protects all branches', async () => {
  const { wanted, gateState } = await import('../bin/lib/owner.mjs');
  for (const forcePush of [undefined, 'pstack', 'off']) {
    const want = wanted({ kitLanded: true, branch: 'main', forcePush });
    assert.deepEqual(want.rulesets[0].conditions.ref_name.include,
      forcePush === 'off' ? ['~ALL'] : ['~DEFAULT_BRANCH', 'refs/heads/main', 'refs/heads/claim/**']);
    assert.ok(want.rulesets.find((r) => r.name === 'factory-claims').rules.some((r) => r.type === 'non_fast_forward'));
    assert.ok(want.rulesets.find((r) => r.name === 'factory-tags').rules.some((r) => r.type === 'update'));
  }
  const calls = [];
  const read = (args) => {
    calls.push(args);
    if (args[0] === 'variable') return [];
    if (args[1].includes('driver.json')) return { content: Buffer.from('{"forcePush":"off"}').toString('base64') };
    const error = new Error('missing'); error.stderr = '(HTTP 404)'; throw error;
  };
  assert.equal(gateState('o/r', 'candidate', read).forcePush, 'off');
  assert.ok(calls.some((args) => args[1] === 'repos/o/r/contents/.gate/driver.json?ref=main'));
});

for (const merge of [undefined, 'squash', 'merge']) {
  test(`the live ruleset follows main's merge method: ${merge ?? 'default squash'}`, () => {
    const files = onMain({});
    if (merge) files['.gate/driver.json'] = JSON.stringify({ merge });
    const w = world({ kitLanded: true, files });
    try {
      const out = w.owner(['tuannd9288/app', '--id', '1234', '--apply']);
      assert.equal(out.code, 0, out.out);
      assert.deepEqual(gateOf(w).rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, [merge ?? 'squash']);
      assert.equal(w.gitCalls(), '');
    } finally { w.cleanup(); }
  });
}

test('gh reads an answer larger than Node\'s 1 MiB default, as the kit\'s one gh runner allows (FAC-85)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-gh-'));
  const path = process.env.PATH;
  try {
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ big: 'x'.repeat(2 * 1024 * 1024) }));\n`);
    chmodSync(join(dir, 'gh'), 0o755);
    process.env.PATH = `${dir}:${path}`;
    assert.equal(gh(['api', 'repos/o/n/rulesets?per_page=100']).big.length, 2 * 1024 * 1024);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});
