// bin/seat (#91): the supervisor decodes claude's stream as a whole, so a multi-byte character cut between two pipe reads
// comes out whole in the record (review 2 of #91, item 1). The Human writes in Vietnamese, so the report does too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, world } from './seat-world.mjs';

test('a result line cut inside a multi-byte character is recorded whole', () => world(async (w) => {
  const r = w.start('worker', ['--tag', 'split'], { FAKE_MODE: 'split' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.records()[0].structured.conclusion, 'Làm (Recommended) — ngưỡng 70%');
}));
