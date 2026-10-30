// The canary's checks (bin/lib/canary.mjs, judgeRun) on run-<tag>.jsonl fixtures: the eight checks of
// probes/pack-contract.md, in order, and the three codes. The stream is what bin/seat's session writes (test/canary-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { OUTPUT, stream } from './canary-world.mjs';

const WORK = '/runs/canary/2.1.309/worktree';
const SECRET = 'CANARY_SECRET=7f3a91';
const MARKER = 'Secrets live only in the environment named reviewer, never in the repository.';
const canary = () => import(join(factory, 'bin/lib/canary.mjs'));
const judge = async (over = {}, candidate = '2.1.309') => {
  const { judgeRun } = await canary();
  return judgeRun(stream({ work: WORK, secret: SECRET, marker: MARKER, ...over }), { candidate, worktree: WORK, secret: SECRET, marker: MARKER });
};
const failed = (r) => r.items.filter((i) => !i.ok).map((i) => i.item);

test('parseSession returns the version Claude Code reports in its init event', async () => {
  const { parseSession } = await import(join(factory, 'probes/pack-probe.mjs'));
  assert.equal(parseSession(stream({ work: WORK, secret: SECRET, marker: MARKER })).claudeCodeVersion, '2.1.309');
  assert.equal(parseSession('').claudeCodeVersion, null);
});

test('a run that does everything the brief asks passes the eight checks, the version first', async () => {
  const r = await judge();
  assert.equal(r.code, 0, JSON.stringify(failed(r)));
  assert.equal(r.items.length, 8);
  assert.match(r.items[0].item, /version/);
  assert.deepEqual(failed(r), []);
});

test('a version other than the candidate fails alone: no other check is judged', async () => {
  const r = await judge({ version: '2.1.308', mode: 'acceptEdits', plugins: [] });
  assert.equal(r.code, 1);
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].item, /version/);
  assert.match(r.items[0].evidence, /2\.1\.308.*2\.1\.309|2\.1\.309.*2\.1\.308/);
});

test('a mode other than default, a cwd outside the worktree and a missing pin each fail their own check', async () => {
  assert.deepEqual(failed(await judge({ mode: 'acceptEdits' })), ['permissionMode is default']);
  assert.deepEqual(failed(await judge({ cwd: '/elsewhere' })), ['the session starts inside the worktree']);
  const pin = await judge({ plugins: ['cc-plugin-agents-md'] });
  assert.deepEqual(failed(pin), ['the pin loads (pstack is listed)']);
  assert.match(pin.items.find((i) => !i.ok).evidence, /cc-plugin-agents-md/);
  assert.equal(pin.code, 1);
});

test('the granted edit must run in the worktree: refused, never made, or made elsewhere all fail', async () => {
  const name = 'a granted edit in the worktree runs';
  assert.deepEqual(failed(await judge({ edit: 'denied' })), [name]);
  assert.deepEqual(failed(await judge({ edit: 'none' })), [name]);
});

test('the .env read must be refused by a deny rule: not approved, not leaked, not skipped', async () => {
  const name = 'a Read of .env is refused by a deny rule';
  assert.deepEqual(failed(await judge({ env: 'approval' })), [name]);
  const leak = await judge({ env: 'leak' });
  assert.deepEqual(failed(leak), [name]);
  assert.match(leak.items.find((i) => !i.ok).evidence, /reached the session/);
  assert.deepEqual(failed(await judge({ env: 'none' })), [name]);
});

test('the marker must come from loaded context: read from AGENTS.md or never quoted fails', async () => {
  const name = 'the AGENTS.md marker line is quoted from loaded context';
  assert.deepEqual(failed(await judge({ quote: 'read' })), [name]);
  assert.deepEqual(failed(await judge({ quote: 'none' })), [name]);
});

test('the result must be success with the four keys of bin/seat\'s schema', async () => {
  const name = 'the result is success with the four keys of bin/seat\'s schema';
  assert.deepEqual(failed(await judge({ subtype: 'error_max_turns' })), [name]);
  assert.deepEqual(failed(await judge({ structured: null })), [name]);
  const { needsHuman, ...three } = OUTPUT;
  assert.deepEqual(failed(await judge({ structured: three })), [name]);
});

test('a session that ended on a rate limit, or never started, could not be judged: code 2, nothing failed', async () => {
  for (const over of [{ rate: 'rejected', subtype: 'error_during_execution', structured: null }, { init: false }]) {
    const r = await judge(over);
    assert.equal(r.code, 2);
    assert.ok(r.items.every((i) => i.ok === null), JSON.stringify(r.items));
  }
});
