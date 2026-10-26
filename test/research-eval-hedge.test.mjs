// The research eval's grader (#92, review of the build, G1 to G3): a hedged entry scores nothing, a path is not a figure, and
// another wording of a right answer still scores. The wrong and the right entries are the review's own examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mods = async () => ({ ...(await import('../probes/research-eval/keys.mjs')), ...(await import('../probes/research-eval/grade.mjs')) });

const KEY = {
  id: 'demo',
  facts: [
    { id: 'F1', all: ['11\\.24\\.2'], cite: 'package\\.json' },
    { id: 'F2', all: ['no account.{0,30}licen[cs]e'], cite: 'llms', orIsAnswer: true },
    { id: 'F3', all: ['\\b112\\b'], cite: 'plugins' },
    { id: 'F4', all: ['unambiguous'], cite: 'ast-nodes' },
  ],
  unreadable: { id: 'F5', topic: 'open.{0,12}issues' },
};
const report = (evidence, couldNotRead = ['open GitHub issues today']) => ({ conclusion: 'c', evidence, couldNotRead, needsHuman: [] });
const FULL = ['F1: 11.24.2 — package.json:102', 'F2: no account or license checks — llms.txt:3330', 'F3: 112 — src/plugins', 'F4: unambiguous — ast-nodes.ts:20', 'F5: not readable'];
const swap = (i, text) => FULL.map((e, n) => (n === i ? text : e));
const ok = async (key, evidence, index) => (await mods()).grade(key, report(evidence)).facts[index].ok;

test('an answer that offers more than one value, or asks, scores nothing', async () => {
  assert.equal(await ok(KEY, FULL, 0), true);
  for (const hedge of [
    'F1: 11.24.1, 11.24.2 or 11.25.0 — package.json:102',
    'F1: 11.24.2? — package.json:102',
    'F1: between 11.24.0 and 11.24.2 — package.json:102',
    'F1: maybe 11.24.2 — package.json:102',
    'F1: probably 11.24.2 — package.json:102',
    'F1: either 11.24.2 — package.json:102',
  ]) assert.equal(await ok(KEY, swap(0, hedge), 0), false, hedge);
  assert.equal(await ok(KEY, swap(2, 'F3: between 110 and 115 (112?) — src/plugins'), 2), false);
  assert.equal(await ok(KEY, swap(3, "F4: 'module' or 'unambiguous' — ast-nodes.ts:20"), 3), false);
});

test('the hedge is looked for in the answer, before the dash, not in the citation after it', async () => {
  assert.equal(await ok(KEY, swap(0, 'F1: 11.24.2 — packages/knip/package.json:102 (maybe 101?)'), 0), true);
});

test('a key that says "or" belongs to the right answer lets it through, and still refuses the other hedges', async () => {
  assert.equal(await ok(KEY, FULL, 1), true, 'no account or license checks');
  assert.equal(await ok(KEY, swap(1, 'F2: no account or license checks? — llms.txt:3330'), 1), false);
  assert.equal(await ok(KEY, swap(1, 'F2: maybe no account or license checks — llms.txt:3330'), 1), false);
});

test('a path or a hash in the entry for the unreadable question is not a figure; a figure still is', async () => {
  const { grade } = await mods();
  const entry = (text) => grade(KEY, report([...FULL.slice(0, 4), text])).unreadable.ok;
  assert.equal(entry('F5: not readable — no issue tracker under issue-70/sources/knip'), true);
  assert.equal(entry('F5: not readable — nothing in package.json:102 or ee32ee6ca4c8826ca45f306041d9f8c5ffdaa335'), true);
  assert.equal(entry('F5: not readable — the clone issue-70 has no tracker'), true);
  assert.equal(entry('F5: 412 open issues'), false);
  assert.equal(entry('F5: about 4.2k, not readable — issue-70/sources/knip'), false);
});

test('the review\'s wrong answers lose their fact in the real tasks', async () => {
  const { loadTasks, grade } = await mods();
  const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]));
  const fact = (task, id) => tasks[task].facts.find((f) => f.id === id);
  const scores = (task, id, entry) => grade(tasks[task], report([...tasks[task].facts.map((f) => (f.id === id ? entry : f.example)), `${tasks[task].unreadable.id}: not readable`], [tasks[task].unreadable.example])).facts.find((f) => f.id === id).ok;
  assert.equal(scores('rex-docs', 'F3', fact('rex-docs', 'F3').example), true);
  assert.equal(scores('rex-docs', 'F3', 'F3: Rex collects telemetry; no account or license checks — inputs/raw/rex-llms-full.txt:3329'), false, 'polarity flipped');
  assert.equal(scores('round4-review', 'F4', fact('round4-review', 'F4').example), true);
  assert.equal(scores('round4-review', 'F4', 'F4: 25 of 0 readable; 10 hold a backtick, 15 a / — rev4/REVIEW.md:236'), false, 'numbers swapped');
  assert.equal(scores('knip-reader', 'F1', 'F1: ee32ee6ca4c8826ca45f306041d9f8c5ffdaa335 — from GitHub'), false, 'a source is not a command');
});

test('other words for a right answer still score', async () => {
  const { loadTasks, grade } = await mods();
  const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]));
  const scores = (task, id, entry) => grade(tasks[task], report([...tasks[task].facts.map((f) => (f.id === id ? entry : f.example)), `${tasks[task].unreadable.id}: not readable`], [tasks[task].unreadable.example])).facts.find((f) => f.id === id).ok;
  assert.equal(scores('rex-docs', 'F3', "F3: Rex doesn't collect telemetry; no account checks or licence checks — inputs/raw/rex-llms-full.txt:3329-3330"), true);
  assert.equal(scores('small-tools', 'F5', 'F5: Python 3.10 or newer — sources/semble/pyproject.toml:12'), true);
  assert.equal(scores('t3code-defaults', 'F4', 'F4: 15 min — docs/user/mobile-notifications.md:5'), true);
});
