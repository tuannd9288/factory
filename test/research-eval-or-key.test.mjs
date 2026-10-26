// The research eval's keys (#92, re-review 3): `orIsAnswer` is a phrase, so a key that holds `true` (the old form, which now means
// no phrase) or a phrase that does not compile is refused, not silently read as "no phrase".
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('validateTask refuses an orIsAnswer that is not a pattern that compiles', async () => {
  const { loadTasks, validateTask } = await import('../probes/research-eval/keys.mjs');
  const task = structuredClone(loadTasks().find((t) => t.id === 'small-tools'));
  assert.deepEqual(validateTask(task), []);
  for (const bad of [true, false, 1, '(', ['or newer']]) {
    const t = structuredClone(task);
    t.facts[4].orIsAnswer = bad;
    assert.match(validateTask(t).join('; '), /F5: orIsAnswer/, String(bad));
  }
  const without = structuredClone(task);
  delete without.facts[4].orIsAnswer;
  assert.deepEqual(validateTask(without), []);
});
