// The ledger's arithmetic and its reading of pull requests and session files, on fixtures; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from '../bin/lib/ledger.mjs';
import { branchCosts, costOf, digest, rate, rowOf, wilson } from '../bin/lib/ledger.mjs';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the Wilson interval of 18 of 20', () => {
  const [a, b] = wilson(18, 20);
  assert.ok(Math.abs(a - 0.699) < 0.001, a);
  assert.ok(Math.abs(b - 0.972) < 0.001, b);
  assert.equal(wilson(0, 0), null);
  assert.equal(rate(0, 0), 'none yet (n=0)');
  assert.match(rate(1, 4), /^1\/4 \(25\.0%; 95% CI: 4\.6%–69\.9%\)$/);
});

test('prices each kind of token, and refuses a model it does not know', () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6 }), 4);
  assert.equal(costOf('claude-opus-5-5', { output_tokens: 1e6 }), 20);
  assert.equal(costOf('claude-opus-5-5', { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } }), 8);
  assert.equal(costOf('claude-opus-5-5', { cache_creation_input_tokens: 1e6 }), 5);
  assert.equal(costOf('claude-opus-5-5', { cache_read_input_tokens: 1e6 }), 0.2);
  assert.equal(costOf('gpt-6', { input_tokens: 1 }), null);
});

test('counts a message once although its blocks repeat its usage, per branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    mkdirSync(join(dir, 'projects/p'), { recursive: true });
    const line = (id, branch, model = 'claude-sonnet-5-5') =>
      JSON.stringify({ type: 'assistant', gitBranch: branch, message: { id, model, usage: { input_tokens: 1e6 } } });
    writeFileSync(join(dir, 'projects/p/s.jsonl'), [line('m1', 'a'), line('m1', 'a'), line('m2', 'b'), line('m3', 'b', 'mystery-model'), '{not json'].join('\n'));
    const costs = branchCosts(dir);
    assert.equal(costs.get('a').dollars, 2);
    assert.equal(costs.get('b').dollars, 2);
    assert.deepEqual([...costs.get('b').unpriced], ['mystery-model']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const run = (name, conclusion) => ({ name, conclusion });
// The checks kit/.gate/ruleset.json requires; a first commit is green when every one of them passed on it.
const green = ['verify', 'review', 'verdict', 'tier'].map((n) => run(n, 'SUCCESS'));
const pr = (over) => ({
  number: 7,
  title: 'Limit sends',
  url: 'https://github.com/o/r/pull/7',
  body: '',
  author: { login: 'agent' },
  createdAt: '2026-10-20T10:00:00Z',
  mergedAt: null,
  state: 'OPEN',
  headRefName: 'limit',
  labels: { nodes: [] },
  reviews: { nodes: [] },
  timelineItems: { nodes: [] },
  commits: { nodes: [] },
  ...over,
});
const commit = (oid, runs) => ({ commit: { oid, checkSuites: { nodes: [{ app: { slug: 'github-actions' }, checkRuns: { nodes: runs } }] } } });

test('a pull request merged by rule after two judged commits: two rounds, not first-pass, not touched', () => {
  const row = rowOf(
    'o/r',
    pr({
      mergedAt: '2026-10-20T12:00:00Z',
      state: 'MERGED',
      labels: { nodes: [{ name: 'tier-1' }, { name: 'tier-2' }] },
      timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'MergedEvent' }] },
      commits: { nodes: [commit('a', [run('verify', 'FAILURE')]), commit('b', green), commit('c', []), { commit: { ...commit('m', green).commit, parents: { totalCount: 2 } } }] },
    }),
    { human: 'boss', costs: new Map([['limit', { dollars: 1.5, models: new Set(['claude-sonnet-5-5']), unpriced: new Set() }]]), profile: true },
  );
  assert.equal(row.state, 'landed');
  assert.equal(row.tier, 2);
  assert.equal(row.rounds, 2);
  assert.equal(row.firstPass, false);
  assert.equal(row.touched, false);
  assert.equal(row.cost, 1.5);
  assert.equal(row.who, 'agent · sonnet-5-5');
  assert.equal(row.hours, 2);
});

test('the Human is counted as touching a pull request he approved, labelled needs-human, or merged by hand', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  assert.equal(rowOf('o/r', pr({ reviews: { nodes: [{ author: { login: 'boss' }, state: 'APPROVED' }] } }), opts).touchedWhy, 'reviewed');
  assert.equal(rowOf('o/r', pr({ labels: { nodes: [{ name: 'needs-human' }] } }), opts).touchedWhy, 'needs-human');
  const manual = rowOf('o/r', pr({ mergedAt: '2026-10-20T11:00:00Z', timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'AutoMergeDisabledEvent' }, { __typename: 'MergedEvent' }] } }), opts);
  assert.equal(manual.touchedWhy, 'manual merge');
  assert.equal(manual.costNote, 'no profile');
  assert.equal(rowOf('o/r', pr({ reviews: { nodes: [{ author: { login: 'agent' }, state: 'APPROVED' }] } }), opts).touched, false);
});

test('the digest gives every rate with its count, and lists what waits for the Human', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const rows = [
    rowOf('o/r', pr({ number: 1, labels: { nodes: [{ name: 'tier-3' }] } }), opts),
    rowOf('o/r', pr({ number: 2, mergedAt: '2026-10-20T11:00:00Z', commits: { nodes: [commit('a', green)] }, timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'MergedEvent' }] } }), opts),
  ];
  const text = digest(rows, { since: '2026-10-14', until: '2026-10-21', secrets: new Map([['o/r', ['DEPLOY_KEY']], ['o/s', []], ['o/t', null]]) });
  assert.match(text, /- o\/r: DEPLOY_KEY\n- o\/s: 0\n- o\/t: could not be checked/);
  assert.match(text, /^# Weekly digest 2026-10-14 → 2026-10-21$/m);
  assert.match(text, /2 tasks: 1 merged, 1 open, 0 abandoned \(0 abandoned before a PR\)/);
  assert.match(text, /API-equivalent cost per merged task/);
  assert.match(text, /\nCash: the Claude subscription, paid monthly, not split by task/);
  assert.match(text, /o\/r#1 Limit sends — tier 3, awaiting the Human's approval/);
  assert.match(text, /Tasks merged: 1\/2 \(50\.0%; 95% CI: /);
  assert.match(text, /Merged tasks the Human had to touch: 0\/1 /);
  assert.match(text, /Green at the first commit the gate judged: 1\/1 /);
  assert.match(text, /\| \? \(no profile\) \|/);
  assert.match(text, /\| Repo \| Task \| PR \| Who \| Tier \| Rounds \| API cost \| Human touched \| Outcome \|/);
});

const REQUIRED = ['verify', 'review', 'verdict', 'tier'];
const checks = (over = {}) => Object.fromEntries(REQUIRED.map((name, i) => [name, { state: 'SUCCESS', startedAt: '2026-10-21T10:00:00Z', jobId: String(40 + i), ...over[name] }]));

test('the queue updates the oldest pull request left behind, one at a time, reading only the required checks', async () => {
  const { pickUpdate } = await import('../bin/lib/queue.mjs');
  const p = (number, createdAt, mergeStateStatus, over = {}) => ({ number, createdAt, mergeStateStatus, autoMerge: true, isDraft: false, labels: [], checks: checks(), ...over });
  assert.equal(pickUpdate([p(2, '2026-10-21T02', 'BEHIND'), p(1, '2026-10-21T01', 'BEHIND'), p(3, '2026-10-21T00', 'BEHIND', { autoMerge: false })], REQUIRED).number, 1);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND'), p(2, '2026-10-21T02', 'BLOCKED', { checks: checks({ review: { state: 'PENDING' } }) })], REQUIRED), null);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND'), p(2, '2026-10-21T02', 'BLOCKED', { checks: { verify: checks().verify } })], REQUIRED), null);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND'), p(2, '2026-10-21T02', 'BLOCKED', { checks: checks({ verify: { state: 'FAILURE' } }) })], REQUIRED).number, 1);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'CLEAN')], REQUIRED), null);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND', { checks: checks({ verify: { state: 'FAILURE' } }) }), p(2, '2026-10-21T02', 'BEHIND')], REQUIRED).number, 2);
  // An optional check that failed, and a tier check waiting on the Human, do not stop the update.
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND', { checks: { ...checks({ tier: { state: 'FAILURE' } }), lint: { state: 'FAILURE' } } })], REQUIRED).number, 1);
});

test('the queue leaves a tier-3 pull request behind main until its tier check passes, so the Human approves once', async () => {
  const { pickUpdate } = await import('../bin/lib/queue.mjs');
  const p = (number, labels, tier) => ({ number, createdAt: `2026-10-21T0${number}`, mergeStateStatus: 'BEHIND', autoMerge: true, isDraft: false, labels, checks: checks({ tier: { state: tier } }) });
  assert.equal(pickUpdate([p(1, ['tier-3'], 'FAILURE'), p(2, ['tier-1'], 'SUCCESS')], REQUIRED).number, 2);
  assert.equal(pickUpdate([p(1, ['tier-2', 'needs-human'], 'PENDING')], REQUIRED), null);
  assert.equal(pickUpdate([p(1, ['tier-3'], 'SUCCESS')], REQUIRED).number, 1);
});

test('one conflicting pull request, whose verify never runs, does not stop the queue for its repository', async () => {
  const { pickUpdate } = await import('../bin/lib/queue.mjs');
  const p = (number, mergeStateStatus, over = {}) => ({ number, createdAt: `2026-10-21T0${number}`, mergeStateStatus, autoMerge: true, isDraft: false, labels: [], checks: checks(), ...over });
  // pull_request does not run on a head that conflicts with its base, so its verify is missing, not pending.
  const { verify, ...waiting } = checks({ review: { state: 'PENDING' }, verdict: { state: 'PENDING' } });
  assert.equal(pickUpdate([p(1, 'DIRTY', { checks: waiting }), p(2, 'BEHIND')], REQUIRED)?.number, 2);
  assert.equal(pickUpdate([p(1, 'UNKNOWN', { checks: waiting }), p(2, 'BEHIND')], REQUIRED), null);
});

test('the queue re-runs the failed tier job alone once someone other than the author approved the head after it started', async () => {
  const { pickReruns } = await import('../bin/lib/queue.mjs');
  const pr = (approvals, tier = { state: 'FAILURE', startedAt: '2026-10-21T10:00:00Z', jobId: '42' }) => ({ number: 7, author: 'agent', head: 'h', approvals, checks: checks({ tier, verdict: { state: 'FAILURE', jobId: '43' } }) });
  assert.deepEqual(pickReruns([pr([{ login: 'boss', oid: 'h', at: '2026-10-21T10:05:00Z' }])]), [{ number: 7, jobId: '42' }]);
  // An approval that landed while the job ran, after it read the reviews, still re-runs it.
  assert.deepEqual(pickReruns([pr([{ login: 'boss', oid: 'h', at: '2026-10-21T10:00:30Z' }])]), [{ number: 7, jobId: '42' }]);
  assert.deepEqual(pickReruns([pr([{ login: 'boss', oid: 'h', at: '2026-10-21T09:55:00Z' }])]), []);
  assert.deepEqual(pickReruns([pr([{ login: 'boss', oid: 'old', at: '2026-10-21T10:05:00Z' }])]), []);
  assert.deepEqual(pickReruns([pr([{ login: 'agent', oid: 'h', at: '2026-10-21T10:05:00Z' }])]), []);
  assert.deepEqual(pickReruns([pr([{ login: 'boss', oid: 'h', at: '2026-10-21T10:05:00Z' }], { state: 'SUCCESS', startedAt: '2026-10-21T10:00:00Z', jobId: '42' })]), []);
});

test('a sweep runs once, alone, never as the Human, and leaves a failure report until a sweep succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-'));
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "api user"*) echo "${Q_LOGIN:-agent-bot}" ;;\n  *graphql*) cat "$Q/pulls.json" ;;\n  *rules/branches*) echo \'[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"}]}}]\' ;;\n  *) exit 1 ;;\nesac\n');
    chmodSync(join(dir, 'gh'), 0o755);
    const state = join(dir, 'state');
    const sweep = (env = {}) => spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_STATE: state, ...env } });
    const report = join(state, 'queue-o-app.failed');
    writeFileSync(join(dir, 'pulls.json'), 'not json');
    let out = sweep();
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(readFileSync(report, 'utf8'), /^20\d\d-.*o\/app/);
    writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }));
    out = sweep({ Q_LOGIN: 'tuannd9288' });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stderr, /runs as the agents' account, not the Human's \(tuannd9288\)/);
    mkdirSync(join(state, 'queue.lock'), { recursive: true });
    writeFileSync(join(dir, 'calls'), '');
    out = sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /another sweep is running/);
    assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), '');
    rmSync(join(state, 'queue.lock'), { recursive: true });
    out = sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.ok(!existsSync(report));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const issue = (over) => ({
  number: 3,
  title: 'Rate-limit sends',
  url: 'https://github.com/o/r/issues/3',
  createdAt: '2026-10-19T08:00:00Z',
  closedAt: null,
  state: 'OPEN',
  stateReason: null,
  timelineItems: { nodes: [{ __typename: 'LabeledEvent', createdAt: '2026-10-19T09:00:00Z', label: { name: 'task' } }] },
  ...over,
});

test('a task runs from its assignment to its close, across every pull request that closes it', () => {
  const opts = { human: 'boss', costs: new Map([['limit', { dollars: 1, models: new Set(['claude-sonnet-5-5']), unpriced: new Set() }], ['limit-2', { dollars: 2, models: new Set(['claude-sonnet-5-5']), unpriced: new Set() }]]), profile: true };
  const dropped = rowOf('o/r', pr({ number: 7, state: 'CLOSED', labels: { nodes: [{ name: 'tier-2' }] }, commits: { nodes: [commit('a', [run('verify', 'FAILURE')])] } }), opts);
  const merged = rowOf('o/r', pr({ number: 8, headRefName: 'limit-2', createdAt: '2026-10-20T10:00:00Z', mergedAt: '2026-10-20T13:00:00Z', state: 'MERGED', commits: { nodes: [commit('b', green)] }, timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'MergedEvent' }] } }), opts);
  const row = ledger.taskRow('o/r', issue({ state: 'CLOSED', closedAt: '2026-10-20T13:00:00Z' }), [merged, dropped]);
  assert.equal(row.number, 3);
  assert.deepEqual(row.prs, [7, 8]);
  assert.equal(row.state, 'landed');
  assert.equal(row.created, '2026-10-19T09:00:00Z');
  assert.equal(row.hours, 28);
  assert.equal(row.rounds, 2);
  assert.equal(row.firstPass, false);
  assert.equal(row.tier, 2);
  assert.equal(row.cost, 3);
});

test('a task dropped before any pull request is a row, and its cost stays unknown', () => {
  const row = ledger.taskRow('o/r', issue({ state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-10-20T08:00:00Z' }), []);
  assert.equal(row.state, 'abandoned');
  assert.deepEqual(row.prs, []);
  assert.equal(row.cost, null);
  assert.equal(row.costNote, 'no PR yet');
  assert.equal(row.firstPass, null);
  const text = digest([row], { since: '2026-10-14', until: '2026-10-21' });
  assert.match(text, /1 task: 0 merged, 0 open, 1 abandoned \(1 abandoned before a PR\)/);
});

test('the window holds every task alive in it: started in it, open at its end, or closed inside it', () => {
  const from = Date.parse('2026-10-14T00:00:00Z');
  const to = Date.parse('2026-10-21T23:59:59Z');
  assert.equal(ledger.inWindow('2026-10-01T00:00:00Z', null, from, to), true);
  assert.equal(ledger.inWindow('2026-10-01T00:00:00Z', '2026-10-15T00:00:00Z', from, to), true);
  assert.equal(ledger.inWindow('2026-10-15T00:00:00Z', '2026-10-30T00:00:00Z', from, to), true);
  assert.equal(ledger.inWindow('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z', from, to), false);
  assert.equal(ledger.inWindow('2026-10-25T00:00:00Z', null, from, to), false);
});

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const P = 'c'.repeat(40);
const said = (verdict, head, patch, login = 'agent', runs = 1) => ({
  author: { login },
  body: `live-verify: ${verdict}\nhead: ${head}\nparent: ${'d'.repeat(40)}\npatch: ${patch}\ndriver: cli\ncodex: codex-cli 0.159.2, ${runs} run${runs > 1 ? 's' : ''}\n`,
});

test('a merged pull request is covered by a live verdict on its merged head, or on one whose patch it carries', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const merged = (comments, patchOf) =>
    rowOf('o/r', pr({ mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', headRefOid: H2, mergeCommit: { oid: 'e'.repeat(40) }, comments: { nodes: comments } }), { ...opts, patchOf });
  assert.equal(merged([said('PASS', H2, 'f'.repeat(40))], () => null).live, true);
  assert.equal(merged([], () => P).live, false);
  assert.equal(merged([said('PASS+NOTES', H, P)], () => P).live, true);
  assert.equal(merged([said('PASS', H, P), said('FAIL', H, P)], () => P).live, false);
  // Without the patch of the merged head, an older head's verdict may still carry it: not known, not a miss.
  assert.equal(merged([said('PASS', H, P)], () => null).live, null);
  assert.equal(merged([said('PASS', H2, P, 'someone')], () => P).live, false);
  assert.equal(merged([said('BLOCKED', H, '-', 'agent', 0), said('PASS', H2, P, 'agent', 2)], () => P).codexRuns, 2);
  assert.equal(rowOf('o/r', pr({ comments: { nodes: [said('PASS', H, P)] } }), opts).live, undefined);
});

test('the digest lists every merged pull request no live verdict covered, and Codex runs on a line of their own', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const merged = (number, comments, patch) =>
    rowOf('o/r', pr({ number, mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', headRefOid: H2, mergeCommit: { oid: 'e'.repeat(40) }, comments: { nodes: comments } }), { ...opts, patchOf: () => patch });
  const rows = [merged(1, [said('PASS', H2, P)], P), merged(2, [], P), merged(3, [said('PASS', H, P, 'agent', 2)], null), rowOf('o/r', pr({ number: 4 }), opts)];
  const text = digest(rows, { since: '2026-10-14', until: '2026-10-21' });
  assert.match(text, /- Merged PRs whose head a live verdict covers: 1\/2 \(50\.0%; 95% CI: /);
  assert.match(text, /- No covering verdict: o\/r#2 Limit sends\n/);
  assert.match(text, /- Undetermined \(patch-id not computable in the clone\): o\/r#3\n/);
  assert.match(text, /- Codex runs: 3 \(the verifier's Codex subscription, paid monthly; no API price, not split by task\)/);
});

test('the digest counts the pull requests the reviewer raised, per repository', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const raised = rowOf('o/r', pr({ number: 5, timelineItems: { nodes: [{ __typename: 'LabeledEvent', label: { name: 'raised' } }] } }), opts);
  const kept = rowOf('o/r', pr({ number: 6, labels: { nodes: [{ name: 'raised' }, { name: 'tier-3' }] } }), opts);
  const plain = rowOf('o/s', pr({ number: 7 }), opts);
  assert.deepEqual([raised.raised, kept.raised, plain.raised], [true, true, false]);
  const text = digest([raised, kept, plain], { since: '2026-10-14', until: '2026-10-21' });
  assert.match(text, /- Reviewer raised to tier 3 \(label raised\), by repository: o\/r 2, o\/s 0\n/);
  assert.match(digest([], { since: 'a', until: 'b' }), /by repository: no tasks\n/);
});

test('the digest counts raised on task rows, the rows it is made of', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const raised = rowOf('o/r', pr({ number: 8, labels: { nodes: [{ name: 'raised' }] } }), opts);
  const plain = rowOf('o/r', pr({ number: 9 }), opts);
  const task = ledger.taskRow('o/r', issue({}), [raised, plain]);
  assert.equal(task.raised, true);
  assert.equal(ledger.taskRow('o/r', issue({ number: 4 }), [plain]).raised, false);
  assert.match(digest([task, ledger.taskRow('o/s', issue({ number: 5 }), [])], { since: 'a', until: 'b' }), /by repository: o\/r 1, o\/s 0\n/);
});

// Reverted pull requests (#83): a body line `Reverts #N` or `Reverts o/r#N`, or the title `Revert "<title>"`.
const revertPeriod = { since: '2026-10-14', until: '2026-10-21' };
const mergedPR = (number, title, mergedAt, body = '') => pr({ number, title, body, mergedAt, state: 'MERGED' });
const revertRows = (...prs) => prs.map((p) => rowOf('o/r', p, { human: 'boss', costs: null, profile: false }));
const countOf = (rows, period = revertPeriod) => {
  const c = ledger.revertCount(rows, period);
  return { n: c.n, k: c.k, m: c.m, reverted: c.reverted.map((p) => `${p.repo}#${p.number}`) };
};

test('a revert names its pull request in a body line, with or without the repository', () => {
  const rows = revertRows(
    mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'),
    mergedPR(2, 'Add B', '2026-10-15T11:00:00Z'),
    mergedPR(3, 'Add C', '2026-10-15T12:00:00Z'),
    mergedPR(4, 'Undo A', '2026-10-16T10:00:00Z', 'Why.\n\nReverts #1\n'),
    mergedPR(5, 'Undo B', '2026-10-16T11:00:00Z', 'Reverts o/r#2'),
  );
  assert.deepEqual(countOf(rows), { n: 3, k: 2, m: 2, reverted: ['o/r#1', 'o/r#2'] });
});

test('a revert that names a pull request of another repository reverts none of this one, and counts as an ordinary pull request', () => {
  const rows = revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Other', '2026-10-16T10:00:00Z', 'Reverts x/y#1'));
  assert.deepEqual(countOf(rows), { n: 2, k: 0, m: 0, reverted: [] });
});

test('a revert whose title is Revert "<title of N>" and no body line reverts the merged pull request of that title', () => {
  const rows = revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Revert "Add A"', '2026-10-16T10:00:00Z', 'No line here.'), mergedPR(3, 'Revert "Never merged"', '2026-10-16T11:00:00Z'));
  assert.deepEqual(countOf(rows), { n: 2, k: 1, m: 1, reverted: ['o/r#1'] });
});

test('the body line wins over the title, and one revert can revert several pull requests', () => {
  const rows = revertRows(
    mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'),
    mergedPR(2, 'Add B', '2026-10-15T11:00:00Z'),
    mergedPR(3, 'Add C', '2026-10-15T12:00:00Z'),
    mergedPR(4, 'Revert "Add A"', '2026-10-16T10:00:00Z', 'Reverts #2\nReverts #3'),
  );
  assert.deepEqual(countOf(rows), { n: 3, k: 2, m: 1, reverted: ['o/r#2', 'o/r#3'] });
});

test('a revert merged after the period, or still open, reverts nothing yet', () => {
  const rows = revertRows(
    mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'),
    mergedPR(2, 'Add B', '2026-10-15T11:00:00Z'),
    mergedPR(3, 'Undo A', '2026-10-22T10:00:00Z', 'Reverts #1'),
    pr({ number: 4, title: 'Undo B', body: 'Reverts #2' }),
  );
  assert.deepEqual(countOf(rows), { n: 2, k: 0, m: 0, reverted: [] });
});

test('a period with no merged pull request has no rate and no reverts', () => {
  assert.deepEqual(countOf([]), { n: 0, k: 0, m: 0, reverted: [] });
  assert.deepEqual(countOf(revertRows(pr({ number: 1 }))), { n: 0, k: 0, m: 0, reverted: [] });
});

test('a task row keeps the pull requests of its rows for the count', () => {
  const [a, b] = revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Undo A', '2026-10-16T10:00:00Z', 'Reverts #1'));
  const task = ledger.taskRow('o/r', issue({}), [a, b]);
  assert.deepEqual(countOf([task]), { n: 1, k: 1, m: 1, reverted: ['o/r#1'] });
  assert.deepEqual(countOf([task, a, b]), { n: 1, k: 1, m: 1, reverted: ['o/r#1'] });
});

test('the digest has a line PRs reverted, with the reverts merged in the period, the reverted numbers and a legend', () => {
  const rows = revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Add B', '2026-10-15T11:00:00Z'), mergedPR(3, 'Undo A', '2026-10-16T10:00:00Z', 'Reverts o/r#1'));
  const text = digest(rows, revertPeriod);
  assert.match(text, /\n- PRs reverted: 1\/2 \(50\.0%; 95% CI: [^)]*\); reverts merged in the period: 1\n- Reverted PRs: o\/r#1\n/);
  assert.match(text, /\nRevert: a merged PR whose body has a line "Reverts #N"/);
});

test('the digest prints a period with no merged pull request like the other zero rates', () => {
  const text = digest([], { since: '2026-10-14', until: '2026-10-21' });
  assert.match(text, /\n- PRs reverted: none yet \(n=0\); reverts merged in the period: 0\n/);
  assert.doesNotMatch(text, /Reverted PRs:/);
});

test('the revert lines follow Tasks merged and its sub-rate, and name none when no pull request was reverted', () => {
  const lines = (rows) => digest(rows, revertPeriod).split('\n');
  const k1 = lines(revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Undo A', '2026-10-16T10:00:00Z', 'Reverts #1')));
  const at = (ls, text) => ls.findIndex((l) => l.startsWith(text));
  assert.equal(at(k1, '- Merged tasks the Human had to touch') - at(k1, '- Tasks merged'), 1);
  assert.equal(at(k1, '- PRs reverted') - at(k1, '- Merged tasks the Human had to touch'), 1);
  assert.equal(at(k1, '- Reverted PRs') - at(k1, '- PRs reverted'), 1);
  const k0 = lines(revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z')));
  assert.equal(k0[at(k0, '- PRs reverted') + 1], '- Reverted PRs: none');
});

// Cases a reviewer of #83 probed by hand: these pin behaviour that already works.
test('a pull request reverted twice counts once in k, and both reverts count in m', () => {
  const rows = revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Undo A', '2026-10-16T10:00:00Z', 'Reverts #1'), mergedPR(3, 'Undo A again', '2026-10-17T10:00:00Z', 'Reverts #1'));
  assert.deepEqual(countOf(rows), { n: 1, k: 1, m: 2, reverted: ['o/r#1'] });
});

test('a revert of a revert is a revert, not a pull request in n; the first stays counted as reverted', () => {
  const rows = revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Undo A', '2026-10-16T10:00:00Z', 'Reverts #1'), mergedPR(3, 'Land A again', '2026-10-17T10:00:00Z', 'Reverts #2'));
  assert.deepEqual(countOf(rows), { n: 1, k: 1, m: 2, reverted: ['o/r#1'] });
});

test('the period holds its first and its last second, and not the second on either side', () => {
  const at = (merged) => countOf(revertRows(mergedPR(1, 'Add A', merged)));
  assert.equal(at('2026-10-14T00:00:00Z').n, 1);
  assert.equal(at('2026-10-13T23:59:59Z').n, 0);
  assert.equal(at('2026-10-21T23:59:59Z').n, 1);
  assert.equal(at('2026-10-22T00:00:00Z').n, 0);
  const revertAt = (merged) => countOf(revertRows(mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'), mergedPR(2, 'Undo A', merged, 'Reverts #1')));
  assert.deepEqual(revertAt('2026-10-21T23:59:59Z'), { n: 1, k: 1, m: 1, reverted: ['o/r#1'] });
  assert.deepEqual(revertAt('2026-10-22T00:00:00Z'), { n: 1, k: 0, m: 0, reverted: [] });
});

test('a title revert reverts the latest merged pull request of that title merged before it', () => {
  const rows = revertRows(
    mergedPR(1, 'Add A', '2026-10-15T10:00:00Z'),
    mergedPR(2, 'Add A', '2026-10-16T10:00:00Z'),
    mergedPR(3, 'Revert "Add A"', '2026-10-17T10:00:00Z'),
    mergedPR(4, 'Add A', '2026-10-18T10:00:00Z'),
  );
  assert.deepEqual(countOf(rows), { n: 3, k: 1, m: 1, reverted: ['o/r#2'] });
});

test('the drill of #83 as recorded: factory-scratch#57 reverts #56', () => {
  const drill = (number, title, body, createdAt, mergedAt) => pr({ number, title, body, createdAt, mergedAt, state: 'MERGED', labels: { nodes: [{ name: 'tier-1' }] } });
  const rows = [
    drill(56, 'Add a README line for the revert drill (factory#83)', 'The change for the revert drill of tuannd9288/factory#83: one line in `README.md`. Its revert, the next pull request, is what the drill times.\n\nNo-red: a README line only; no behaviour changes, so no test can fail first.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n', '2026-10-25T20:44:12Z', '2026-10-25T20:44:32Z'),
    drill(57, 'Revert the README line of the revert drill (factory#83)', 'Reverts #56.\n\nThe revert drill of tuannd9288/factory#83: `git revert -m 1` of #56\'s merge commit, through the gate like any change. The drill times it from the decision to revert to this merge.\n\nNo-red: a revert of a README line; no behaviour changes, so no test can fail first.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n', '2026-10-25T20:45:48Z', '2026-10-25T20:46:15Z'),
  ].map((p) => rowOf('tuannd9288/factory-scratch', p, { human: 'boss', costs: null, profile: false }));
  const c = ledger.revertCount(rows, { since: '2026-10-19', until: '2026-10-26' });
  assert.deepEqual([c.n, c.k, c.m], [1, 1, 1]);
  assert.deepEqual(c.reverted, [{ repo: 'tuannd9288/factory-scratch', number: 56 }]);
});
