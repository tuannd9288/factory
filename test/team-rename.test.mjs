import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameTeam } from '../bin/lib/team-rename.mjs';
import { holderOf } from '../bin/lib/linear-cli.mjs';

function world(t) {
  const home = mkdtempSync(join(tmpdir(), 'team-rename-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, root: home, state: join(home, 'state'), runs: join(home, 'runs'), profiles: join(home, 'profiles'), processes: () => [], log: (s) => logs.push(s) };
  const logs = [], calls = [];
  for (const d of [options.state, join(options.runs, 'factory-lead/transcripts'), join(options.profiles, 'factory/factory-lead/claude'), join(home, '.gate/bin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(options.runs, 'factory-lead/transcripts/session.jsonl'), 'conversation');
  writeFileSync(join(options.profiles, 'factory/factory-lead/claude/settings.json'), '{}');
  writeFileSync(join(options.state, 'accounts'), '# unchanged\nfactory/factory-lead=test\n');
  writeFileSync(join(home, '.gate/bin/claim'), 'fake');
  options.run = (file, args) => { calls.push(args); return args[0] === '--list' ? '4\tclaimed\tlead\t1234567\tdate\n5\tclaimed\tother\t7654321\tdate\n' : ''; };
  return { options, logs, calls };
}

test('rename dry run leaves state intact, apply carries transcripts, profile, row and GitHub claim', async (t) => {
  const { options: o, logs, calls } = world(t);
  await renameTeam('factory', 'lead', 'otter', o);
  assert.ok(logs.some((l) => l.includes('would move account row')));
  assert.ok(existsSync(join(o.runs, 'factory-lead')));
  assert.deepEqual(calls, [['--list']]);
  await renameTeam('factory', 'lead', 'otter', { ...o, apply: true });
  assert.equal(readFileSync(join(o.runs, 'factory-otter/transcripts/session.jsonl'), 'utf8'), 'conversation');
  assert.ok(!existsSync(join(o.runs, 'factory-lead')));
  assert.ok(existsSync(join(o.profiles, 'factory/factory-otter/claude/settings.json')));
  assert.equal(readFileSync(join(o.state, 'accounts'), 'utf8'), '# unchanged\nfactory/factory-otter=test\n');
  assert.deepEqual(calls.at(-1), ['--handoff', '4', 'lead', 'otter']);
});

test('running Lead and occupied destination refuse before any move', async (t) => {
  const { options: o, calls } = world(t);
  await assert.rejects(renameTeam('factory', 'lead', 'otter', { ...o, apply: true, processes: () => [{ command: 'claude --name factory-lead' }] }), /is running/);
  mkdirSync(join(o.runs, 'factory-otter'));
  await assert.rejects(renameTeam('factory', 'lead', 'otter', { ...o, apply: true }), /already exists/);
  assert.deepEqual(calls, []);
});

test('Linear holder moves through the CLI functions without changing issue status', async (t) => {
  const { options: o } = world(t);
  mkdirSync(join(o.state, 'linear'));
  writeFileSync(join(o.state, 'linear/repos.json'), JSON.stringify({ factory: { key: 'FAC', teamId: 'fac' } }));
  const comments = [{ body: 'Taken by team lead.', createdAt: '0' }];
  o.api = {
    request: async (query) => query.includes('issues(filter:') ? { issues: { nodes: [{ id: 'i', identifier: 'FAC-4' }], pageInfo: {} } } : { issue: { comments: { nodes: comments, pageInfo: {} } } },
    commentCreate: async ({ body, team }) => { comments.push({ body, team, createdAt: String(comments.length) }); return { commentCreate: { success: true, comment: { id: 'c' } } }; },
  };
  await renameTeam('factory', 'lead', 'otter', o);
  assert.equal(comments.length, 1);
  await renameTeam('factory', 'lead', 'otter', { ...o, apply: true });
  assert.equal(holderOf(comments), 'otter');
  assert.deepEqual(comments.map((c) => c.body), ['Taken by team lead.', 'Released by team lead.', 'Taken by team otter.']);
  assert.deepEqual(comments.slice(1).map((c) => c.team), ['factory-lead', 'factory-otter'], 'each write shows the full team name (#441)');
});

test('a partial failure reports completed and remaining moves', async (t) => {
  const { options: o, logs } = world(t);
  const run = o.run;
  o.run = (file, args) => { if (args[0] === '--handoff') throw new Error('offline'); return run(file, args); };
  await assert.rejects(renameTeam('factory', 'lead', 'otter', { ...o, apply: true }), /earlier moves remain applied/);
  assert.ok(logs.some((l) => l.startsWith('moved account row')));
  assert.ok(logs.some((l) => l.startsWith('not completed GitHub claim #4')));
});
