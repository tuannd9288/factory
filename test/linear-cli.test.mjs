// bin/lib/linear-cli.mjs (#404): `factory linear <verb>`. No network: createLinear's `fetchFn` is a fake Linear, so each test sees the
// mutation and the fields the verb really sends. Every id and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinear } from '../bin/lib/linear.mjs';
import { createCli, holderOf, onLinear, parse, registryFile } from '../bin/lib/linear-cli.mjs';
import { writeAppFile } from '../bin/lib/token.mjs';

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const st = (id, name, type, position) => ({ id, name, type, position });
const TOKEN = 'lin_cli_token_0001';
const SECRET = 'invented-client-secret-0001';

/** A fake Linear with one team FAC; `teams` is the workspace's teams by key. */
function fake({ owners = ['owner-1'], copyBringsNeedsHuman = false, teamCreateFails = false, failIssueUpdate = false } = {}) {
  const f = { calls: [], appId: 'app-user-1', stored: [], teams: {}, pages: null, failComment: false, onComment: null };
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
    if (q.includes('issueUpdate')) {
      if (failIssueUpdate) return json(200, { errors: [{ message: `refused for ${TOKEN} and ${SECRET}` }] });
      if ('delegateId' in v.input) f.issue.delegate = v.input.delegateId ? { id: v.input.delegateId } : null;
      return json(200, { data: { issueUpdate: { success: true, issue: { id: 'issue-uuid-1', identifier: 'FAC-12' } } } });
    }
    if (q.includes('commentCreate')) {
      if (f.failComment) return json(200, { errors: [{ message: 'comment refused' }] });
      f.stored.push({ body: v.input.body, createdAt: `2026-11-05T00:00:${String(f.stored.length).padStart(2, '0')}Z` }); // after any comment a test seeds with at()
      f.onComment?.(v.input.body);
      return json(200, { data: { commentCreate: { success: true, comment: { id: `c-${f.stored.length}` } } } });
    }
    if (q.includes('issueCreate')) return json(200, { data: { issueCreate: { success: true, issue: { id: 'new-1', identifier: 'FAC-99' } } } });
    if (q.includes('issues(')) {
      const pages = f.listPages ?? [[]];
      const at = v.after ? Number(v.after) : 0;
      return json(200, { data: { issues: { nodes: pages[at], pageInfo: { hasNextPage: at + 1 < pages.length, endCursor: String(at + 1) } } } });
    }
    if (q.includes('comments(')) {
      const page = f.pages ?? [{ nodes: f.stored }];
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
  writeAppFile(agentProfiles, 'linear-app', 'client-secret', SECRET);
  // The factory repository is on Linear, as the registry says.
  mkdirSync(join(state, 'linear'), { recursive: true });
  writeFileSync(registryFile(state), JSON.stringify({ factory: { key: 'FAC', teamId: 'team-fac' } }));
  const linear = fake(opts);
  const stdin = { text: 'the body\n' };
  const api = createLinear({ agentProfiles, state, fetchFn: (...a) => linear.fetchFn(...a), raise: () => {} });
  const run = createCli({ api, state, readStdin: async () => stdin.text });
  return { run, linear, state, stdin };
}

const inputOf = (call) => call.variables.input;

test('take sets the app as delegate and the first started status, and names no assignee', async () => {
  const { run, linear } = setup();
  const r = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 0);
  const [m] = linear.mutations();
  assert.equal(m.variables.id, 'issue-uuid-1');
  assert.equal(inputOf(m).delegateId, 'app-user-1');
  assert.equal(inputOf(m).stateId, 's-prog', 'Needs Human, also of type started, is not the first started status');
  assert.equal(inputOf(m).assigneeId, null, 'no person stays assigned');
  const ms = linear.mutations();
  assert.equal(ms.length, 2);
  assert.equal(inputOf(ms[1]).issueId, 'issue-uuid-1');
  assert.match(inputOf(ms[1]).body, /lead/);
  assert.equal(inputOf(ms[1]).createAsUser, 'lead');
});

const at = (n) => `2026-11-04T00:${String(n).padStart(2, '0')}:00Z`;
const note = (body, n) => ({ body, createdAt: at(n) });

test('the holder is the earliest "Taken by team" comment after the last release', () => {
  assert.equal(holderOf([]), null);
  assert.equal(holderOf([note('just a comment', 1)]), null);
  assert.equal(holderOf([note('Taken by team a.', 1)]), 'a');
  assert.equal(holderOf([note('Taken by team b.', 2), note('Taken by team a.', 1)]), 'a', 'by time, in any order');
  assert.equal(holderOf([note('Taken by team a.', 1), note('Taken by team b.', 2)]), 'a', 'the earliest keeps it');
  assert.equal(holderOf([note('Taken by team a.', 1), note('Released by team a.', 2)]), null);
  assert.equal(holderOf([note('Taken by team a.', 1), note('Taken by team b.', 2), note('Released by team a.', 3), note('Taken by team b.', 4)]), 'b', 'only the comments after the last release count');
  assert.equal(holderOf([note('Taken by team a.', 1), note('Released by team a (the delegate was cleared by hand).', 2)]), null);
  assert.equal(holderOf([note('Taken by team a. And more', 1), note('I Taken by team b.', 2)]), null, 'only the exact line counts');
});

test('take is refused when the app holds the issue for another team, and writes nothing', async () => {
  const { run, linear } = setup();
  linear.issue.delegate = { id: 'app-user-1' };
  linear.stored.push(note('Taken by team other.', 1));
  const r = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /held by team other/);
  assert.equal(linear.mutations().length, 0);
});

test('a retake by the holder\'s own team is allowed and posts no second holder comment', async () => {
  const { run, linear } = setup();
  assert.equal((await run(['take', 'FAC-12', '--team', 'lead'])).code, 0);
  assert.equal(linear.stored.length, 1);
  const again = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(again.code, 0);
  assert.equal(linear.stored.length, 1, 'one holder comment');
  assert.equal((await run(['take', 'FAC-12', '--team', 'other'])).code, 1, 'another team is still refused');
});

test('a retake after a failed holder comment is allowed, and the comment is posted then', async () => {
  const { run, linear } = setup();
  linear.failComment = true;
  assert.equal((await run(['take', 'FAC-12', '--team', 'lead'])).code, 1, 'the comment failed');
  assert.equal(linear.issue.delegate.id, 'app-user-1', 'the delegate is set');
  assert.equal(linear.stored.length, 0);
  linear.failComment = false;
  const r = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(linear.stored.map((c) => c.body), ['Taken by team lead.']);
});

test('take refuses and changes nothing more when another team\'s take came first, read after its own comment', async () => {
  const { run, linear } = setup();
  linear.onComment = () => linear.stored.push({ body: 'Taken by team other.', createdAt: '2026-11-04T23:00:00Z' }); // before the take's own comment
  const r = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /held by team other, whose take came first/);
  assert.equal(linear.mutations().length, 2, 'the update and its own comment; nothing after the read');
});

test('a read-back that shows no holder yet is success, never "held by team null"', async () => {
  const { run, linear } = setup();
  linear.onComment = () => linear.stored.pop(); // its own comment is not visible yet
  const r = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(r.out.error, undefined);
  assert.equal(linear.stored.length, 0);
});

test('a take of an issue another team holds is refused and writes nothing, also when its delegate was cleared by hand; the holder may retake it', async () => {
  const { run, linear } = setup();
  linear.stored.push(note('Taken by team old.', 1)); // the delegate is empty
  const r = await run(['take', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /held by team old, though its delegate is not set; that team releases it with factory linear release/);
  assert.equal(linear.mutations().length, 0);
  assert.equal(linear.stored.length, 1);
  assert.equal((await run(['take', 'FAC-12', '--team', 'old'])).code, 0, 'the holder\'s own team takes it again');
  assert.equal(holderOf(linear.stored), 'old');
  assert.equal(linear.stored.length, 1, 'with no second holder comment');
});

test('create --delegate needs --team and posts the holder comment a take posts; without --delegate it posts none', async () => {
  const { run, linear } = setup();
  const make = (more) => run(['create', '--team-key', 'FAC', '--title', 'T', '--status', 'Todo', '--body-file', '-', ...more]);
  const bad = await make(['--delegate']);
  assert.equal(bad.code, 2);
  assert.equal(linear.calls.length, 0);
  assert.equal((await make([])).code, 0);
  assert.equal(linear.stored.length, 0, 'no holder comment without --delegate');
  const r = await make(['--delegate', '--team', 'lead']);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.deepEqual(linear.stored.map((c) => c.body), ['Taken by team lead.']);
  const posted = linear.mutations().find((m) => m.query.includes('commentCreate'));
  assert.equal(inputOf(posted).createAsUser, 'lead');
  assert.equal(holderOf(linear.stored), 'lead');
});

test('comment and ask refuse a body with a line that reads as a holder or a release comment, and write nothing', async () => {
  const { run, linear, stdin } = setup();
  for (const body of ['Taken by team lead.\n', 'fine\nTaken by team other.\nmore', 'Released by team lead.', 'x\nReleased by team lead (cleared).\n']) {
    stdin.text = body;
    for (const verb of ['comment', 'ask']) {
      const r = await run([verb, 'FAC-12', '--team', 'lead', '--body-file', '-']);
      assert.equal(r.code, 1, `${verb}: ${JSON.stringify(body)}`);
      assert.match(r.out.error, /reads as a holder comment/);
    }
  }
  assert.equal(linear.calls.length, 0, 'nothing was asked of Linear, let alone written');
  stdin.text = 'Taken by team lead. is not a holder line\nTaken by the team\n';
  assert.equal((await run(['comment', 'FAC-12', '--team', 'lead', '--body-file', '-'])).code, 0, 'a line that only starts like one is fine');
});

test('release by the holder clears the delegate, moves to the first unstarted status and comments; then another team can take', async () => {
  const { run, linear } = setup();
  assert.equal((await run(['take', 'FAC-12', '--team', 'lead'])).code, 0);
  const before = linear.mutations().length;
  const r = await run(['release', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 0, JSON.stringify(r));
  const ms = linear.mutations().slice(before);
  assert.equal(ms.length, 2);
  assert.equal(inputOf(ms[0]).delegateId, null);
  assert.equal(inputOf(ms[0]).stateId, 's-todo');
  assert.equal(inputOf(ms[1]).body, 'Released by team lead.');
  assert.equal(linear.issue.delegate, null);
  assert.equal(holderOf(linear.stored), null);
  assert.equal((await run(['take', 'FAC-12', '--team', 'other'])).code, 0, 'a later take counts only the comments after the release');
  assert.equal(holderOf(linear.stored), 'other');
});

test('release is refused for a team that is not the holder, and for an issue nobody holds, and writes nothing', async () => {
  const { run, linear } = setup();
  const none = await run(['release', 'FAC-12', '--team', 'lead']);
  assert.equal(none.code, 1);
  assert.match(none.out.error, /held by no team/);
  assert.equal((await run(['take', 'FAC-12', '--team', 'lead'])).code, 0);
  const before = linear.mutations().length;
  const r = await run(['release', 'FAC-12', '--team', 'other']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /held by team lead, not other/);
  assert.equal(linear.mutations().length, before);
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

test('list filters by the team key and the open status types, follows every page, and writes nothing', async () => {
  const { run, linear } = setup();
  const node = (n, extra = {}) => ({ identifier: `FAC-${n}`, title: `T${n}`, updatedAt: '2026-11-04T01:00:00Z', state: { name: 'Todo', type: 'unstarted' }, delegate: null, assignee: null, ...extra });
  linear.listPages = [[node(1), node(2, { delegate: { name: 'Factory' } })], [node(3, { assignee: { name: 'Owner' }, state: { name: 'Triage', type: 'triage' } })]];
  const r = await run(['list', '--team-key', 'FAC']);
  assert.equal(r.code, 0);
  const sent = linear.calls.filter((c) => c.query.includes('issues('));
  assert.equal(sent.length, 2, 'both pages');
  assert.deepEqual(sent[0].variables.filter, { team: { key: { eq: 'FAC' } }, state: { type: { in: ['triage', 'backlog', 'unstarted', 'started'] } } });
  assert.equal(sent[1].variables.after, '1');
  assert.deepEqual(r.out.issues.map((i) => i.key), ['FAC-1', 'FAC-2', 'FAC-3']);
  assert.deepEqual(r.out.issues[1], { key: 'FAC-2', title: 'T2', status: 'Todo', statusType: 'unstarted', delegate: 'Factory', assignee: null, updatedAt: '2026-11-04T01:00:00Z' });
  assert.equal(r.out.issues[2].assignee, 'Owner');
  assert.equal(linear.mutations().length, 0);
  assert.equal(linear.calls.some((c) => JSON.stringify(c).includes('createAsUser')), false);
});

test('list --status narrows the types, and refuses a type that is not open', async () => {
  const { run, linear } = setup();
  const r = await run(['list', '--team-key', 'FAC', '--status', 'unstarted', '--status', 'triage']);
  assert.equal(r.code, 0);
  assert.deepEqual(linear.calls.find((c) => c.query.includes('issues(')).variables.filter.state, { type: { in: ['unstarted', 'triage'] } });
  assert.equal((await run(['list', '--team-key', 'FAC', '--status', 'completed'])).code, 2);
  assert.equal((await run(['list'])).code, 2);
});

test('comment posts one comment from the team, with the body from stdin', async () => {
  const { run, linear } = setup();
  const r = await run(['comment', 'FAC-12', '--team', 'lead', '--body-file', '-']);
  assert.equal(r.code, 0);
  const [m] = linear.mutations();
  assert.equal(inputOf(m).issueId, 'issue-uuid-1');
  assert.equal(inputOf(m).body, 'the body\n');
  assert.equal(inputOf(m).createAsUser, 'lead');
});

test('ask moves to Needs Human, assigns the one owner, and posts one comment', async () => {
  const { run, linear } = setup();
  const r = await run(['ask', 'FAC-12', '--team', 'lead', '--body-file', '-']);
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
    const r = await run(['ask', 'FAC-12', '--team', 'lead', '--body-file', '-']);
    assert.equal(r.code, 1);
    assert.match(r.out.error, new RegExp(`found ${owners.length}`));
    assert.equal(linear.mutations().length, 0);
  });
}

test('answered is one issueUpdate, the assignee removed and a started status, and no comment (his Inbox gets no receipt)', async () => {
  const { run, linear } = setup();
  const r = await run(['answered', 'FAC-12', '--team', 'lead']);
  assert.equal(r.code, 0);
  const ms = linear.mutations();
  assert.equal(ms.length, 1, 'one write');
  assert.ok(ms[0].query.includes('issueUpdate'));
  assert.equal(inputOf(ms[0]).assigneeId, null);
  assert.equal(inputOf(ms[0]).stateId, 's-prog');
  assert.equal(linear.calls.some((c) => c.query.includes('commentCreate')), false);
  assert.equal(linear.stored.length, 0);
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
  r = await run(['create', '--team-key', 'FAC', '--title', 'Moved', '--status', 'Todo', '--body-file', '-', '--delegate', '--team', 'lead']);
  assert.equal(r.code, 0, JSON.stringify(r));
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

test('onboard onto an existing team that has no Needs Human status is refused, and changes nothing', async () => {
  const { run, linear, state } = setup();
  linear.teams.INN = { id: 'team-inn', key: 'INN', name: 'InnoStack', states: { nodes: [st('i1', 'In Progress', 'started', 1)] } };
  const before = readFileSync(registryFile(state), 'utf8');
  const r = await run(['onboard', 'decisions', '--key', 'INN', '--name', 'InnoStack']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /exists but has no status named Needs Human of type started/);
  assert.equal(linear.mutations().length, 0);
  assert.equal(readFileSync(registryFile(state), 'utf8'), before);
  assert.equal(onLinear('decisions', state), null);
});

test('onboard prints the by-hand instruction and exits 1 when Linear refuses the team, and registers nothing', async () => {
  const { run, state } = setup({ teamCreateFails: true });
  const r = await run(['onboard', 'probe', '--key', 'PRB', '--name', 'probe']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /By hand/);
  assert.equal(onLinear('probe', state), null);
});

test('a repository not in the registry is on GitHub; a registry file that does not parse is refused, never read as empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'linear-cli-'));
  assert.equal(onLinear('anything', root), null);
  mkdirSync(join(root, 'linear'));
  for (const bad of ['{not json', '[]', 'null', '"x"']) {
    writeFileSync(registryFile(root), bad);
    assert.throws(() => onLinear('anything', root), (e) => e.message.includes(registryFile(root)), bad);
  }
  writeFileSync(registryFile(root), JSON.stringify({ a: { key: 'AAA', teamId: 't' } }));
  assert.equal(onLinear('a', root).key, 'AAA');
  assert.equal(onLinear('constructor', root), null);
  writeFileSync(registryFile(root), JSON.stringify({ a: { key: "A$'B", teamId: 't' }, b: { key: 'bad', teamId: 't' } }));
  assert.equal(onLinear('a', root), null, 'a key outside the team-key grammar is no entry');
  assert.equal(onLinear('b', root), null);
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
  for (const r of results) {
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
    assert.equal(JSON.stringify(r).includes(SECRET), false, 'nor the client secret');
  }
  assert.ok(linear.calls.length > 0);
  assert.ok(linear.calls.every((c) => !JSON.stringify(c).includes(SECRET)), 'the secret is never sent to the GraphQL endpoint');
});

test('a write or a list on a team that is not a repository\'s is refused, and nothing is written; read still works', async () => {
  const { run, linear } = setup();
  linear.teams.INN = { id: 'team-inn', key: 'INN', name: 'InnoStack', states: { nodes: [st('i1', 'In Progress', 'started', 1), st('i2', 'Needs Human', 'started', 2)] } };
  linear.issue = { id: 'inn-uuid', identifier: 'INN-22', delegate: null, team: linear.teams.INN };
  for (const argv of [['take', 'INN-22', '--team', 'lead'], ['answered', 'INN-22', '--team', 'lead'], ['comment', 'INN-22', '--team', 'lead', '--body-file', '-'], ['ask', 'INN-22', '--team', 'lead', '--body-file', '-'],
    ['create', '--team-key', 'INN', '--title', 'x', '--status', 'Triage', '--body-file', '-'], ['list', '--team-key', 'INN']]) {
    const r = await run(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.out.error, /not the team of a repository on Linear/);
  }
  assert.equal(linear.mutations().length, 0);
  assert.equal(linear.calls.some((c) => c.query.includes('issues(')), false, 'a refused list asks Linear for nothing');
  assert.equal((await run(['read', 'INN-22'])).code, 0);
});

test('--team is a team name of the factory\'s grammar', async () => {
  const { run, linear } = setup();
  for (const team of ['factory-otter', 'Lead', '1lead', 'a'.repeat(33), 'a b']) assert.equal((await run(['take', 'FAC-12', '--team', team])).code, 2, team);
  assert.equal(linear.calls.length, 0);
});

test('onboard refuses a key that is already another repository\'s team, before it creates anything', async () => {
  const { run, linear, state } = setup();
  const r = await run(['onboard', 'other', '--key', 'FAC', '--name', 'other']);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /already the team of factory/);
  assert.equal(linear.calls.length, 0);
  assert.equal(onLinear('other', state), null);
});

test('a registry that does not parse stops onboard and every scoped verb, and is left as it was', async () => {
  const { run, linear, state } = setup();
  writeFileSync(registryFile(state), '{broken');
  for (const argv of [['onboard', 'probe', '--key', 'PRB', '--name', 'probe'], ['take', 'FAC-12', '--team', 'lead'], ['list', '--team-key', 'FAC']]) {
    const r = await run(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.out.error, /does not parse/);
  }
  assert.equal(linear.mutations().length, 0, 'nothing was created in Linear');
  assert.equal(readFileSync(registryFile(state), 'utf8'), '{broken');
});

test('two onboards at once both reach the registry, and the lock is gone after', async () => {
  const { run, linear, state } = setup();
  linear.teams.AAA = { id: 'team-AAA', key: 'AAA', name: 'a', states: { nodes: [st('a1', 'Needs Human', 'started', 1)] } };
  linear.teams.BBB = { id: 'team-BBB', key: 'BBB', name: 'b', states: { nodes: [st('b1', 'Needs Human', 'started', 1)] } };
  const [a, b] = await Promise.all([run(['onboard', 'repoa', '--key', 'AAA', '--name', 'a']), run(['onboard', 'repob', '--key', 'BBB', '--name', 'b'])]);
  assert.equal(a.code + b.code, 0);
  assert.equal(onLinear('repoa', state).key, 'AAA');
  assert.equal(onLinear('repob', state).key, 'BBB');
  assert.equal(onLinear('factory', state).key, 'FAC');
  assert.equal(existsSync(join(state, 'linear', 'repos.lock')), false);
});
