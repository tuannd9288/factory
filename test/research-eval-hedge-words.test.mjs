// The research eval's grader (#92, re-review 2): an answer that says "I think", "likely" or "possibly" is a hedge, as "maybe" is.
// The entries are the re-review's own examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEY = {
  id: 'demo',
  facts: [
    { id: 'F1', all: ['11\\.24\\.2'], cite: 'package\\.json' },
    { id: 'F2', all: ['\\b112\\b'], cite: 'plugins' },
  ],
  unreadable: { id: 'F3', topic: 'open.{0,12}issues' },
};
const ok = async (entry) => {
  const { grade } = await import('../probes/research-eval/grade.mjs');
  const id = entry.slice(0, 2);
  const evidence = [id === 'F1' ? entry : 'F1: 11.24.2 — package.json:102', id === 'F2' ? entry : 'F2: 112 — src/plugins', 'F3: not readable'];
  return grade(KEY, { conclusion: 'c', evidence, couldNotRead: ['open GitHub issues today'], needsHuman: [] }).facts.find((f) => f.id === id).ok;
};

test('an answer with a word of doubt scores nothing', async () => {
  for (const hedge of [
    'F1: 11.24.2, I think — package.json:102',
    'F1: likely 11.24.2 — package.json:102',
    'F2: 111 to 112, possibly 112 — src/plugins',
    'F1: perhaps 11.24.2 — package.json:102',
    'F1: my guess is 11.24.2 — package.json:102',
    'F2: about 112 — src/plugins',
  ]) assert.equal(await ok(hedge), false, hedge);
});

test('the same words after the dash, in the citation, do not count, and the plain answers score', async () => {
  assert.equal(await ok('F1: 11.24.2 — package.json:102'), true);
  assert.equal(await ok('F2: 112 — docs/about-plugins.md and src/plugins'), true);
});
