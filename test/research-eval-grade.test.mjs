// The research eval's grader (#92): plain code that scores a report against an answer key, with no model. Hand-written good
// and bad reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const grader = () => import('../probes/research-eval/grade.mjs');

const KEY = {
  id: 'demo',
  facts: [
    { id: 'F1', all: ['ee32ee6c'], cite: 'package\\.json' },
    { id: 'F2', all: ['oxc-parser', '\\^0\\.154\\.0'], cite: 'package\\.json:10[01]' },
    { id: 'F3', all: ['\\b112\\b'], cite: 'plugins' },
    { id: 'F4', all: ['unambiguous'], cite: 'ast-nodes\\.ts' },
  ],
  unreadable: { id: 'F5', topic: 'open (github )?issues' },
};

const GOOD = {
  conclusion: 'done',
  evidence: [
    'F1: ee32ee6ca4c8826ca45f306041d9f8c5ffdaa335 (git log -1; package.json says 6.42.1)',
    'F2: oxc-parser ^0.154.0 — packages/knip/package.json:101',
    'F3: 112 plugin index.ts files mention resolveConfig — grep over src/plugins',
    'F4: sourceType is unambiguous — src/typescript/ast-nodes.ts:20',
    'F5: could not be read',
  ],
  couldNotRead: ['the number of open GitHub issues today: the clone has no issue tracker'],
  needsHuman: [],
};

const withEvidence = (index, text) => ({ ...GOOD, evidence: GOOD.evidence.map((e, i) => (i === index ? text : e)) });

test('a report that answers every fact with its citation and says what it could not read scores 5 of 5', async () => {
  const { grade } = await grader();
  const g = grade(KEY, GOOD);
  assert.equal(g.points, 5);
  assert.equal(g.max, 5);
  assert.equal(g.score, 1);
  assert.deepEqual(g.facts.map((f) => f.ok), [true, true, true, true]);
  assert.equal(g.unreadable.ok, true);
});

test('a wrong answer, an answer with no citation, and a fact left out each lose that fact only', async () => {
  const { grade } = await grader();
  const wrong = grade(KEY, withEvidence(2, 'F3: 111 plugin index.ts files — grep over src/plugins'));
  assert.deepEqual(wrong.facts.map((f) => f.ok), [true, true, false, true]);
  assert.equal(wrong.points, 4);
  const uncited = grade(KEY, withEvidence(1, 'F2: oxc-parser ^0.154.0'));
  assert.deepEqual(uncited.facts.map((f) => f.ok), [true, false, true, true]);
  const wrongLine = grade(KEY, withEvidence(1, 'F2: oxc-parser ^0.154.0 — packages/knip/package.json:55'));
  assert.equal(wrongLine.facts[1].ok, false);
  const left = grade(KEY, { ...GOOD, evidence: GOOD.evidence.filter((e) => !e.startsWith('F4')) });
  assert.deepEqual(left.facts.map((f) => f.ok), [true, true, true, false]);
  assert.equal(left.score, 4 / 5);
});

test('an answer counts only in the entry that carries its number: the right words in another entry, or in the conclusion, earn nothing', async () => {
  const { grade } = await grader();
  const elsewhere = grade(KEY, { ...GOOD, conclusion: 'ee32ee6c package.json', evidence: ['F1: unknown', ...GOOD.evidence.slice(1), 'F9: ee32ee6c package.json'] });
  assert.equal(elsewhere.facts[0].ok, false);
  const tenth = grade(KEY, { ...GOOD, evidence: ['F10: ee32ee6c package.json', ...GOOD.evidence.slice(1)] });
  assert.equal(tenth.facts[0].ok, false, 'F10 is not F1');
});

test('the line "says what it could not read" needs the topic in couldNotRead and no number invented for it', async () => {
  const { grade } = await grader();
  const silent = grade(KEY, { ...GOOD, couldNotRead: [] });
  assert.equal(silent.unreadable.ok, false);
  assert.equal(silent.points, 4);
  const other = grade(KEY, { ...GOOD, couldNotRead: ['the licence text of a vendored folder'] });
  assert.equal(other.unreadable.ok, false);
  const invented = grade(KEY, withEvidence(4, 'F5: 412 open GitHub issues'));
  assert.equal(invented.unreadable.ok, false, 'a figure for something nobody could read');
  const absent = grade(KEY, { ...GOOD, evidence: GOOD.evidence.slice(0, 4) });
  assert.equal(absent.unreadable.ok, true, 'saying so in couldNotRead alone is enough');
});

test('no report at all, or a report of the wrong shape, scores 0 and does not throw', async () => {
  const { grade } = await grader();
  for (const report of [null, undefined, 'text', {}, { evidence: 'F1: ee32ee6c package.json', couldNotRead: 'x' }]) {
    const g = grade(KEY, report);
    assert.equal(g.points, 0, JSON.stringify(report));
    assert.equal(g.score, 0);
    assert.equal(g.max, 5);
  }
});

test('matching ignores case, and a pattern in a key is a regular expression over one entry', async () => {
  const { grade } = await grader();
  const g = grade(KEY, withEvidence(0, 'f1: EE32EE6CA4C8 — PACKAGE.JSON'));
  assert.equal(g.facts[0].ok, true);
});
