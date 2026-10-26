// The research eval's task over #17's round-4 review (#92, review of the build): one fact is #17's "2, 6 and 6", the lines that
// a2f6aa4 removes, by the commit that wrote each (`git blame` at aedffb0), in place of a fact copied from the review's own text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mods = async () => ({ ...(await import('../probes/research-eval/keys.mjs')), ...(await import('../probes/research-eval/grade.mjs')) });

const task = async () => (await mods()).loadTasks().find((t) => t.id === 'round4-review');
const blameFact = (t) => t.facts.find((f) => f.source.blame !== undefined);

test('round4-review has five facts and one of them is the blame of the 14 removed lines: 2, 6 and 6', async () => {
  const t = await task();
  assert.equal(t.facts.length, 5);
  const f = blameFact(t);
  assert.ok(f, 'a fact with a blame source');
  const lines = f.source.ranges.reduce((n, [from, to]) => n + (to - from + 1), 0);
  assert.equal(lines, 14);
  assert.ok(t.readable.some((r) => `${f.source.blame}/`.startsWith(`${r}/`)), 'the repository is readable');
});

test('its example scores; a count given to the wrong commit, or counts with no commit, do not', async () => {
  const { grade } = await mods();
  const t = await task();
  const f = blameFact(t);
  const run = (entry) => grade(t, { conclusion: 'c', evidence: [...t.facts.map((x) => (x.id === f.id ? entry : x.example)), `${t.unreadable.id}: not readable`], couldNotRead: [t.unreadable.example], needsHuman: [] }).facts.find((x) => x.id === f.id).ok;
  assert.equal(run(f.example), true);
  assert.equal(run(`${f.id}: 2 from 355029d, 6 from af5c818 and 6 from 82a1548 — rev4/REVIEW.md:171`), true, 'the count before the commit');
  assert.equal(run(`${f.id}: 355029d 6, af5c818 2, 82a1548 6 — rev4/REVIEW.md:171`), false);
  assert.equal(run(`${f.id}: 2, 6 and 6 — rev4/REVIEW.md:171`), false);
  assert.equal(run(`${f.id}: 355029d 2, af5c818 6, 82a1548 6 — from the review`), false, 'no citation');
});
