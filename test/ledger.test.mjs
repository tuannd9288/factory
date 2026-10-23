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
  assert.equal(rate(0, 0), 'chưa có mẫu (n=0)');
  assert.match(rate(1, 4), /^1\/4 \(25,0%; KTC 95%: 4,6%–69,9%\)$/);
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
  assert.equal(rowOf('o/r', pr({ reviews: { nodes: [{ author: { login: 'boss' }, state: 'APPROVED' }] } }), opts).touchedWhy, 'duyệt');
  assert.equal(rowOf('o/r', pr({ labels: { nodes: [{ name: 'needs-human' }] } }), opts).touchedWhy, 'needs-human');
  const manual = rowOf('o/r', pr({ mergedAt: '2026-10-20T11:00:00Z', timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'AutoMergeDisabledEvent' }, { __typename: 'MergedEvent' }] } }), opts);
  assert.equal(manual.touchedWhy, 'merge tay');
  assert.equal(manual.costNote, 'không có profile');
  assert.equal(rowOf('o/r', pr({ reviews: { nodes: [{ author: { login: 'agent' }, state: 'APPROVED' }] } }), opts).touched, false);
});

test('the digest gives every rate with its count, and lists what waits for the Human', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const rows = [
    rowOf('o/r', pr({ number: 1, labels: { nodes: [{ name: 'tier-3' }] } }), opts),
    rowOf('o/r', pr({ number: 2, mergedAt: '2026-10-20T11:00:00Z', commits: { nodes: [commit('a', green)] }, timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'MergedEvent' }] } }), opts),
  ];
  const text = digest(rows, { since: '2026-10-14', until: '2026-10-21', secrets: new Map([['o/r', ['DEPLOY_KEY']], ['o/s', []], ['o/t', null]]) });
  assert.match(text, /- o\/r: DEPLOY_KEY\n- o\/s: 0\n- o\/t: không kiểm được/);
  assert.match(text, /2 việc: 1 đã merge, 1 đang mở, 0 bỏ \(0 bỏ trước khi có PR\)/);
  assert.match(text, /Chi phí tương đương giá API mỗi việc đã merge/);
  assert.match(text, /\nTiền mặt: phí thuê bao Claude, trả theo tháng, không chia theo việc/);
  assert.match(text, /o\/r#1 Limit sends — bậc 3, chờ anh duyệt/);
  assert.match(text, /Việc đã merge: 1\/2 \(50,0%; KTC 95%: /);
  assert.match(text, /anh phải chạm: 0\/1 /);
  assert.match(text, /Xanh ngay ở commit đầu tiên được chấm: 1\/1 /);
  assert.match(text, /\| \? \(không có profile\) \|/);
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
  assert.equal(row.costNote, 'chưa có PR');
  assert.equal(row.firstPass, null);
  const text = digest([row], { since: '2026-10-14', until: '2026-10-21' });
  assert.match(text, /1 việc: 0 đã merge, 0 đang mở, 1 bỏ \(1 bỏ trước khi có PR\)/);
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
  assert.match(text, /- PR đã merge có verdict người kiểm phủ head: 1\/2 \(50,0%; KTC 95%: /);
  assert.match(text, /- Không có verdict phủ: o\/r#2 Limit sends\n/);
  assert.match(text, /- Chưa xác định \(không tính được patch-id trong bản clone\): o\/r#3\n/);
  assert.match(text, /- Lượt chạy Codex: 3 \(thuê bao Codex của người kiểm, trả theo tháng; không có giá API, không chia theo việc\)/);
});

test('the digest counts the pull requests the reviewer raised, per repository', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const raised = rowOf('o/r', pr({ number: 5, timelineItems: { nodes: [{ __typename: 'LabeledEvent', label: { name: 'raised' } }] } }), opts);
  const kept = rowOf('o/r', pr({ number: 6, labels: { nodes: [{ name: 'raised' }, { name: 'tier-3' }] } }), opts);
  const plain = rowOf('o/s', pr({ number: 7 }), opts);
  assert.deepEqual([raised.raised, kept.raised, plain.raised], [true, true, false]);
  const text = digest([raised, kept, plain], { since: '2026-10-14', until: '2026-10-21' });
  assert.match(text, /- Reviewer nâng lên bậc 3 \(nhãn raised\), theo repo: o\/r 2, o\/s 0\n/);
  assert.match(digest([], { since: 'a', until: 'b' }), /theo repo: không có việc\n/);
});

test('the digest counts raised on task rows, the rows it is made of', () => {
  const opts = { human: 'boss', costs: null, profile: false };
  const raised = rowOf('o/r', pr({ number: 8, labels: { nodes: [{ name: 'raised' }] } }), opts);
  const plain = rowOf('o/r', pr({ number: 9 }), opts);
  const task = ledger.taskRow('o/r', issue({}), [raised, plain]);
  assert.equal(task.raised, true);
  assert.equal(ledger.taskRow('o/r', issue({ number: 4 }), [plain]).raised, false);
  assert.match(digest([task, ledger.taskRow('o/s', issue({ number: 5 }), [])], { since: 'a', until: 'b' }), /theo repo: o\/r 1, o\/s 0\n/);
});
