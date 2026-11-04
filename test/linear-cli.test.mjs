// bin/lib/linear-cli.mjs (#404): `factory linear <verb>`. No network: createLinear's `fetchFn` is a fake Linear, so each test sees the
// mutation and the fields the verb really sends. Every id and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinear } from '../bin/lib/linear.mjs';
import { createCli, onLinear, parse, registryFile } from '../bin/lib/linear-cli.mjs';
import { writeAppFile } from '../bin/lib/token.mjs';

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const st = (id, name, type, position) => ({ id, name, type, position });
const TOKEN = 'lin_cli_token_0001';

/** A fake Linear with one team FAC; `teams` is the workspace's teams by key. */
function fake({ owners = ['owner-1'], copyBringsNeedsHuman = false, teamCreateFails = false, failIssueUpdate = false } = {}) {
  const f = { calls: [], appId: 'app-user-1', comments: [], teams: {}, pages: null };
  f.teams.FAC = { id: 'team-fac', key: 'FAC', name: 'Factory', states: { nodes: [st('s-triage', 'Triage', 'triage', 0), st('s-nh', 'Needs Human', 'started', 1), st('s-todo', 'Todo', 'unstarted', 2), st('s-prog', 'In Progress', 'started', 3), st('s-done', 'Done', 'completed', 4)] } };
  f.issue = { id: 'issue-uuid-1', identifier: 'FAC-12', team: f.teams.FAC };
  f.mutations = () => f.calls.filter((c) => c.query.includes('mutation'));
  f.fetchFn = async (url, init) => {
    if (url.endsWith('/oauth/token')) return json(200, { access_token: TOKEN, expires_in: 2_592_000, scope: 'read' });
    const body = JSON.parse(init.body);
    f.calls.push(body);
    const v = body.variables ?? {};
    const q = body.query;
    if (q.includes('viewer')) return json(200, { data: { viewer: { id: f.appId } } });
    if (q.includes('users(')) return json(200, { data: { users: { nodes: owners.map((id) => ({ id })) } } });
    if (q.includes('teamCreate')) {
      if (teamCreateFails) return json(200, { errors: [{ message: 'Forbidden: apps may not create teams' }] });
      const key = v.input.key;
      f.teams[key] = { id: `team-${key}`, key, name: v.input.name, states: { nodes: [st('n1', 'Todo', 'unstarted', 1), ...(copyBringsNeedsHuman ? [st('n2', 'Needs Human', 'started', 2)] : [])] } };
      return json(200, { data: { teamCreate: { success: true, team: { id: f.teams[key].id, key, name: v.input.name } } } });
    }
    if (q.includes('workflowStateCreate')) {
      f.teams[Object.values(f.teams).find((t) => t.id === v.input.teamId).key].states.nodes.push(st('made', v.input.name, v.input.type, 9));
      return json(200, { data: { workflowStateCreate: { success: true } } });
    }
    if (q.includes('teams(')) return json(200, { data: { teams: { nodes: f.teams[v.key] ? [f.teams[v.key]] : [] } } });
    if (q.includes('issueUpdate')) return failIssueUpdate ? json(200, { errors: [{ message: `refused for ${TOKEN}` }] }) : json(200, { data: { issueUpdate: { success: true, issue: { id: 'issue-uuid-1', identifier: 'FAC-12' } } } });
    if (q.includes('commentCreate')) return json(200, { data: { commentCreate: { success: true, comment: { id: `c-${f.comments.length}` } } } });
    if (q.includes('issueCreate')) return json(200, { data: { issueCreate: { success: true, issue: { id: 'new-1', identifier: 'FAC-99' } } } });
    if (q.includes('comments(')) {
      const page = f.pages ?? [{ nodes: [], more: false }];
      const at = v.after ? Number(v.after) : 0;
      return json(200, { data: { issue: { identifier: 'FAC-12', title: 'T', description: 'D', url: 'https://linear.app/x/FAC-12', state: { name: 'Todo', type: 'unstarted' }, delegate: null, assignee: { id: 'owner-1', name: 'Owner' },
        comments: { nodes: page[at].nodes, pageInfo: { hasNextPage: at + 1 < page.length, endCursor: String(at + 1) } } } } });
    }
    if (q.includes('issue(id')) return json(200, { data: { issue: f.issue } });
    return json(200, { data: {} });
  };
  return f;
}

function setup(opts) {
  const root = mkdtempSync(join(tmpdir(), 'linear-cli-'));
  const agentProfiles = join(root, 'profiles');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  writeAppFile(agentProfiles, 'linear-app', 'client-id', 'invented-client-id-0001');
  writeAppFile(agentProfiles, 'linear-app', 'client-secret', 'invented-client-secret-0001');
  const linear = fake(opts);
  const stdin = { text: 'the body\n' };
  const api = createLinear({ agentProfiles, state, fetchFn: (...a) => linear.fetchFn(...a), raise: () => {} });
  const run = createCli({ api, state, readStdin: async () => stdin.text });
  return { run, linear, state, stdin };
}

const inputOf = (call) => call.variables.input;

test('take sets the app as delegate and the first started status, and names no assignee', async () => {
  const { run, linear } = setup();
  const r = await run(['take', 'FAC-12', '--team', 'factory-otter']);
  assert.equal(r.code, 0);
  const [m] = linear.mutations();
  assert.equal(m.variables.id, 'issue-uuid-1');
  assert.equal(inputOf(m).delegateId, 'app-user-1');
  assert.equal(inputOf(m).stateId, 's-prog', 'Needs Human, also of type started, is not the first started status');
  assert.equal('assigneeId' in inputOf(m), false);
  assert.equal(linear.mutations().length, 1);
});

test('read gives the issue and every comment with its author, across pages', async () => {
  const { run, linear } = setup();
  linear.pages = [
    { nodes: [{ id: 'c1', body: 'one', createdAt: '2026-11-04T01:00:00Z', user: { id: 'owner-1', name: 'Owner' }, botActor: null }] },
    { nodes: [{ id: 'c2', body: 'two', createdAt: '2026-11-04T02:00:00Z', user: null, botActor: { name: 'Factory' } }] },
  ];
  const r = await run(['read', 'FAC-12']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.comments.map((c) => [c.author, c.body, c.createdAt]), [['Owner', 'one', '2026-11-04T01:00:00Z'], ['Factory', 'two', '2026-11-04T02:00:00Z']]);
  assert.equal(r.out.title, 'T');
  assert.equal(r.out.assignee.name, 'Owner');
  assert.equal(linear.mutations().length, 0);
});

test('comment posts one comment from the team, with the body from stdin', async () => {
  const { run, linear } = setup();
  const r = await run(['comment', 'FAC-12', '--team', 'factory-otter', '--body-file', '-']);
  assert.equal(r.code, 0);
  const [m] = linear.mutations();
  assert.equal(inputOf(m).issueId, 'issue-uuid-1');
  assert.equal(inputOf(m).body, 'the body\n');
  assert.equal(inputOf(m).createAsUser, 'factory-otter');
});

test('ask moves to Needs Human, assigns the one owner, and posts one comment', async () => {
  const { run, linear } = setup();
  const r = await run(['ask', 'FAC-12', '--team', 'factory-otter', '--body-file', '-']);
  assert.equal(r.code, 0);
  const ms = linear.mutations();
  assert.equal(ms.length, 2);
  assert.equal(inputOf(ms[0]).stateId, 's-nh');
  assert.equal(inputOf(ms[0]).assigneeId, 'owner-1');
  assert.equal(ms.filter((m) => m.query.includes('commentCreate')).length, 1);
  assert.ok(linear.calls.some((c) => c.query.includes('owner: { eq: true }') && c.query.includes('app: { eq: false }')));
});

for (const owners of [[], ['a', 'b']]) {
  test(`ask refuses when the workspace has ${owners.length} owners who are not apps, and writes nothing`, async () => {
    const { run, linear } = setup({ owners });
    const r = await run(['ask', 'FAC-12', '--team', 'factory-otter', '--body-file', '-']);
    assert.equal(r.code, 1);
    assert.match(r.out.error, new RegExp(`found ${owners.length}`));
    assert.equal(linear.mutations().length, 0);
  });
}

test('answered removes the assignee and moves back to the first started status', async () => {
  const { run, linear } = setup();
  const r = await run(['answered', 'FAC-12', '--team', 'factory-otter']);
  assert.equal(r.code, 0);
  const [m] = linear.mutations();
  assert.equal(inputOf(m).assigneeId, null);
  assert.equal(inputOf(m).stateId, 's-prog');
});

test('create always sends a stateId, sets the delegate only with --delegate, and refuses an unknown status', async () => {
  const { run, linear } = setup();
  let r = await run(['create', '--team-key', 'FAC', '--title', 'A finding', '--status', 'Triage', '--body-file', '-']);
  assert.equal(r.code, 0);
  assert.equal(r.out.key, 'FAC-99');
  let [m] = linear.mutations();
  assert.equal(inputOf(m).stateId, 's-triage');
  assert.equal(inputOf(m).teamId, 'team-fac');
  assert.equal('delegateId' in inputOf(m), false);
  r = await run(['create', '--team-key', 'FAC', '--title', 'Moved', '--status', 'Todo', '--body-file', '-', '--delegate']);
  m = linear.mutations()[1];
  assert.equal(inputOf(m).stateId, 's-todo');
  assert.equal(inputOf(m).delegateId, 'app-user-1');
  const before = linear.mutations().length;
  r = await run(['create', '--team-key', 'FAC', '--title', 'X', '--status', 'Nowhere', '--body-file', '-']);
  assert.equal(r.code, 1);
  assert.equal(linear.mutations().length, before);
});

test('onboard with an existing team creates nothing, registers it, and a second run changes nothing', async () => {
  const { run, linear, state } = setup();
  linear.teams.ZAL = { id: 'team-zal', key: 'ZAL', name: 'zalo-gateway', states: { nodes: [st('z1', 'Needs Human', 'started', 1)] } };
  const r = await run(['onboard', 'zalo-gateway', '--key', 'ZAL', '--name', 'zalo-gateway']);
  assert.equal(r.code, 0);
  assert.equal(linear.mutations().length, 0);
  assert.deepEqual(onLinear('zalo-gateway', state), { key: 'ZAL', teamId: 'team-zal' });
  const file = readFileSync(registryFile(state), 'utf8');
  const again = await run(['onboard', 'zalo-gateway', '--key', 'ZAL', '--name', 'zalo-gateway']);
  assert.equal(again.code, 0);
  assert.equal(again.out.registered, false);
  assert.equal(linear.mutations().length, 0);
  assert.equal(readFileSync(registryFile(state), 'utf8'), file);
});

test('onboard of a new team copies FAC\'s settings and adds Needs Human only when the copy lacks it', async () => {
  for (const copyBringsNeedsHuman of [false, true]) {
    const { run, linear, state } = setup({ copyBringsNeedsHuman });
    const r = await run(['onboard', 'probe', '--key', 'PRB', '--name', 'probe']);
    assert.equal(r.code, 0);
    const create = linear.mutations().find((m) => m.query.includes('teamCreate'));
    assert.equal(create.variables.from, 'team-fac');
    assert.match(create.query, /teamCreate\(copySettingsFromTeamId: \$from, input: \$input\)/);
    assert.deepEqual(inputOf(create), { key: 'PRB', name: 'probe' });
    const states = linear.mutations().filter((m) => m.query.includes('workflowStateCreate'));
    assert.equal(states.length, copyBringsNeedsHuman ? 0 : 1);
    if (!copyBringsNeedsHuman) assert.deepEqual([inputOf(states[0]).name, inputOf(states[0]).type, inputOf(states[0]).teamId], ['Needs Human', 'started', 'team-PRB']);
    assert.match(r.out.next, /one click/);
    assert.deepEqual(onLinear('probe', state), { key: 'PRB', teamId: 'team-PRB' });
    const n = linear.mutations().length;
    const again = await run(['onboard', 'probe', '--key', 'PRB', '--name', 'probe']);
    assert.equal(again.code, 0);
    assert.equal(linear.mutations().length, n, 'a second run writes nothing to Linear');
    assert.equal(again.out.next, undefined);
  }
});

test('onboard prints the by-hand instruction and exits 1 when Linear refuses the team, and registers nothing', async () => {
  const { run, state } = setup({ teamCreateFails: true });
  const r = await run(['onboard', 'probe', '--key', 'PRB', '--name', 'probe']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /By hand/);
  assert.equal(onLinear('probe', state), null);
});

test('a repository not in the registry is on GitHub; a bad registry file is none', () => {
  const root = mkdtempSync(join(tmpdir(), 'linear-cli-'));
  assert.equal(onLinear('anything', root), null);
  mkdirSync(join(root, 'linear'));
  writeFileSync(registryFile(root), '{not json');
  assert.equal(onLinear('anything', root), null);
  writeFileSync(registryFile(root), JSON.stringify({ a: { key: 'AAA', teamId: 't' } }));
  assert.equal(onLinear('a', root).key, 'AAA');
  assert.equal(onLinear('constructor', root), null);
});

test('usage errors exit 2 before any call; a body comes on stdin only', async () => {
  const { run, linear } = setup();
  for (const argv of [[], ['nope'], ['take', 'FAC-12'], ['take', 'bad key', '--team', 'x'], ['comment', 'FAC-12', '--team', 'x', '--body-file', '/etc/passwd'], ['take', 'FAC-12', '--team', 'x', '--team', 'y'], ['read', 'FAC-12', '--extra']]) {
    assert.equal((await run(argv)).code, 2, argv.join(' '));
  }
  assert.throws(() => parse(['onboard', 'r', '--key', 'lower', '--name', 'n']));
  assert.equal(linear.calls.length, 0);
});

test('an empty body is a usage error and nothing is written', async () => {
  const { run, linear, stdin } = setup();
  stdin.text = '  \n';
  assert.equal((await run(['comment', 'FAC-12', '--team', 'x', '--body-file', '-'])).code, 2);
  assert.equal(linear.mutations().length, 0);
});

test('no token appears in a result or an error', async () => {
  const { run, linear } = setup({ failIssueUpdate: true });
  const results = [await run(['take', 'FAC-12', '--team', 'x']), await run(['answered', 'FAC-12', '--team', 'x'])];
  assert.ok(results.every((r) => r.code === 1));
  for (const r of results) assert.equal(JSON.stringify(r).includes(TOKEN), false);
  assert.ok(linear.calls.length > 0);
});
