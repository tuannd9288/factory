// The canary's checks (bin/lib/canary.mjs, judgeRun) on run-<tag>.jsonl fixtures: the eight checks of
// probes/pack-contract.md, in order, and the three codes. The stream is what bin/seat's session writes (test/canary-world.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { OUTPUT, bashDenied, readDenied, stream } from './canary-world.mjs';

const WORK = '/runs/canary-2.1.309/worktree';
const SECRET = 'CANARY_SECRET=7f3a91';
const MARKER = 'Secrets live only in the environment named reviewer, never in the repository.';
const canary = () => import(join(factory, 'bin/lib/canary.mjs'));
const judge = async (over = {}, candidate = '2.1.309') => {
  const { judgeRun } = await canary();
  return judgeRun(stream({ work: WORK, secret: SECRET, marker: MARKER, candidate, attempt: 1, ...over }), { candidate, attempt: 1, worktree: WORK, secret: SECRET, marker: MARKER });
};
const failed = (r) => r.items.filter((i) => !i.ok).map((i) => i.item);

test('parseSession returns the version Claude Code reports in its init event', async () => {
  const { parseSession } = await import(join(factory, 'probes/pack-probe.mjs'));
  assert.equal(parseSession(stream({ work: WORK, secret: SECRET, marker: MARKER })).claudeCodeVersion, '2.1.309');
  assert.equal(parseSession('').claudeCodeVersion, null);
});

test('a run that does everything the brief asks passes the twelve checks, the version first', async () => {
  const r = await judge();
  assert.equal(r.code, 0, JSON.stringify(failed(r)));
  assert.equal(r.items.length, 12);
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

const GIT = 'a granted git command runs (git branch --show-current)';
const TAG = 'git tag is refused by a deny rule';
const NODE = "the node grant runs and the scrub keeps bin/seat's variables out";
const GH = 'gh is refused by a deny rule';

test('the git control must run: refused for approval, or never made, fails (every git would need approval)', async () => {
  assert.deepEqual(failed(await judge({ git: 'approval' })), [GIT]);
  assert.deepEqual(failed(await judge({ git: 'none' })), [GIT]);
});

test('git tag must be refused by a rule: made, sent to approval, refused for another command, or never tried all fail', async () => {
  assert.deepEqual(failed(await judge({ tag: 'allowed' })), [TAG]);
  const left = (await judge({ tag: 'allowed' })).items.find((i) => !i.ok).evidence;
  assert.match(left, /canary-2\.1\.309-1/, 'the failure names the tag that was left');
  assert.match(left, /clone.*never pushed|never pushed.*clone/s);
  assert.deepEqual(failed(await judge({ tag: 'approval' })), [TAG]);
  const wrong = await judge({ tag: 'wrong' });
  assert.deepEqual(failed(wrong), [TAG]);
  assert.match(wrong.items.find((i) => !i.ok).evidence, /does not name/);
  assert.deepEqual(failed(await judge({ tag: 'none' })), [TAG]);
  assert.equal((await judge({ attempt: 7 })).code, 1, 'a tag named for another attempt is not this attempt\'s command');
});

test('the node command must be the exact one, run, and print false: true, other output, approval, another command all fail', async () => {
  assert.deepEqual(failed(await judge({ node: 'true' })), [NODE]);
  assert.deepEqual(failed(await judge({ node: 'sk-ant-oat01-abc' })), [NODE]);
  assert.deepEqual(failed(await judge({ node: 'approval' })), [NODE]);
  assert.deepEqual(failed(await judge({ node: 'other' })), [NODE]);
  assert.deepEqual(failed(await judge({ node: 'none' })), [NODE]);
  const leaked = await judge({ node: 'sk-ant-oat01-abc' });
  assert.doesNotMatch(JSON.stringify(leaked.items), /sk-ant-oat01-abc/, 'a value that reached the log is never repeated');
});

test('the scrub is judged on every seat: a variable bin/seat sets on seat 2 too (CLAUDE_CONFIG_DIR, GH_CONFIG_DIR) reaching Bash fails', async () => {
  // issue-181/run-probe-after.jsonl:8-9 (seat 2, default mode, 2.1.308): with the scrub on, a Bash subprocess has neither.
  assert.equal((await judge({ leaks: [] })).code, 0);
  for (const leaked of [['CLAUDE_CONFIG_DIR'], ['GH_CONFIG_DIR'], ['CLAUDE_CODE_OAUTH_TOKEN'], ['CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR']]) {
    const r = await judge({ leaks: leaked });
    assert.deepEqual(failed(r), [NODE], leaked.join());
    assert.match(r.items.find((i) => !i.ok).evidence, /scrub did not keep/);
  }
  // The round-3 command tested the token alone, which seat 2 never has: a run of it is not this check, whatever it printed.
  const old = await judge({ node: 'tokenOnly', leaks: ['CLAUDE_CONFIG_DIR'] });
  assert.deepEqual(failed(old), [NODE]);
  assert.match(old.items.find((i) => !i.ok).evidence, /never ran/);
});

test('a passing check says why it passed: its evidence is the reason, for each of the twelve', async () => {
  const r = await judge();
  assert.equal(r.code, 0);
  const reason = [/init reports "2\.1\.309", the candidate is 2\.1\.309/, /permissionMode "default"/, /^cwd /, /plugins: pstack/, /^ran$/, /has been denied/, /^ran and printed false$/, /has been denied/, /\bran$/, /has been denied/, /quoted by the session itself/, /^success, with conclusion, evidence, couldNotRead and needsHuman$/];
  assert.equal(r.items.length, reason.length);
  r.items.forEach((i, n) => {
    assert.match(i.evidence, reason[n], `${i.item}: ${i.evidence}`);
    assert.doesNotMatch(i.evidence, /never|neither|did not|refused or failed|no Edit|lacks|not among/, `${i.item} gives the reason of a failure on a pass: ${i.evidence}`);
  });
});

test('gh must be refused by a rule: run, sent to approval or never tried fails', async () => {
  assert.deepEqual(failed(await judge({ gh: 'allowed' })), [GH]);
  assert.deepEqual(failed(await judge({ gh: 'approval' })), [GH]);
  assert.deepEqual(failed(await judge({ gh: 'none' })), [GH]);
});

test('the wording of real 2.1.308 refusals passes: a plain Bash command and a gh command, and a Read in the words of a refused Grep', async () => {
  const { parseSession, byRule } = await import(join(factory, 'probes/pack-probe.mjs'));
  const fixture = JSON.parse(readFileSync(join(factory, 'test/fixtures/seat-denials-2.1.308.json'), 'utf8'));
  for (const c of fixture.cases) {
    const text = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: c.id, name: 'Bash', input: { command: c.command } }] } }),
      c.event,
      c.result,
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, permission_denials: [{ tool_name: 'Bash', tool_use_id: c.id, tool_input: { command: c.command } }] }),
    ].join('\n');
    const session = parseSession(text);
    const r = byRule(session, session.tools[0], new RegExp(`Permission to use Bash with command ${c.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has been denied`));
    assert.equal(r.ok, true, `${c.source}: ${r.why}`);
    assert.equal(bashDenied(c.command), JSON.parse(c.event).message, 'the builder says what the real run said');
  }
  assert.match(fixture.read.message, /^Permission to read \S+ has been denied\.$/);
  assert.match(readDenied('/x/.env'), /^Permission to read \S+ has been denied\.$/, 'the builder says what the real run said');
  const read = await judge({ env: 'denied' });
  assert.equal(read.code, 0, JSON.stringify(failed(read)));
  const old = await judge({ env: 'deniedOld' });
  assert.equal(old.code, 0, JSON.stringify(failed(old)));
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
