// The research eval's ten tasks (#92): the set is whole, each key is well formed, and each key's own example of a correct
// entry earns its point while a report that answers nothing earns only the "could not read" line at best.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mods = async () => ({ ...(await import('../probes/research-eval/keys.mjs')), ...(await import('../probes/research-eval/grade.mjs')) });

test('there are ten tasks, with distinct ids, each of a valid shape, over the four run folders of #17, #58, #68 and #70', async () => {
  const { loadTasks, validateTask } = await mods();
  const tasks = loadTasks();
  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 10);
  for (const t of tasks) assert.deepEqual(validateTask(t), [], t.id);
  const folders = new Set(tasks.flatMap((t) => t.sources));
  assert.deepEqual([...folders].sort(), ['issue-17', 'issue-58', 'issue-68', 'issue-70']);
});

test('a fact\'s example entry satisfies its own key, so every key can be met', async () => {
  const { loadTasks, grade } = await mods();
  assert.ok(loadTasks().length > 0, 'no tasks to grade');
  for (const t of loadTasks()) {
    const report ={ conclusion: 'c', evidence: [...t.facts.map((f) => f.example), `${t.unreadable.id}: not readable`], couldNotRead: [t.unreadable.example], needsHuman: [] };
    const g = grade(t, report);
    assert.deepEqual(g.facts.filter((f) => !f.ok), [], t.id);
    assert.equal(g.unreadable.ok, true, t.id);
    assert.equal(g.score, 1, t.id);
  }
});

test('a report that guesses fails every fact of every task, and one that says nothing scores 0', async () => {
  const { loadTasks, grade } = await mods();
  assert.ok(loadTasks().length > 0, 'no tasks to grade');
  for (const t of loadTasks()) {
    const guess = { conclusion: 'c', evidence: t.facts.map((f) => `${f.id}: I do not know`), couldNotRead: [t.unreadable.example], needsHuman: [] };
    const g = grade(t, guess);
    assert.equal(g.facts.filter((f) => f.ok).length, 0, t.id);
    assert.equal(g.points, 1, t.id);
    assert.equal(grade(t, { conclusion: '', evidence: [], couldNotRead: [], needsHuman: [] }).points, 0, t.id);
  }
});
