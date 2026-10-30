// #205 step 3, round 2: a session bin/seat recorded is charged from its record only. A --profile-dir folder that holds the same
// session's entries, under <root>/<repo>, adds nothing for it; a session with no record is still charged by cwd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';
import * as ledger from '../bin/lib/ledger.mjs';

const FIXTURE = JSON.parse(readFileSync(join(factory, 'test/fixtures/ledger-entry-2.1.308.json'), 'utf8'));
const ONE = ledger.costOf(FIXTURE.message.model, FIXTURE.message.usage);

const GH = `#!/bin/sh
case "$*" in
  *"api --paginate --slurp repos/o/app/issues"*) echo '[[]]' ;;
  *"api --paginate --slurp repos/o/app/pulls"*) echo '[[{"number":5,"created_at":"2026-10-20T10:00:00Z","closed_at":"2026-10-20T11:00:00Z"}]]' ;;
  *"api graphql"*) cat "$FAKE/pr.json" ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
`;

const pr = {
  data: {
    repository: {
      pullRequest: {
        number: 5, title: 'Add a line', url: 'https://github.com/o/app/pull/5', body: '', author: { login: 'tuan9288-agent' },
        createdAt: '2026-10-20T10:00:00Z', mergedAt: '2026-10-20T11:00:00Z', state: 'MERGED', headRefName: 'work-1', headRefOid: 'a'.repeat(40),
        mergeCommit: { oid: 'b'.repeat(40) }, comments: { nodes: [] }, closingIssuesReferences: { nodes: [] }, labels: { nodes: [] }, reviews: { nodes: [] },
        timelineItems: { nodes: [{ __typename: 'MergedEvent', createdAt: '2026-10-20T11:00:00Z' }] }, commits: { nodes: [] },
      },
    },
  },
};

const record = (over) => ({ session: 'S1', role: 'worker', seat: 1, tag: 't', run: '/r', model: 'claude-sonnet-5-5', start: '2026-10-20T08:00:00Z', end: '2026-10-20T09:00:00Z', minutes: 60, total_cost_usd: 3, ...over });

/** The cost of PR #5 of o/app, with the records, and in a --profile-dir folder one entry for each session id given, under <root>/app. */
function costOfPr(records, sessionIds) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-once-')));
  try {
    for (const d of ['bin', 'root/app', 'state', 'runs', 'seatprofile/projects/x']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'bin/gh'), GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'pr.json'), JSON.stringify(pr));
    writeFileSync(join(dir, 'state/sessions.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const entries = sessionIds.map((id, i) => ({ ...structuredClone(FIXTURE), sessionId: id, uuid: `u${i}`, requestId: `r${i}`, cwd: join(dir, 'root/app'), gitBranch: 'work-1', message: { ...FIXTURE.message, id: `m${i}` } }));
    writeFileSync(join(dir, 'seatprofile/projects/x/s.jsonl'), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const r = run(dir, join(factory, 'bin/factory-ledger'), ['--rows', '--repo', 'o/app', '--since', '2026-10-01', '--until', '2026-10-31', '--profile-dir', join(dir, 'seatprofile')], {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE: dir, FACTORY_ROOT: join(dir, 'root'), FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'),
    });
    assert.equal(r.code, 0, r.out);
    const [head, row] = r.out.trim().split('\n').map((l) => l.split('\t'));
    return Object.fromEntries(head.map((name, i) => [name, row[i]]))['cost_usd'];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a session with a seat record and entries under the repository is charged once, from the record; one with no record, by cwd', () => {
  assert.equal(costOfPr([record({ repo: 'o/app', branch: 'work-1' })], ['S1', 'S1']), '3.0000');
  assert.equal(costOfPr([record({ repo: 'o/app', branch: 'work-1' })], ['S1', 'S2']), (3 + ONE).toFixed(4));
  assert.equal(costOfPr([], ['S2']), ONE.toFixed(4));
});

test('a record that names no repository and branch is never charged again by cwd', () => {
  assert.equal(costOfPr([record({})], ['S1']), '');
});
