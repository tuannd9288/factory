import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, quiet } from './helpers.mjs';
import { appendStart, innAnswer } from '../bin/lib/events.mjs';

test('Colly receives one INN answer across nodes; only its holder can replay after restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'inn-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, { 'README.md': '# factory\n' });
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'origin.git'));
  const nodes = ['one', 'two'].map((name) => {
    const root = join(dir, name);
    const state = join(dir, `${name}-state`);
    git(dir, 'clone', '-q', join(dir, 'origin.git'), root);
    innAnswer({ state, event: { kind: 'issueUpdated', id: 'answer', time: 123,
      issueIdentifier: 'INN-1' }, pick: 'A', now: 123 });
    return { root, state };
  });
  const send = ({ root, state }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(factory, 'bin/lib/events.mjs'), '--after', '0'], {
      env: { ...process.env, ...quiet, HOME: dir, FACTORY_ROOT: root, FACTORY_STATE: state },
    });
    let out = '', err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        assert.equal(code, 0, err);
        resolve(out.trim() ? out.trim().split('\n').map(JSON.parse) : []);
      } catch (error) { reject(error); }
    });
  });
  const sent = await Promise.all(nodes.map(send));
  assert.deepEqual(sent.map((rows) => rows.length).sort(), [0, 1]);
  const holder = sent.findIndex((rows) => rows.length);
  assert.equal(sent[holder][0].key, 'inn-answer answer:123');
  const ref = `refs/heads/claim/inn-answer/${Buffer.from('answer:123').toString('hex')}`;
  git(join(dir, 'origin.git'), 'check-ref-format', ref);
  git(join(dir, 'origin.git'), 'rev-parse', ref);
  assert.equal((await send(nodes[holder])).length, 1, 'the holder may retry delivery');
  assert.equal((await send(nodes[1 - holder])).length, 0, 'catch-up on the loser stays silent');
  rmSync(join(nodes[holder].state, 'inn-answer-claims'), { recursive: true });
  assert.equal((await send(nodes[holder])).length, 0, 'a checkout without its own record is not the holder');
});

test('a follower keeps a failed claim pending and retries after the configured delay without losing order', { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'inn-retry-'));
  const root = join(dir, 'root');
  const state = join(dir, 'state');
  const remote = join(dir, 'origin.git');
  const hooks = join(dir, 'hooks');
  mkdirSync(root);
  mkdirSync(hooks);
  git(root, 'init', '-q', '-b', 'main');
  commit(root, { 'README.md': '# factory\n' });
  git(dir, 'clone', '-q', '--bare', root, remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(remote, 'config', 'core.hooksPath', hooks);
  const attempts = join(dir, 'attempts');
  const hook = join(hooks, 'pre-receive');
  writeFileSync(hook, `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(attempts)};
const first = !fs.existsSync(file);
fs.appendFileSync(file, Date.now() + '\\n');
if (first) {
  process.stderr.write('credential-that-must-not-be-printed\\n');
  process.exit(1);
}
`);
  chmodSync(hook, 0o755);
  innAnswer({ state, event: { kind: 'commentCreated', id: 'retry-answer', issueIdentifier: 'INN-1' }, now: 123 });
  appendStart({ state, kind: 'later', key: 'later line', text: 'waits behind the answer', now: 124 });
  // `factory-events --follow` as the command runs it, with a 200 ms retry passed to main, which the command never passes.
  const follow = `const m = await import(${JSON.stringify(join(factory, 'bin/lib/events.mjs'))}); m.main(['--follow'], { retryMs: 200 });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', follow], {
    env: { ...process.env, ...quiet, GIT_CONFIG_VALUE_2: hooks, HOME: dir, FACTORY_ROOT: root, FACTORY_STATE: state },
  });
  let out = '', err = '', closed = false;
  child.stdout.on('data', (data) => { out += data; });
  child.stderr.on('data', (data) => { err += data; });
  const ended = new Promise((resolve) => child.on('close', () => { closed = true; resolve(); }));
  t.after(async () => {
    if (!closed) child.kill();
    await ended;
    rmSync(dir, { recursive: true, force: true });
  });
  const waitFor = async (condition, timeout) => {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      assert.equal(closed, false, `follower exited: ${err}`);
      assert.ok(Date.now() < deadline, `timed out: ${err}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await waitFor(() => err.includes('retrying in 0.2 seconds'), 5_000);
  assert.equal(closed, false);
  assert.equal(out, '');
  assert.equal(existsSync(join(state, 'events.cursor')), false, 'neither line advances the cursor');
  assert.equal(err.trim(), 'factory-events: inn-answer retry-answer: claim failed; retrying in 0.2 seconds');
  await waitFor(() => existsSync(join(state, 'events.cursor')) && readFileSync(join(state, 'events.cursor'), 'utf8').trim() === '2', 5_000);
  const times = readFileSync(attempts, 'utf8').trim().split('\n').map(Number);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 200, 'the failed claim is retried after the configured delay');
  assert.deepEqual(out.trim().split('\n').map((line) => JSON.parse(line).key), ['inn-answer retry-answer', 'later line']);
  assert.equal(closed, false, 'the follower remains alive after delivery');
  assert.doesNotMatch(err, /credential-that-must-not-be-printed/);
});
