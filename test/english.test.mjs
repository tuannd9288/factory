// #98: what the factory's own code writes is English, and no rule asks for Vietnamese. Each output is rendered from
// fixtures and scanned for a Vietnamese letter; the tracked files are scanned too, apart from three places that keep
// Vietnamese on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIETNAMESE } from './helpers.mjs';
import { canaryLine, digest, queueState, rate, rowOf, taskRow } from '../bin/lib/ledger.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function inDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'english-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the weekly digest holds no Vietnamese letter, in any section', () => {
  const opts = { human: 'boss', costs: new Map([['priced', { dollars: 1.5, models: new Set(), unpriced: new Set() }], ['limit', { dollars: 2, models: new Set(), unpriced: new Set(['mystery-model']) }]]), profile: true };
  const merged = { mergedAt: '2026-10-20T12:00:00Z', state: 'MERGED', reviews: { nodes: [{ author: { login: 'boss' }, state: 'APPROVED' }] }, timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent' }, { __typename: 'AutoMergeDisabledEvent' }, { __typename: 'MergedEvent' }] } };
  const rows = [
    rowOf('o/r', pr({ number: 1, labels: { nodes: [{ name: 'tier-3' }, { name: 'raised' }] } }), opts),
    rowOf('o/r', pr({ number: 2, ...merged }), opts),
    rowOf('o/r', pr({ number: 3, headRefName: 'priced' }), opts),
    rowOf('o/s', pr({ number: 4, headRefName: 'none' }), opts),
    rowOf('o/s', pr({ number: 5, labels: { nodes: [{ name: 'needs-human' }] } }), { ...opts, profile: false }),
    taskRow('o/s', { number: 6, title: 'Open task', url: 'u', state: 'CLOSED', stateReason: 'NOT_PLANNED', createdAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-20T08:00:00Z', labels: { nodes: [{ name: 'task' }] }, timelineItems: { nodes: [] } }, []),
  ];
  rows[1].livePRs = [{ number: 2, title: 'Limit sends', covered: false }, { number: 3, title: 'x', covered: null }, { number: 4, title: 'y', covered: true }];
  rows[1].codexRuns = 2;
  inDir((dir) => {
    writeFileSync(join(dir, 'queue-run.failed'), '2026-10-24T01:00:00.000Z gh: not logged in\n');
    const queues = [queueState(dir, ['o/app']), queueState(join(dir, 'none'), ['o/app'])];
    mkdirSync(join(dir, 'empty'));
    queues.push(queueState(join(dir, 'empty'), []));
    for (const queue of queues) {
      const text = digest(rows, {
        since: '2026-10-17',
        until: '2026-10-24',
        secrets: new Map([['o/r', ['DEPLOY_KEY']], ['o/s', []], ['o/t', null]]),
        canary: canaryLine({ entries: 5, missing: ['cwd'], stale: ['gitBranch'] }),
        unplaced: { entries: 2, dollars: 1.25 },
        queue,
      });
      assert.doesNotMatch(text, VIETNAMESE);
      assert.match(text, /^# Weekly digest 2026-10-17 → 2026-10-24$/m);
    }
    assert.doesNotMatch(digest([], { since: 'a', until: 'b' }), VIETNAMESE);
  });
  assert.doesNotMatch(rate(0, 0) + rate(1, 4), VIETNAMESE);
});

test('the digest and the ledger name no language: neither the rules about them nor their code ask for Vietnamese', () => {
  for (const file of ['AGENTS.md', 'bin/factory-ledger', 'bin/lib/ledger.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /Vietnamese/i, file);
  }
});
