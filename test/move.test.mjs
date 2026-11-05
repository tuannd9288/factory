// bin/lib/move.mjs (#406): the move of a repository's open GitHub issues to its Linear team. No network: `gh` is a fake runner and createLinear's
// `fetchFn` a fake Linear, so each test sees the calls the tool really makes. Every login, id and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freeWord } from '../bin/lib/team-names.mjs';
import { createLinear } from '../bin/lib/linear.mjs';
import { registryFile } from '../bin/lib/linear-repos.mjs';
import { createMove as makeMove, main, mapFile, parse } from '../bin/lib/move.mjs';
import { writeAppFile } from '../bin/lib/token.mjs';

const createMove = (options) => makeMove({ ...options, home: options.state, runs: join(options.state, 'runs') });

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });
const st = (id, name, type, position) => ({ id, name, type, position });
const TOKEN = 'lin_move_token_0001';
const SECRET = 'invented-move-secret-0001';
const REPO = 'ownr/proj';
const BOARD = { owner: 'ownr', number: 7 };
const REWRITE = '**Sublayer:** 1b\n\n**Goal.**\nMove it.\n\n**Acceptance.**\nDone.\n\n**Limits.**\nNone.\n\n**Prior art.**\nSource.';
const description = (n, body, parent = '') => `${REWRITE}\n\n+++ Agent notes\n\nMoved from https://github.com/${REPO}/issues/${n}${parent}\n\n${body}\n\n+++`;
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
  w.projects = [{ id: 'proj-1', name: 'Release 1', teams: { nodes: [{ id: 'team-fac' }, { id: 'team-other' }] } }];
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
      const now = w.issues.find((i) => i.number === n);
      return JSON.stringify({ data: { repository: { issue: { title: now.title, body: now.body, comments: { nodes: all.slice(at, at + 1), pageInfo: { hasNextPage: at + 1 < all.length, endCursor: String(at + 1) } } } } } });
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
    if (q.includes('projects(')) return json(200, { data: { projects: { nodes: w.projects.filter((p) => p.name === v.name) } } });
    if (q.includes('teams(')) return json(200, { data: { teams: { nodes: [{ id: 'team-fac', key: 'FAC', name: 'Factory', states: { nodes: [st('s-triage', 'Triage', 'triage', 0), st('s-todo', 'Todo', 'unstarted', 1), st('s-prog', 'In Progress', 'started', 2), st('s-done', 'Done', 'completed', 3)] } }] } } });
    const mutation = q.includes('mutation');
    if (mutation && w.fail()) return json(200, { errors: [{ message: w.faultMessage ?? 'Linear refused the write' }] });
    if (q.includes('projectUpdate')) {
      w.projectUpdate = v;
      w.projects.find((p) => p.id === v.id).teams.nodes = v.input.teamIds.map((id) => ({ id }));
      w.writes.push('linear:projectUpdate');
      return json(200, { data: { projectUpdate: { success: true } } });
    }
    if (q.includes('issueCreate')) {
      w.afterRead?.(); // something happens on GitHub after the run's first reads
      w.afterRead = null;
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
      return json(200, { data: { issues: { nodes: w.created.filter((c) => c.input.description.includes(needle)).map((c) => ({ id: c.id, identifier: c.identifier, url: c.url, title: c.input.title, description: c.input.description })) } } });
    }
    if (q.includes('comments(')) {
      const rec = w.created.find((c) => c.identifier === v.id);
      return json(200, { data: { issue: { comments: { nodes: w.lcomments[rec.id], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return json(200, { data: {} });
  };
  const root = mkdtempSync(join(tmpdir(), 'move-'));
  w.rewrites = join(root, 'rewrites');
  mkdirSync(w.rewrites);
  for (const i of issues) writeFileSync(join(w.rewrites, `${i.number}.md`), REWRITE);
  w.state = join(root, 'state');
  mkdirSync(join(w.state, 'linear'), { recursive: true });
  if (registry) writeFileSync(registryFile(w.state), JSON.stringify({ [REPO.split('/')[1]]: { key: 'FAC', teamId: 'team-fac' } }));
  const agentProfiles = join(root, 'profiles');
  writeAppFile(agentProfiles, 'linear-app', 'client-id', 'invented-client-id-0001');
  writeAppFile(agentProfiles, 'linear-app', 'client-secret', SECRET);
  w.api = createLinear({ agentProfiles, state: w.state, fetchFn: (...a) => w.fetchFn(...a), raise: () => {} });
  w.run = (over = {}, log) => createMove({ gh: w.gh, api: w.api, state: w.state }).run({ repo: REPO, teamKey: 'FAC', board: BOARD, apply: true, limit: Infinity, rewrites: w.rewrites, ...over }, log);
  w.map = () => JSON.parse(readFileSync(mapFile(w.state, REPO), 'utf8'));
  return w;
}

const byNumber = (w, n) => w.created.find((c) => c.input.description.includes(`Moved from https://github.com/${REPO}/issues/${n}\n`));

test('the dry run writes nothing, on either side, and prints one plan line for each issue', async () => {
  const w = world();
  const r = await w.run({ apply: false });
  assert.deepEqual(w.writes, []);
  assert.equal(w.created.length, 0);
  assert.equal(existsSync(mapFile(w.state, REPO)), false);
  assert.equal(r.lines.length, 5);
  assert.equal(r.lines[0], '#1 | Issue 1 | Triage | holder none | parent none | 2 comments');
  assert.equal(r.lines[3], `#4 | Issue 4 | In Progress | holder ${freeWord('proj', [])} | parent #1 (moves) | 1 comments`);
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
  const held = w.lcomments[byNumber(w, 4).id].find((c) => c.body === `Taken by team ${freeWord('proj', [])}.`);
  assert.ok(held, 'the holder comment of #404\'s code');
  assert.equal(held.input.createAsUser, `proj-${freeWord('proj', [])}`);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(byNumber(w, n).input.createAsUser, `proj-${freeWord('proj', [])}`, 'a moved issue shows the Lead\'s team, not the Linear team\'s name');
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

test('the rewrite opens the description and Agent notes preserve the original verbatim without label-derived text', async () => {
  const w = world();
  writeFileSync(join(w.rewrites, '1.md'), `${REWRITE}  \n`);
  await w.run();
  const one = byNumber(w, 1).input;
  assert.equal(one.title, 'Issue 1');
  assert.equal(one.description, description(1, '**Sublayer:** 1a\nthe first'));
  assert.equal(byNumber(w, 2).input.description, description(2, 'body 2'));
  assert.equal(byNumber(w, 3).input.description, description(3, 'body 3'));
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
  assert.match(byNumber(w, 5).input.description, /Moved from [^\n]+\nParent on GitHub: #99\n/);
  assert.equal('parentId' in byNumber(w, 5).input, false);
});

test('a child moved before its parent gets its parentId when the parent is in the map', async () => {
  const w = world();
  w.issues[0].parent = { number: 3 };
  await w.run({ limit: 1 });
  assert.equal(w.updates.length, 0, 'the parent has not moved yet');
  await w.run();
  const one = w.created.find((c) => c.input.description.includes(`Moved from https://github.com/${REPO}/issues/1\n`));
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
  const { source, ...four } = w.map().issues['4'];
  assert.deepEqual(four, { key: 'FAC-4', id: 'uuid-4', url: 'https://linear.app/x/issue/FAC-4', parentOf: 1, comments: 1, parent: true, held: true, ghComment: true, closed: true });
  assert.equal(typeof source, 'string');
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
    code = await main([REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--apply', '--rewrites', w.rewrites], { FACTORY_STATE: w.state, HOME: w.state }, { api: w.api, gh: w.gh });
  } finally {
    console.log = real;
  }
  assert.equal(code, 1);
  const out = lines.join('\n');
  assert.doesNotMatch(out, new RegExp(`${TOKEN}|${SECRET}`));
});

test('the command line: one repository, a team key and a board; a bad flag is a usage error', () => {
  assert.deepEqual(parse([REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--limit', '3']), { repo: REPO, teamKey: 'FAC', board: { owner: 'ownr', number: 7 }, apply: false, limit: 3 });
  assert.equal(parse([REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--apply', '--rewrites', '/tmp/rewrites']).apply, true);
  for (const bad of [[], [REPO], [REPO, '--team-key', 'fac', '--board', 'ownr/7'], [REPO, '--team-key', 'FAC', '--board', 'ownr'], [REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--limit', '0'], [REPO, '--team-key', 'FAC', '--board', 'ownr/7', '--force']]) {
    assert.throws(() => parse(bad));
  }
  const base = [REPO, '--team-key', 'FAC', '--board', 'ownr/7'];
  assert.deepEqual(parse([...base, '--project', 'Release 1', '--in-project', '3,5']).inProject, [3, 5]);
  assert.equal(parse([...base, '--project', 'Release 1', '--in-project', '3,5']).project, 'Release 1');
  for (const bad of [['--project', 'Release 1'], ['--in-project', '3'], ['--project', 'Release 1', '--in-project', '3,x'], ['--project', 'Release 1', '--in-project', '0']]) {
    assert.throws(() => parse([...base, ...bad]));
  }
});

const PROJECT = { project: 'Release 1', inProject: [1, 4, 77] };

test('the project is sent only for the numbers given, and the plan line shows it', async () => {
  const w = world();
  const dry = await w.run({ ...PROJECT, apply: false });
  assert.deepEqual(w.writes, []);
  assert.match(dry.lines[0], /\| project Release 1$/);
  assert.match(dry.lines[1], /\| project none$/);
  assert.match(dry.lines[3], /\| project Release 1$/);
  assert.equal(dry.lines[5], '#77 | not an open issue, so no project', 'reported, not an error');
  await w.run(PROJECT);
  for (const n of [1, 4]) assert.equal(byNumber(w, n).input.projectId, 'proj-1');
  for (const n of [2, 3, 5]) assert.equal('projectId' in byNumber(w, n).input, false);
  assert.equal(w.map().issues['1'].project, true);
  assert.equal('project' in w.map().issues['2'], false);
  assert.equal(w.updates.length, 0, 'created with it: nothing to add later');
});

test('without --project no issue gets one, and the plan line has none', async () => {
  const w = world();
  const dry = await w.run({ apply: false });
  assert.doesNotMatch(dry.lines[0], /project/);
  await w.run();
  assert.ok(w.created.every((c) => !('projectId' in c.input)));
});

test('a project that is not found or found twice refuses before any write', async () => {
  const cases = [
    [(w) => { w.projects = []; }, /no project named "Release 1"/],
    [(w) => { w.projects.push({ ...w.projects[0], id: 'proj-2' }); }, /2 projects are named/],
  ];
  for (const [setup, why] of cases) {
    const w = world();
    setup(w);
    await assert.rejects(w.run(PROJECT), why);
    assert.deepEqual(w.writes, []);
    assert.equal(existsSync(mapFile(w.state, REPO)), false);
  }
});

test('a later run adds the project to an issue made without it, closed on GitHub or not, once', async () => {
  const w = world();
  await w.run({ limit: 1 }); // #1 is moved and closed, with no project
  assert.equal('project' in w.map().issues['1'], false);
  await w.run(PROJECT);
  const one = byNumber(w, 1);
  assert.deepEqual(w.updates.filter((u) => 'projectId' in u.input), [{ id: one.id, input: { projectId: 'proj-1' } }]);
  assert.equal(byNumber(w, 4).input.projectId, 'proj-1');
  assert.equal(w.map().issues['1'].project, true);
  const again = w.writes.length;
  await w.run(PROJECT);
  assert.equal(w.writes.length, again, 'nothing more to do');
});

const edit = (w) => {
  w.comments[1].push({ author: { login: 'octo-late' }, createdAt: '2026-11-05T01:00:00Z', body: 'a late comment' });
  w.issues[0].title = 'New title';
  w.issues[0].body = 'edited body';
};

test('a comment and a body edit that arrive after the first read reach FAC, before the GitHub issue closes', async () => {
  const w = world({ issues: [defaultIssues()[0]] });
  w.afterRead = () => edit(w);
  await w.run();
  const one = byNumber(w, 1);
  assert.equal(w.lcomments[one.id].at(-1).input.body, 'a late comment');
  assert.equal(w.lcomments[one.id].at(-1).input.createAsUser, 'octo-late (via GitHub)');
  assert.deepEqual(w.updates, [{ id: one.id, input: { title: 'New title', description: description(1, 'edited body') } }]);
  const at = (prefix) => w.writes.findIndex((x) => x.startsWith(prefix));
  assert.ok(at('linear:comment:uuid-1:a late comment') < at('gh:comment:1:'));
  assert.ok(at('linear:update:uuid-1') < at('gh:comment:1:'));
  assert.equal(w.writes.indexOf('gh:close:1'), at('gh:comment:1:') + 1);
});

test('a resumed run reads the issue again too: what changed while it was stopped reaches FAC', async () => {
  const w = world({ issues: [defaultIssues()[0]] });
  const clean = world({ issues: [defaultIssues()[0]] });
  await clean.run();
  w.failAt = clean.writes.findIndex((x) => x.startsWith('gh:comment'));
  await assert.rejects(w.run());
  edit(w);
  await w.run();
  assert.equal(w.created.length, 1);
  assert.equal(w.lcomments[byNumber(w, 1).id].at(-1).input.body, 'a late comment');
  assert.equal(w.updates.length, 1);
  assert.ok(w.issues[0].closed);
});

test('a map entry with a field of the wrong type is a corrupt map', async () => {
  for (const bad of [{ comments: 'x' }, { comments: -1 }, { held: 'no' }, { key: 5 }]) {
    const w = world();
    mkdirSync(join(w.state, 'linear', 'moved'), { recursive: true });
    const entry = { key: 'FAC-1', id: 'u', url: 'x', comments: 0, parent: false, held: false, ghComment: false, closed: false, ...bad };
    writeFileSync(mapFile(w.state, REPO), JSON.stringify({ version: 1, issues: { 1: entry } }));
    await assert.rejects(w.run(), /does not parse as a map/);
    assert.deepEqual(w.writes, []);
  }
});

test('--apply without --rewrites is a usage error before any read or write', async () => {
  const base = [REPO, '--team-key', 'FAC', '--board', 'ownr/7'];
  assert.throws(() => parse([...base, '--apply']), /--apply requires --rewrites/);
  const w = world();
  w.gh = () => assert.fail('must not read GitHub');
  w.api.request = () => assert.fail('must not read Linear');
  await assert.rejects(w.run({ rewrites: undefined }), /--apply requires --rewrites/);
  const env = { get FACTORY_STATE() { assert.fail('must not read environment'); } };
  const log = console.log;
  const error = console.error;
  try {
    console.log = console.error = () => {};
    assert.equal(await main([...base, '--apply'], env), 2);
  } finally { console.log = log; console.error = error; }
  assert.deepEqual(w.writes, []);
});

test('missing rewrites are skipped in the plan and do not consume --limit', async () => {
  const w = world();
  rmSync(join(w.rewrites, '1.md'));
  const plan = await w.run({ apply: false, limit: 1 });
  assert.ok(plan.lines.includes('#1 | no rewrite'));
  assert.equal(plan.count, 1);
  await w.run({ limit: 1 });
  assert.equal(w.created.length, 1);
  assert.ok(byNumber(w, 2));
  assert.equal(w.issues[0].closed, undefined);
  const absent = world();
  const dry = await absent.run({ apply: false, rewrites: undefined });
  assert.equal(dry.count, 0);
  assert.ok(dry.lines.every((l) => l.endsWith('no rewrite')));
  assert.deepEqual(absent.writes, []);
});

test('each missing heading, wrong order and a collapse line refuse before any write, naming the file', async () => {
  const headings = ['**Sublayer:**', '**Goal.**', '**Acceptance.**', '**Limits.**', '**Prior art.**'];
  for (const body of [
    ...headings.map((h) => REWRITE.replace(h, 'Removed')),
    REWRITE.replace('**Goal.**', '**Limits.**').replace('**Limits.**\nNone.', '**Goal.**\nNone.'),
    `${REWRITE}\n+++ hidden`,
  ]) {
    for (const apply of [false, true]) {
      const w = world();
      const file = join(w.rewrites, '5.md');
      writeFileSync(file, body);
      await assert.rejects(w.run({ apply }), (e) => e.message.includes(file));
      assert.deepEqual(w.writes, []);
      assert.equal(existsSync(mapFile(w.state, REPO)), false);
    }
  }
});

test('an original collapse line refuses only that issue and the plan explains why', async () => {
  const w = world();
  w.issues[0].body = 'Original\n+++ nested\ntext';
  const dry = await w.run({ apply: false });
  assert.ok(dry.lines.includes('#1 | original body has a line starting +++'));
  await w.run();
  assert.equal(byNumber(w, 1), undefined);
  assert.equal(w.map().issues['1'], undefined);
  assert.equal(w.issues[0].closed, undefined);
  assert.equal(w.created.length, 4);
  assert.equal(byNumber(w, 4).input.description, description(4, 'body 4', '\nParent on GitHub: #1'));
  assert.ok(w.writes.every((line) => !/^gh:(?:comment|close):1(?::|$)/.test(line)));
});

test('an edited rewrite changes the source hash and updates a resumed issue', async () => {
  const w = world({ issues: [gi(1)], comments: {} });
  w.failAt = 1; // the GitHub comment, after creation
  await assert.rejects(w.run());
  const previous = w.map().issues['1'].source;
  const revised = REWRITE.replace('Move it.', 'Revised goal.');
  writeFileSync(join(w.rewrites, '1.md'), revised);
  await w.run();
  assert.notEqual(w.map().issues['1'].source, previous);
  assert.equal(w.created.length, 1);
  assert.deepEqual(w.updates, [{ id: byNumber(w, 1).id, input: {
    title: 'Issue 1', description: description(1, 'body 1').replace(REWRITE, revised),
  } }]);
});

test('--only validates numbers before writes and preserves its order with --limit and rewrites', async () => {
  const base = [REPO, '--team-key', 'FAC', '--board', 'ownr/7'];
  assert.deepEqual(parse([...base, '--only', '4,2,1']).only, [4, 2, 1]);
  for (const value of ['0', '1,x', '1,', '-1', '']) assert.throws(() => parse([...base, '--only', value]), /--only/);
  const w = world();
  for (const apply of [false, true]) {
    await assert.rejects(w.run({ apply, only: [1, 99], limit: 1 }), /#99 is not an open issue/);
    assert.deepEqual(w.writes, []);
  }
  const plan = await w.run({ apply: false, only: [4, 2, 1], limit: 2 });
  assert.deepEqual(plan.lines.map((l) => Number(/^#(\d+)/.exec(l)[1])), [4, 2]);
  const result = await w.run({ only: [4, 2, 1], limit: 2 });
  assert.deepEqual(result.moved.map((i) => i.number), [4, 2]);
  assert.equal(byNumber(w, 1), undefined);
  await assert.rejects(w.run({ only: [4] }), /#4 is not an open issue/);
});

test('a requested project gains the team before issue writes and retains its other teams', async () => {
  const w = world();
  w.projects[0].teams.nodes = [{ id: 'team-other' }];
  const dry = await w.run({ ...PROJECT, apply: false });
  assert.ok(dry.lines.includes('project Release 1 | would add team FAC'));
  assert.deepEqual(w.writes, []);
  await w.run(PROJECT);
  assert.equal(w.writes[0], 'linear:projectUpdate');
  assert.deepEqual(w.projectUpdate, { id: 'proj-1', input: { teamIds: ['team-other', 'team-fac'] } });
  await w.run(PROJECT);
  assert.equal(w.writes.filter((l) => l === 'linear:projectUpdate').length, 1);
});

test('a refused projectUpdate writes no issue', async () => {
  const w = world();
  w.projects[0].teams.nodes = [{ id: 'team-other' }];
  w.failAt = 0;
  await assert.rejects(w.run(PROJECT));
  assert.deepEqual(w.writes, []);
});

test('a lost map never adopts a provenance line quoted in another issue copied body', async () => {
  const quote = `Moved from https://github.com/${REPO}/issues/2`;
  const w = world({ issues: [gi(1, { body: `Example:\n\`\`\`\n${quote}\n\`\`\`` }), gi(2)], comments: {} });
  await w.run({ only: [1] });
  const original = structuredClone(w.created[0]);
  rmSync(mapFile(w.state, REPO));
  await w.run({ only: [2] });
  assert.equal(w.created.length, 2);
  assert.deepEqual(w.created[0], original);
  assert.deepEqual(w.updates, []);
  assert.equal(w.map().issues['2'].id, w.created[1].id);
});

test('adoption accepts only line zero or the first non-blank line after the first exact Agent notes marker', async () => {
  const line = `Moved from https://github.com/${REPO}/issues/1`;
  for (const [description, matches] of [
    [`${line}\n\nold body`, true],
    [`Rewrite\r\n+++ Agent notes\r\n\r\n \t\r\n${line}\r\n\r\nbody`, true],
    [`Rewrite\n${line}\n+++ Agent notes\n\nMoved from another URL`, false],
    [`Rewrite\n+++ Agent notes\n\nOther line\n${line}`, false],
    [`Rewrite\n+++ Agent notes\n\nOther line\n+++\n+++ Agent notes\n${line}`, false],
    [`Rewrite\n+++ Agent notes extra\n${line}`, false],
  ]) {
    const w = world({ issues: [gi(1)], comments: {} });
    w.created.push({ id: 'existing', identifier: 'FAC-50', url: 'u', input: { title: 'Issue 1', description } });
    w.lcomments.existing = [];
    await w.run();
    assert.equal(w.created.length, matches ? 1 : 2, description);
    assert.equal(w.map().issues['1'].id === 'existing', matches, description);
  }
});

test('two --only runs attach parentId whichever run moves the parent', async () => {
  for (const order of [[4, 1], [1, 4]]) {
    const w = world();
    await w.run({ only: [order[0]] });
    await w.run({ only: [order[1]] });
    const child = byNumber(w, 4);
    const parent = byNumber(w, 1);
    assert.equal(w.map().issues['4'].parent, true);
    if (order[0] === 4) {
      assert.deepEqual(w.updates, [{ id: child.id, input: { parentId: parent.id } }]);
    } else {
      assert.equal(child.input.parentId, parent.id);
    }
  }
});

test('a collapse line at re-read reports and retains the twin, defers updates and close, and can resume', async () => {
  const w = world({ issues: [gi(1, { parent: { number: 2 } }), gi(2)], comments: {} });
  w.afterRead = () => { w.issues[0].body = 'changed\n+++ nested'; };
  const logs = [];
  const result = await w.run({}, (line) => logs.push(line));
  const twin = byNumber(w, 1);
  const expected = `#1 | original body has a line starting +++ | twin ${twin.identifier} exists and was not updated`;
  assert.ok(logs.includes(expected));
  assert.ok(result.lines.includes(expected));
  assert.equal(w.map().issues['1'].id, twin.id);
  assert.equal(w.map().issues['1'].closed, false);
  assert.equal(w.issues[0].closed, undefined);
  assert.ok(w.writes.every((line) => !/^gh:(?:comment|close):1(?::|$)/.test(line)));
  assert.deepEqual(w.updates, []);
  const before = [...w.writes];
  const dry = await w.run({ apply: false, project: 'Release 1', inProject: [1] });
  assert.ok(dry.lines.includes(expected));
  await w.run({ project: 'Release 1', inProject: [1] });
  assert.deepEqual(w.writes, before);
  w.issues[0].body = 'fixed body';
  await w.run({ only: [1], project: 'Release 1', inProject: [1] });
  assert.equal(w.created.length, 2);
  assert.equal(w.map().issues['1'].id, twin.id);
  assert.equal(w.map().issues['1'].closed, true);
  assert.equal(w.map().issues['1'].parent, true);
  assert.equal(w.map().issues['1'].project, true);
  assert.equal(w.issues[0].closed, true);
  assert.ok(w.updates.some((u) => u.id === twin.id && u.input.description === description(1, 'fixed body')));
});

