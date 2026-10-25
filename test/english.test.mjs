// #98: what the factory's own code writes is English, and no rule asks for Vietnamese. Each output is rendered from
// fixtures and scanned for a Vietnamese letter; the tracked files are scanned too, apart from three places that keep
// Vietnamese on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIETNAMESE, VIETNAMESE_ONLY } from './helpers.mjs';
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

test('the pull request template is English, with the fields the kit pull request body also uses', () => {
  const template = readFileSync(join(root, 'kit/.github/pull_request_template.md'), 'utf8');
  assert.doesNotMatch(template, VIETNAMESE);
  assert.match(template, /^## Summary for the Human$/m);
  const fields = [...template.matchAll(/^- ([A-Za-z ]+): /gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['Purpose', 'Change', 'Evidence', 'Tier', 'Rollback', 'Needs the Human']);
  assert.match(template, /No-red: <reason, at least 20 characters>/);
});

/** The places that keep Vietnamese on purpose: a quote of the Human, and test input. A line in `lines` is allowed when
 * it starts with the text given; a file with `all` is allowed whole. */
const KEEPS_VIETNAMESE = [
  { file: 'AGENTS.md', lines: '- **K1, 2026-10-21 (the Human: "' },
  { file: 'probes/probes.sh', all: true },
  { file: 'test/claude-reviewer.test.mjs', lines: "    const claim = '" },
];

const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const textOf = (file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }
};

test('no tracked file holds a Vietnamese letter, apart from the three places that keep it on purpose', () => {
  const found = [];
  for (const file of tracked()) {
    const keep = KEEPS_VIETNAMESE.find((k) => k.file === file);
    if (keep?.all) continue;
    const text = textOf(file);
    if (text === null || text.includes('\0')) continue;
    text.split('\n').forEach((line, i) => {
      if (VIETNAMESE_ONLY.test(line) && !(keep && line.startsWith(keep.lines))) found.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
  // The allowlist is exact: each place it names still holds Vietnamese, so a stale entry is dropped.
  for (const keep of KEEPS_VIETNAMESE) assert.match(textOf(keep.file), VIETNAMESE_ONLY, keep.file);
});

test('no rule or script of the factory asks for Vietnamese', () => {
  const found = tracked().filter((file) => {
    if (/^(test|probes)\//.test(file)) return false;
    const text = textOf(file);
    return text !== null && /Vietnamese/i.test(text);
  });
  assert.deepEqual(found, []);
});

test('the digest and the ledger name no language: neither the rules about them nor their code ask for Vietnamese', () => {
  for (const file of ['AGENTS.md', 'bin/factory-ledger', 'bin/lib/ledger.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /Vietnamese/i, file);
  }
});
