// bin/seat (#91): the record is built from the events of the supervisor's own child, never from the log read back by path
// (review 2 of #91, item 2). Another process that writes into run-<tag>.jsonl cannot get into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { until, world } from './seat-world.mjs';

test('a result line another process appends to the log while the session runs is not in the record', () => world(async (w) => {
  const hold = { FAKE_MODE: 'holdafter', FAKE_RELEASE: join(w.fake, 'release') };
  assert.equal(w.start('worker', ['--tag', 'own'], hold).code, 0);
  const log = join(w.run, 'run-own.jsonl');
  await until(() => readFileSync(log, 'utf8').includes('"type":"result"'), 'the session\'s result');
  appendFileSync(log, `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'foreign', num_turns: 99, duration_ms: 1, total_cost_usd: 9.99, structured_output: { conclusion: 'foreign' } })}\n`);
  writeFileSync(hold.FAKE_RELEASE, '');
  await until(() => w.records().length === 1, 'the record');
  const [rec] = w.records();
  assert.equal(rec.session, 'sess-1');
  assert.equal(rec.total_cost_usd, 1.25);
  assert.equal(rec.turns, 7);
  assert.equal(rec.structured.conclusion, 'done');
}));
