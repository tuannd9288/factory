// bin/seat (#91): what the command refuses or resolves before it starts anything (review of #91, #1, #3, #4, #6, #9). A refusal
// exits 2 and starts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fill, until, world } from './seat-world.mjs';

const started = (w) => readdirSync(w.run).filter((n) => n !== 'BRIEF.md' && n !== '.gh-empty');

test('a value of --allow, --add-dir or --resume that starts with a dash is refused, so it cannot become a flag of claude', () => world((w) => {
  for (const extra of [['--allow', '--model'], ['--allow', '--permission-mode'], ['--add-dir', '--x'], ['--resume', '--dangerously-skip-permissions', '--seat', '2']]) {
    const r = w.start('worker', extra);
    assert.equal(r.code, 2, `${extra.join(' ')}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`${extra[0]} .*starts with a dash`));
  }
  assert.deepEqual(started(w), []);
}));

test('a pid file that is empty or not a number is not a live session: it does not count, and its tag is free', () => world(async (w) => {
  const { liveCount } = await import('../bin/lib/seat.mjs');
  for (const [i, text] of ['', '\n', 'abc', '0', '-1'].entries()) writeFileSync(join(w.run, `run-bad${i}.pid`), text);
  assert.equal(liveCount(w.runs, 2), 0);
  const r = w.start('worker', ['--tag', 'bad0']);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
}));

test('a relative FACTORY_STATE, AGENT_PROFILES and FACTORY_RUNS are resolved against the caller\'s folder, not the work folder', () => world(async (w) => {
  const r = w.start('worker', ['--resume', 'sid-1', '--seat', '1', '--tag', 'rel'], { FACTORY_STATE: 'state', AGENT_PROFILES: 'profiles', FACTORY_RUNS: 'runs' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record in the state folder');
  assert.equal(w.saw().env.config, join(realpathSync(w.profiles), 'seats/1/claude'));
  assert.equal(w.saw().env.token.length > 0, true);
  assert.deepEqual(readdirSync(w.work), [], 'nothing was written in the work folder');
}));

test('a seat that is not 1 or 2 is refused with exit 2, an Object.prototype name included', () => world((w) => {
  for (const seat of ['3', '0', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = w.start('worker', ['--resume', 'sid-1', '--seat', seat]);
    assert.equal(r.code, 2, `${seat}: ${r.out}${r.err}`);
    assert.match(r.err, /does not exist/);
  }
  assert.deepEqual(started(w), []);
}));

test('the researcher never runs on seat 1 (the Lead\'s proposal, not yet the Human\'s word): --seat 1 is refused, and a full seat 2 is no reason to fall to seat 1', () => world((w) => {
  const pinned = w.start('researcher', ['--seat', '1']);
  assert.equal(pinned.code, 2, pinned.out + pinned.err);
  assert.match(pinned.err, /researcher/);
  fill(w, 2, 4);
  const full = w.start('researcher');
  assert.equal(full.code, 2, full.out + full.err);
  assert.match(full.err, /seat 2: 4 live sessions/);
  assert.doesNotMatch(full.err, /seat 1/);
  assert.deepEqual(started(w).filter((n) => !n.startsWith('run-fill')), []);
  assert.equal(w.start('worker').code, 0, 'a worker still falls to seat 1');
}));
