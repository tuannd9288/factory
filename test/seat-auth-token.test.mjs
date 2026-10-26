// bin/seat (#91): the caller's ANTHROPIC_AUTH_TOKEN, another credential Claude Code reads, does not reach claude (review 2 of
// #91, item 11). seat-env.test.mjs holds the three the first brief named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, world } from './seat-world.mjs';

test('the caller\'s ANTHROPIC_AUTH_TOKEN does not reach claude, on either seat', () => world(async (w) => {
  for (const [seat, tag] of [['2', 'two'], ['1', 'one']]) {
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', seat, '--tag', tag], { ANTHROPIC_AUTH_TOKEN: 'auth-fake', FAKE_OUT: w.out(tag) });
    assert.equal(r.code, 0, r.out + r.err);
  }
  await until(() => w.records().length === 2, 'both records');
  for (const tag of ['two', 'one']) assert.equal(w.saw(tag).env.ANTHROPIC_AUTH_TOKEN, false, tag);
}));
