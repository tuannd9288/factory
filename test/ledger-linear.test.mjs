// The ledger for a repository on Linear (#406): the digest's task list reads the team's issues, and joins a task to its pull
// requests by the `Issue: <KEY>` line. A repository that is not on Linear keeps its GitHub reads. No network: `api` is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, linearIssueOf, linearTaskRows } from '../bin/lib/ledger.mjs';

const FROM = Date.parse('2026-11-01T00:00:00Z');
const TO = Date.parse('2026-11-07T23:59:59Z');

/** A fake Linear that answers `issues(` from `pages`, and records each filter. */
function fakeApi(pages) {
  const asked = [];
  return {
    asked,
    request: async (query, vars) => {
      assert.match(query, /issues\(filter/);
      asked.push(vars.filter);
      const at = vars.after ? Number(vars.after) : 0;
      return { issues: { nodes: pages[at], pageInfo: { hasNextPage: at + 1 < pages.length, endCursor: String(at + 1) } } };
    },
  };
}

test('the Issue: line is read in its key form, one line at the start of a line', () => {
  assert.equal(linearIssueOf('Summary\n\nIssue: FAC-12\nClaim: x'), 'FAC-12');
  assert.equal(linearIssueOf('Issue:   FAC-7  \r\n'), 'FAC-7');
  assert.equal(linearIssueOf('Issue: #12'), null);
  assert.equal(linearIssueOf('Issue: none'), null);
  assert.equal(linearIssueOf('see Issue: FAC-12'), null);
  assert.equal(linearIssueOf('Issue: FAC-0'), null);
  assert.equal(linearIssueOf(null), null);
});

const prRow = (number, over = {}) => ({
  repo: 'o/on', number, title: `PR ${number}`, url: `u/${number}`, prs: [number], livePRs: [], merges: [], codexRuns: 0, who: 'agent', tier: 1, state: 'open', rounds: 1,
  firstPass: true, noRed: false, raised: false, touched: false, touchedWhy: '', cost: 1, costNote: '', created: '2026-11-03T10:00:00Z', merged: null, hours: null, ...over,
});

test('the digest\'s task list is the team\'s issues that left Triage, from the start to the completion, each with its pull requests by Issue: KEY', async () => {
  const api = fakeApi([[
    { identifier: 'FAC-1', title: 'Started and done', url: 'https://linear.app/x/FAC-1', createdAt: '2026-10-01T00:00:00Z', startedAt: '2026-11-02T00:00:00Z', completedAt: '2026-11-04T00:00:00Z', canceledAt: null },
    { identifier: 'FAC-2', title: 'Never started, still open', url: 'https://linear.app/x/FAC-2', createdAt: '2026-11-03T00:00:00Z', startedAt: null, completedAt: null, canceledAt: null },
    { identifier: 'FAC-3', title: 'Done before the window', url: 'https://linear.app/x/FAC-3', createdAt: '2026-09-01T00:00:00Z', startedAt: '2026-09-02T00:00:00Z', completedAt: '2026-09-05T00:00:00Z', canceledAt: null },
    { identifier: 'FAC-4', title: 'Canceled inside it', url: 'https://linear.app/x/FAC-4', createdAt: '2026-10-20T00:00:00Z', startedAt: null, completedAt: null, canceledAt: '2026-11-05T00:00:00Z' },
  ]]);
  const rowsOf = [];
  const allPulls = [{ number: 10, body: 'Issue: FAC-1\nClaim: a' }, { number: 11, body: 'Issue: FAC-1' }, { number: 12, body: 'Issue: #5' }, { number: 13, body: 'Issue: FAC-3' }];
  const { rows, keys } = await linearTaskRows({
    repo: 'o/on', api, teamKey: 'FAC', allPulls, from: FROM, to: TO,
    pullRow: (n) => (rowsOf.push(n), prRow(n, n === 11 ? { state: 'landed', merged: '2026-11-04T00:00:00Z', created: '2026-11-03T00:00:00Z' } : {})),
  });
  assert.deepEqual(api.asked[0], { team: { key: { eq: 'FAC' } }, state: { type: { neq: 'triage' } } });
  assert.deepEqual(rows.map((r) => r.number), ['FAC-1', 'FAC-2', 'FAC-4']);
  assert.deepEqual([...keys].sort(), ['FAC-1', 'FAC-2', 'FAC-3', 'FAC-4'], 'every task, in or out of the window: its pull requests are no task of their own');
  const one = rows[0];
  assert.deepEqual(one.prs, [11, 10], 'both, by their creation');
  assert.equal(one.created, '2026-11-02T00:00:00Z', 'from startedAt');
  assert.equal(one.state, 'landed');
  assert.equal(one.hours, 48);
  assert.equal(rows[1].created, '2026-11-03T00:00:00Z', 'from createdAt when startedAt is missing');
  assert.equal(rows[1].state, 'open');
  assert.equal(rows[2].state, 'abandoned');
  assert.deepEqual(rows[2].prs, []);
  assert.deepEqual(rowsOf, [10, 11], 'only a task alive in the window reads its pull requests');
  assert.match(digest(rows, { since: '2026-11-01', until: '2026-11-07' }), /\[FAC-1\]\(https:\/\/linear\.app\/x\/FAC-1\)/);
});

test('a page of issues is followed to its end', async () => {
  const one = (n) => ({ identifier: `FAC-${n}`, title: 't', url: 'u', createdAt: '2026-11-02T00:00:00Z', startedAt: '2026-11-02T00:00:00Z', completedAt: null, canceledAt: null });
  const api = fakeApi([[one(1)], [one(2)], [one(3)]]);
  const { rows } = await linearTaskRows({ repo: 'o/on', api, teamKey: 'FAC', allPulls: [], pullRow: () => assert.fail('no pull request'), from: FROM, to: TO });
  assert.deepEqual(rows.map((r) => r.number), ['FAC-1', 'FAC-2', 'FAC-3']);
});

test('a repository whose Linear issues could not be read gets a line in the digest, and the rest of the digest is written', () => {
  const other = { ...prRow(7, { title: 'Other repo task' }), repo: 'o/gh', number: 7, url: 'u/7', state: 'landed', merged: '2026-11-04T00:00:00Z', hours: 1 };
  const text = digest([other], { since: '2026-11-01', until: '2026-11-07', unread: new Map([['o/on', 'Linear answered HTTP 401: no data']]) });
  assert.match(text, /- o\/on: could not read its Linear issues \(Linear answered HTTP 401: no data\); its task list above is missing/);
  assert.match(text, /Other repo task/);
  assert.doesNotMatch(digest([other], { since: '2026-11-01', until: '2026-11-07' }), /could not read its Linear issues/);
});
