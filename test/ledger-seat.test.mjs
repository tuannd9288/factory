// #205 step 3: the ledger charges a task from the records bin/seat appends to sessions.jsonl, by the repository and the branch
// each record names, and reads no repository profile. The rows come from `bin/factory-ledger --rows` with a fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';
import * as ledger from '../bin/lib/ledger.mjs';

const FIXTURE = JSON.parse(readFileSync(join(factory, 'test/fixtures/ledger-entry-2.1.308.json'), 'utf8'));

const GH = `#!/bin/sh
case "$*" in
  *"api --paginate --slurp repos/o/app/issues"*) echo '[[]]' ;;
  *"api --paginate --slurp repos/o/app/pulls"*) echo '[[{"number":5,"created_at":"2026-10-20T10:00:00Z","closed_at":"2026-10-20T11:00:00Z"}]]' ;;
  *"api graphql"*) cat "$FAKE/pr.json" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

const pr = (head) => ({
  data: {
    repository: {
      pullRequest: {
        number: 5,
        title: 'Add a line',
        url: 'https://github.com/o/app/pull/5',
        body: '',
        author: { login: 'tuan9288-agent' },
        createdAt: '2026-10-20T10:00:00Z',
        mergedAt: '2026-10-20T11:00:00Z',
        state: 'MERGED',
        headRefName: head,
        headRefOid: 'a'.repeat(40),
        mergeCommit: { oid: 'b'.repeat(40) },
        comments: { nodes: [] },
        closingIssuesReferences: { nodes: [] },
        labels: { nodes: [] },
        reviews: { nodes: [] },
        timelineItems: { nodes: [{ __typename: 'MergedEvent', createdAt: '2026-10-20T11:00:00Z' }] },
        commits: { nodes: [] },
      },
    },
  },
});

const record = (over) => ({ session: 's', role: 'worker', seat: 1, tag: 't', run: '/r', model: 'claude-sonnet-5-5', start: '2026-10-20T08:00:00Z', end: '2026-10-20T09:00:00Z', minutes: 60, turns: 1, duration_ms: 1, total_cost_usd: 1, structured: null, ended: 'success', exitCode: 0, signal: null, ...over });

/** The rows of PR #5 (head branch `work-1`) of o/app, with the given seat records in the state folder and the files `setup` makes. */
function rows(records, setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-seat-'));
  try {
    for (const d of ['bin', 'root', 'profiles', 'state', 'runs']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'bin/gh'), GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'pr.json'), JSON.stringify(pr('work-1')));
    writeFileSync(join(dir, 'state/sessions.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    setup(dir);
    const r = run(dir, join(factory, 'bin/factory-ledger'), ['--rows', '--repo', 'o/app', '--since', '2026-10-01', '--until', '2026-10-31'], {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE: dir,
      FACTORY_ROOT: join(dir, 'root'),
      AGENT_PROFILES: join(dir, 'profiles'),
      FACTORY_STATE: join(dir, 'state'),
      FACTORY_RUNS: join(dir, 'runs'),
    });
    assert.equal(r.code, 0, r.out);
    const [head, row] = r.out.trim().split('\n').map((l) => l.split('\t'));
    return Object.fromEntries(head.map((name, i) => [name, row[i]]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a seat session\'s cost reaches the pull request whose head branch it ran on, once over its resumed records', () => {
  const row = rows([
    record({ session: 's1', tag: 'first', end: '2026-10-20T09:00:00Z', total_cost_usd: 1, repo: 'o/app', branch: 'work-1' }),
    record({ session: 's1', tag: 'again', end: '2026-10-20T10:00:00Z', total_cost_usd: 3, repo: 'o/app', branch: 'work-1' }),
    record({ session: 's2', total_cost_usd: 0.5, repo: 'o/app', branch: 'work-1' }),
    record({ session: 's3', total_cost_usd: 7, repo: 'o/app', branch: 'other' }),
    record({ session: 's4', total_cost_usd: 11, repo: 'o/else', branch: 'work-1' }),
  ]);
  assert.equal(row.cost_usd, '3.5000');
});

test('a record with no repository or no branch is charged to no pull request', () => {
  const row = rows([record({ session: 's1', total_cost_usd: 4 }), record({ session: 's2', total_cost_usd: 4, repo: 'o/app', branch: null }), record({ session: 's3', total_cost_usd: 4, repo: null, branch: 'work-1' })]);
  assert.equal(row.cost_usd, '');
});

test('the ledger reads no profile under <profiles>/<owner>/<name>/claude, even where one exists', () => {
  const row = rows([], (dir) => {
    const folder = join(dir, 'profiles/o/app/claude/projects/x');
    mkdirSync(folder, { recursive: true });
    const entry = { ...structuredClone(FIXTURE), uuid: 'u0', requestId: 'r0', gitBranch: 'work-1', message: { ...FIXTURE.message, id: 'm0' } };
    writeFileSync(join(folder, 's.jsonl'), `${JSON.stringify(entry)}\n`);
  });
  assert.equal(row.cost_usd, '');
});

test('the digest counts the records that name no repository and branch, with their total, in one line', () => {
  const sessions = [
    record({ session: 'a', total_cost_usd: 2 }),
    record({ session: 'b', total_cost_usd: 1.5, repo: null, branch: null }),
    record({ session: 'c', total_cost_usd: 9, repo: 'o/app', branch: 'work-1' }),
    record({ session: 'd', total_cost_usd: 100, start: '2026-09-01T08:00:00Z', end: '2026-09-01T09:00:00Z' }),
  ];
  const text = ledger.digest([], { since: '2026-10-14', until: '2026-10-21', sessions });
  const lines = text.split('\n').filter((l) => /charged to no task/.test(l));
  assert.equal(lines.length, 1, text);
  assert.match(lines[0], /^- 2 sessions \(\$3\.50 at API prices\) charged to no task, because the record names no repository and branch$/);
  assert.doesNotMatch(ledger.digest([], { since: '2026-10-14', until: '2026-10-21', sessions: [sessions[2]] }), /charged to no task/);
});
