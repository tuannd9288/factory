// bin/lib/move.mjs (#406): the move of a repository's open GitHub issues to its Linear team. No network: `gh` is a fake runner and createLinear's
// `fetchFn` a fake Linear, so each test sees the calls the tool really makes. Every login, id and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinear } from '../bin/lib/linear.mjs';
import { registryFile } from '../bin/lib/linear-repos.mjs';
import { createMove, main, mapFile, parse } from '../bin/lib/move.mjs';
import { writeAppFile } from '../bin/lib/token.mjs';

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const st = (id, name, type, position) => ({ id, name, type, position });
const TOKEN = 'lin_move_token_0001';
const SECRET = 'invented-move-secret-0001';
const REPO = 'ownr/proj';
const BOARD = { owner: 'ownr', number: 7 };
const TRICKY = 'He said "hi" and `ls`\nsecond line: déjà vu ✓ — 日本語';

const item = (status, number = 7) => ({ project: { number, owner: { login: 'ownr' } }, fieldValueByName: status === null ? null : { name: status } });
const gi = (number, over = {}) => ({
  number, title: `Issue ${number}`, body: `body ${number}`, createdAt: `2026-10-0${number}T10:00:00Z`, url: `https://github.com/${REPO}/issues/${number}`, author: { login: 'octo-zed' },
  labels: { nodes: [] }, parent: null, projectItems: { nodes: [item('Triage')] }, ...over,
});

function defaultIssues() {
  return [
    gi(1, { body: '**Sublayer:** 1a\nthe first', labels: { nodes: [{ name: 'task' }, { name: 'sublayer-1c' }] }, projectItems: { nodes: [item('Todo', 8), item('Triage')] } }),
    gi(2, { labels: { nodes: [{ name: 'sublayer-1b' }] }, projectItems: { nodes: [] } }),
    gi(3, { projectItems: { nodes: [item('Todo')] } }),
    gi(4, { parent: { number: 1 }, projectItems: { nodes: [item('In Progress')] } }),
    gi(5, { parent: { number: 99 } }),
  ];
}
const defaultComments = () => ({
  1: [{ author: { login: 'octo-ann' }, createdAt: '2026-10-02T09:00:00Z', body: TRICKY }, { author: { login: 'octo-bob' }, createdAt: '2026-10-03T09:00:00Z', body: 'second' }],
  4: [{ author: { login: 'octo-ann' }, createdAt: '2026-10-05T09:00:00Z', body: 'only one' }],
});

/** A world: GitHub (the issues, their comments), Linear (team FAC), and `writes`, every successful write of either, in order. `failAt` is the
 * index of a write that fails once. */
function world({ issues = defaultIssues(), comments = defaultComments(), pageSize = 2, registry = { proj: 1 } } = {}) {
  const w = { issues, comments, writes: [], attempts: 0, failAt: null, created: [], lcomments: {}, updates: [], faultMessage: null };
  w.fail = () => {
    const n = w.attempts++;
    if (w.failAt === n) {
      w.failAt = null;
      return true;
    }
    return false;
  };
  w.gh = (args) => {
    const flag = (k) => args.find((a, i) => args[i - 1] && ['-f', '-F'].includes(args[i - 1]) && a.startsWith(`${k}=`))?.slice(k.length + 1);
    if (args[1] === 'graphql') {
      const query = flag('query');
      if (query.includes('projectItems')) {
        const at = flag('after') ? Number(flag('after')) : 0;
        const open = w.issues.filter((i) => !i.closed);
        const nodes = open.slice(at, at + pageSize);
        return JSON.stringify({ data: { repository: { issues: { nodes, pageInfo: { hasNextPage: at + pageSize < open.length, endCursor: String(at + pageSize) } } } } });
      }
      const n = Number(flag('n'));
      const all = w.comments[n] ?? [];
      const at = flag('after') ? Number(flag('after')) : 0;
      return JSON.stringify({ data: { repository: { issue: { comments: { nodes: all.slice(at, at + 1), pageInfo: { hasNextPage: at + 1 < all.length, endCursor: String(at + 1) } } } } } });
    }
    const n = Number(/issues\/(\d+)/.exec(args.join(' '))[1]);
    if (w.fail()) throw Object.assign(new Error('Command failed'), { stderr: 'gh: refused (HTTP 502)' });
    if (args.includes('PATCH')) {
      assert.equal(flag('state'), 'closed');
      assert.equal(flag('state_reason'), 'not_planned');
      w.issues.find((i) => i.number === n).closed = true;
      w.writes.push(`gh:close:${n}`);
    } else {
      assert.ok(args.includes('POST'));
      (w.comments[n] ??= []).push({ author: { login: 'factory-agent' }, createdAt: '2026-11-05T00:00:00Z', body: flag('body') });
      w.writes.push(`gh:comment:${n}:${flag('body')}`);
    }
    return '{}';
  };
  w.fetchFn = async (url, init) => {
    if (url.endsWith('/oauth/token')) return json(200, { access_token: TOKEN, expires_in: 2_592_000, scope: 'read' });
    const body = JSON.parse(init.body);
    const q = body.query;
    const v = body.variables ?? {};
    if (q.includes('viewer')) return json(200, { data: { viewer: { id: 'app-user-1' } } });
    if (q.includes('teams(')) return json(200, { data: { teams: { nodes: [{ id: 'team-fac', key: 'FAC', name: 'Factory', states: { nodes: [st('s-triage', 'Triage', 'triage', 0), st('s-todo', 'Todo', 'unstarted', 1), st('s-prog', 'In Progress', 'started', 2), st('s-done', 'Done', 'completed', 3)] } }] } } });
    const mutation = q.includes('mutation');
    if (mutation && w.fail()) return json(200, { errors: [{ message: w.faultMessage ?? 'Linear refused the write' }] });
    if (q.includes('issueCreate')) {
      const key = `FAC-${w.created.length + 1}`;
      const rec = { id: `uuid-${w.created.length + 1}`, identifier: key, url: `https://linear.app/x/issue/${key}`, input: v.input };
      w.created.push(rec);
      w.lcomments[rec.id] = [];
      w.writes.push(`linear:create:${key}`);
      return json(200, { data: { issueCreate: { success: true, issue: { id: rec.id, identifier: key, url: rec.url } } } });
    }
    if (q.includes('commentCreate')) {
      w.lcomments[v.input.issueId].push({ body: v.input.body, createdAt: v.input.createdAt ?? '2026-11-05T00:00:00Z', input: v.input });
      w.writes.push(`linear:comment:${v.input.issueId}:${v.input.body}`);
      return json(200, { data: { commentCreate: { success: true, comment: { id: 'c' } } } });
    }
    if (q.includes('issueUpdate')) {
      w.updates.push({ id: v.id, input: v.input });
      w.writes.push(`linear:update:${v.id}`);
      return json(200, { data: { issueUpdate: { success: true } } });
    }
    if (q.includes('issues(')) {
      const needle = v.filter.description.contains;
      return json(200, { data: { issues: { nodes: w.created.filter((c) => c.input.description.includes(needle)).map((c) => ({ id: c.id, identifier: c.identifier, url: c.url, description: c.input.description })) } } });
    }
    if (q.includes('comments(')) {
      const rec = w.created.find((c) => c.identifier === v.id);
      return json(200, { data: { issue: { comments: { nodes: w.lcomments[rec.id], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return json(200, { data: {} });
  };
  const root = mkdtempSync(join(tmpdir(), 'move-'));
  w.state = join(root, 'state');
  mkdirSync(join(w.state, 'linear'), { recursive: true });
  if (registry) writeFileSync(registryFile(w.state), JSON.stringify({ [REPO]: { key: 'FAC', teamId: 'team-fac' } }));
  const agentProfiles = join(root, 'profiles');
  writeAppFile(agentProfiles, 'linear-app', 'client-id', 'invented-client-id-0001');
  writeAppFile(agentProfiles, 'linear-app', 'client-secret', SECRET);
  w.api = createLinear({ agentProfiles, state: w.state, fetchFn: (...a) => w.fetchFn(...a), raise: () => {} });
  w.run = (over = {}, log) => createMove({ gh: w.gh, api: w.api, state: w.state }).run({ repo: REPO, teamKey: 'FAC', board: BOARD, apply: true, limit: Infinity, ...over }, log);
  w.map = () => JSON.parse(readFileSync(mapFile(w.state, REPO), 'utf8'));
  return w;
}

const byNumber = (w, n) => w.created.find((c) => c.input.description.startsWith(`Moved from https://github.com/${REPO}/issues/${n}\n`));

test('the dry run writes nothing, on either side, and prints one plan line for each issue', async () => {
  const w = world();
  const r = await w.run({ apply: false });
  assert.deepEqual(w.writes, []);
  assert.equal(w.created.length, 0);
  assert.equal(existsSync(mapFile(w.state, REPO)), false);
  assert.equal(r.lines.length, 5);
  assert.equal(r.lines[0], '#1 | Issue 1 | Triage | holder none | parent none | 2 comments');
  assert.equal(r.lines[3], '#4 | Issue 4 | In Progress | holder lead | parent #1 (moves) | 1 comments');
  assert.equal(r.lines[4], '#5 | Issue 5 | Triage | holder none | parent #99 (stays on GitHub) | 0 comments');
});

test('the status map: Triage, no item, Todo and In Progress, the last held by the app as delegate with the holder comment', async () => {
  const w = world();
  await w.run();
  const stateOf = (n) => byNumber(w, n).input.stateId;
  assert.equal(stateOf(1), 's-triage', 'the board is the one given; another project\'s item is no status');
  assert.equal(stateOf(2), 's-triage', 'no item is Triage');
  assert.equal(stateOf(3), 's-todo');
  assert.equal(stateOf(4), 's-prog');
  for (const n of [1, 2, 3, 5]) assert.equal('delegateId' in byNumber(w, n).input, false);
  assert.equal(byNumber(w, 4).input.delegateId, 'app-user-1');
  const held = w.lcomments[byNumber(w, 4).id].find((c) => c.body === 'Taken by team lead.');
  assert.ok(held, 'the holder comment of #404\'s code');
  assert.equal(held.input.createAsUser, 'lead');
  assert.equal(w.lcomments[byNumber(w, 3).id].length, 0);
});

test('a board status outside the table refuses the whole run before any write, naming the issue', async () => {
  const w = world();
  w.issues[4].projectItems = { nodes: [item('Done')] };
  await assert.rejects(w.run(), /#5.*"Done"/);
  assert.deepEqual(w.writes, []);
  assert.equal(existsSync(mapFile(w.state, REPO)), false);
});

test('a repository that is not in the registry with that team is refused with nothing done', async () => {
  const w = world({ registry: null });
  await assert.rejects(w.run(), /not in the registry/);
  assert.deepEqual(w.writes, []);
});

test('the description opens with Moved from, adds the Sublayer line from the label, and sends no label or assignee, with the GitHub dates', async () => {
  const w = world();
  await w.run();
  const one = byNumber(w, 1).input;
  assert.equal(one.title, 'Issue 1');
  assert.equal(one.description, `Moved from https://github.com/${REPO}/issues/1\n\n**Sublayer:** 1a\nthe first`, 'a body that has the line gets none added, and is verbatim');
  assert.equal(byNumber(w, 2).input.description, `Moved from https://github.com/${REPO}/issues/2\n**Sublayer:** 1b\n\nbody 2`);
  assert.match(byNumber(w, 3).input.description, /^Moved from [^\n]+\n\nbody 3$/);
  for (const c of w.created) {
    assert.equal('labelIds' in c.input, false);
    assert.equal('assigneeId' in c.input, false);
    assert.equal(c.input.teamId, 'team-fac');
  }
  assert.equal(one.createdAt, '2026-10-01T10:00:00Z');
});

test('comments arrive in order, verbatim, dated and shown as the GitHub login', async () => {
  const w = world();
  await w.run();
  const [a, b] = w.lcomments[byNumber(w, 1).id];
  assert.equal(a.input.body, TRICKY);
  assert.equal(a.input.createdAt, '2026-10-02T09:00:00Z');
  assert.equal(a.input.createAsUser, 'octo-ann (via GitHub)');
  assert.equal(b.input.body, 'second');
  assert.equal(b.input.createdAt, '2026-10-03T09:00:00Z');
  assert.equal(b.input.createAsUser, 'octo-bob (via GitHub)');
});

test('a parent that moves is the parentId; a parent that stays is a line in the description', async () => {
  const w = world();
  await w.run();
  assert.equal(byNumber(w, 4).input.parentId, byNumber(w, 1).id);
  assert.doesNotMatch(byNumber(w, 4).input.description, /Parent on GitHub/);
  assert.match(byNumber(w, 5).input.description, /^Moved from [^\n]+\nParent on GitHub: #99\n/);
  assert.equal('parentId' in byNumber(w, 5).input, false);
});

test('a child moved before its parent gets its parentId when the parent is in the map', async () => {
  const w = world();
  w.issues[0].parent = { number: 3 };
  await w.run({ limit: 1 });
  assert.equal(w.updates.length, 0, 'the parent has not moved yet');
  await w.run();
  const one = w.created.find((c) => c.input.description.startsWith(`Moved from https://github.com/${REPO}/issues/1\n`));
  const three = byNumber(w, 3);
  assert.deepEqual(w.updates, [{ id: one.id, input: { parentId: three.id } }]);
  assert.equal(w.map().issues['1'].parent, true);
});

test('GitHub gets its comment, then the close as not planned, and only after the Linear side of that issue is complete', async () => {
  const w = world();
  await w.run();
  for (const n of [1, 4]) {
    const id = byNumber(w, n).id;
    const last = w.writes.map((x, i) => [x, i]).filter(([x]) => x.startsWith('linear:') && x.includes(`:${id}`) || x === `linear:create:${byNumber(w, n).identifier}`).map(([, i]) => i).pop();
    const comment = w.writes.findIndex((x) => x.startsWith(`gh:comment:${n}:`));
    assert.ok(comment > last, `#${n}: the GitHub comment follows every Linear write`);
    assert.equal(w.writes[comment], `gh:comment:${n}:Moved to ${byNumber(w, n).identifier}: ${byNumber(w, n).url}`);
    assert.equal(w.writes.indexOf(`gh:close:${n}`), comment + 1);
  }
  assert.ok(w.issues.every((i) => i.closed));
});

test('a run that fails after each step, then a second run, repeats no write and misses none', async () => {
  const clean = world({ issues: [defaultIssues()[0], defaultIssues()[3]] });
  await clean.run();
  const expected = [...clean.writes].sort();
  for (let k = 0; k < clean.writes.length; k++) {
    const w = world({ issues: [defaultIssues()[0], defaultIssues()[3]] });
    w.failAt = k;
    await assert.rejects(w.run(), undefined, `write ${k} failed`);
    await w.run();
    assert.deepEqual([...w.writes].sort(), expected, `a failure at write ${k}`);
    const again = w.writes.length;
    await w.run();
    assert.equal(w.writes.length, again, 'a third run has nothing to do');
  }
});

test('a lost map file adopts the existing FAC issue, repeating no write on it', async () => {
  const w = world({ issues: [defaultIssues()[0]] });
  const expected = [];
  {
    const c = world({ issues: [defaultIssues()[0]] });
    await c.run();
    expected.push(...c.writes);
  }
  // Fail at the GitHub comment: the Linear side is whole, GitHub is untouched.
  w.failAt = expected.findIndex((x) => x.startsWith('gh:comment'));
  await assert.rejects(w.run());
  rmSync(mapFile(w.state, REPO));
  await w.run();
  assert.equal(w.created.length, 1, 'adopted, not created again');
  assert.deepEqual([...w.writes].sort(), [...expected].sort());
});

test('a lost map file does not adopt an issue whose first line only contains the line', async () => {
  const w = world({ issues: [gi(1)] });
  w.created.push({ id: 'old', identifier: 'FAC-50', url: 'u', input: { description: `Moved from https://github.com/${REPO}/issues/12\n\nx` } });
  w.lcomments.old = [];
  const clash = gi(1, { url: `https://github.com/${REPO}/issues/1` });
  w.issues = [clash];
  await w.run();
  assert.equal(w.created.length, 2);
});

test('a corrupt map file is refused and nothing is written', async () => {
  const w = world();
  mkdirSync(join(w.state, 'linear', 'moved'), { recursive: true });
  writeFileSync(mapFile(w.state, REPO), '{ not json');
  await assert.rejects(w.run(), /does not parse/);
  assert.deepEqual(w.writes, []);
  assert.equal(readFileSync(mapFile(w.state, REPO), 'utf8'), '{ not json');
});

test('--limit moves only the first N issues not moved yet, by number', async () => {
  const w = world();
  await w.run({ limit: 2 });
  assert.deepEqual(w.created.map((c) => c.identifier), ['FAC-1', 'FAC-2']);
  assert.deepEqual(w.issues.filter((i) => i.closed).map((i) => i.number), [1, 2]);
  await w.run({ limit: 1 });
  assert.equal(w.created.length, 3);
  assert.ok(byNumber(w, 3));
});

test('the map records each step in the shape the header names', async () => {
  const w = world();
  await w.run();
  assert.deepEqual(w.map().issues['4'], { key: 'FAC-4', id: 'uuid-4', url: 'https://linear.app/x/issue/FAC-4', parentOf: 1, comments: 1, parent: true, held: true, ghComment: true, closed: true });
  assert.equal(w.map().version, 1);
});

test('no token appears in the output or the error of a failed run', async () => {
  const w = world();
  w.faultMessage = `refused for ${TOKEN} and ${SECRET}`;
  w.failAt = 0;
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let code;
  try {
    code = await main([REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--apply'], { FACTORY_STATE: w.state, HOME: w.state }, { api: w.api, gh: w.gh });
  } finally {
    console.log = real;
  }
  assert.equal(code, 1);
  const out = lines.join('\n');
  assert.doesNotMatch(out, new RegExp(`${TOKEN}|${SECRET}`));
});

test('the command line: one repository, a team key and a board; a bad flag is a usage error', () => {
  assert.deepEqual(parse([REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--limit', '3']), { repo: REPO, teamKey: 'FAC', board: { owner: 'ownr', number: 7 }, apply: false, limit: 3 });
  assert.equal(parse([REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--apply']).apply, true);
  for (const bad of [[], [REPO], [REPO, '--team-key', 'fac', '--board', 'ownr/7'], [REPO, '--team-key', 'FAC', '--board', 'ownr'], [REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--limit', '0'], [REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--force']]) {
    assert.throws(() => parse(bad));
  }
});
