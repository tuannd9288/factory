// bin/seat (#91): the record of a run that has several result events. `claude -p` emits a result for each query, and a
// background task that ends starts another (review of #91, B3). Turns and duration are summed; the cost, which is cumulative,
// and the subtype come from the last result; the structured output from the last result that has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, world } from './seat-world.mjs';

test('two result events: turns and duration summed, cost and subtype from the last, the report from the last that has one', () => world(async (w) => {
  const r = w.start('worker', ['--tag', 'two'], { FAKE_MODE: 'two' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.equal(rec.turns, 9);
  assert.equal(rec.duration_ms, 1734);
  assert.equal(rec.total_cost_usd, 2.5);
  assert.equal(rec.ended, 'error_max_turns');
  assert.deepEqual(rec.structured, { conclusion: 'done', evidence: ['a'], couldNotRead: [], needsHuman: [] });
}));
