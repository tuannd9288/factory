// bin/seat (#91): which environment holds what. Seat 1's token is in `claude`'s environment only: not in bin/seat's, and not in
// the supervisor's that waits for the session (review of #91, #5). The caller's GitHub and API credentials are not passed on,
// as the gate's reviewer does not (#10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { until, world } from './seat-world.mjs';

const creds = { GH_TOKEN: 'gh-fake', GITHUB_TOKEN: 'ghub-fake', ANTHROPIC_API_KEY: 'key-fake' };

test('seat 1: only claude\'s environment holds the token; the supervisor\'s, which claude can see as its parent, does not', () => world(async (w) => {
  const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'one']);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const saw = w.saw();
  assert.ok(saw.parentSeen, 'the fake could read its parent\'s environment');
  assert.equal(saw.parentHasToken, false);
  assert.equal(saw.env.token.length > 0, true, 'claude has the token');
}));

test('the caller\'s GH_TOKEN, GITHUB_TOKEN and ANTHROPIC_API_KEY do not reach claude, on either seat', () => world(async (w) => {
  for (const [seat, tag] of [['2', 'two'], ['1', 'one']]) {
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', seat, '--tag', tag], { ...creds, FAKE_OUT: w.out(tag) });
    assert.equal(r.code, 0, r.out + r.err);
  }
  await until(() => w.records().length === 2, 'both records');
  for (const tag of ['two', 'one']) assert.deepEqual([w.saw(tag).env.GH_TOKEN, w.saw(tag).env.GITHUB_TOKEN, w.saw(tag).env.ANTHROPIC_API_KEY], [false, false, false], tag);
}));

test('every session runs with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, on either seat, whatever the caller set (#181)', () => world(async (w) => {
  // Claude Code then takes credentials out of the environment of each command, hook and MCP server it starts.
  for (const [seat, tag] of [['2', 'two'], ['1', 'one']]) {
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', seat, '--tag', tag], { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0', FAKE_OUT: w.out(tag) });
    assert.equal(r.code, 0, r.out + r.err);
  }
  await until(() => w.records().length === 2, 'both records');
  for (const tag of ['two', 'one']) assert.equal(w.saw(tag).env.scrub, '1', tag);
}));

test('a researcher session gets FACTORY_RESEARCH_CLONES, the clones folder in its run folder, whatever the caller set (#181)', () => world(async (w) => {
  const r = w.start('researcher', ['--resume', 'sid-1', '--seat', '2', '--tag', 'res'], { FACTORY_RESEARCH_CLONES: '/elsewhere', FAKE_OUT: w.out('res') });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.saw('res').env.clones, join(w.run, 'clones'));
}));
