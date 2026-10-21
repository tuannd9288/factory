// The ledger's arithmetic and its reading of pull requests and session files, on fixtures; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchCosts, costOf, digest, rate, rowOf, wilson } from '../bin/lib/ledger.mjs';

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
const green = ['verify', 'rules', 'red-check', 'verify-trusted', 'review', 'verdict'].map((n) => run(n, 'SUCCESS'));
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
  assert.match(text, /2 việc \(mỗi việc một PR\): 1 đã merge, 1 đang mở, 0 bỏ/);
  assert.match(text, /o\/r#1 Limit sends — bậc 3, chờ anh duyệt/);
  assert.match(text, /Việc đã merge: 1\/2 \(50,0%; KTC 95%: /);
  assert.match(text, /anh phải chạm: 0\/1 /);
  assert.match(text, /Xanh ngay ở commit đầu tiên được chấm: 1\/1 /);
  assert.match(text, /\| \? \(không có profile\) \|/);
});

test('the queue updates the oldest pull request left behind, one at a time', async () => {
  const { pickUpdate } = await import('../bin/lib/queue.mjs');
  const p = (number, createdAt, mergeStateStatus, over = {}) => ({ number, createdAt, mergeStateStatus, autoMerge: true, isDraft: false, checks: 'SUCCESS', ...over });
  assert.equal(pickUpdate([p(2, '2026-10-21T02', 'BEHIND'), p(1, '2026-10-21T01', 'BEHIND'), p(3, '2026-10-21T00', 'BEHIND', { autoMerge: false })]).number, 1);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND'), p(2, '2026-10-21T02', 'BLOCKED', { checks: 'PENDING' })]), null);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'BEHIND'), p(2, '2026-10-21T02', 'BLOCKED', { checks: 'FAILURE' })]).number, 1);
  assert.equal(pickUpdate([p(1, '2026-10-21T01', 'CLEAN')]), null);
});
