import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quote } from '../packs/pstack/bin/lead.mjs';
import { main } from '../bin/lib/factory.mjs';

test('colly isolates GitHub and grants only use and lead, with the pack role required', async (t) => {
  const state = fs.mkdtempSync(join(tmpdir(), 'factory-colly-'));
  const env = { HOME: state, FACTORY_STATE: state, FACTORY_HOST_USER: 'nobody-here', GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited' };
  const calls = [];
  const errors = [];
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  let role;
  let result = { status: 0 };
  const isRole = (path) => String(path).endsWith('/packs/colly/colly.md');
  t.mock.method(fs, 'existsSync', (path) => isRole(path) ? role !== undefined : exists(path));
  t.mock.method(fs, 'readFileSync', (path, ...args) => isRole(path) ? role : read(path, ...args));
  t.mock.method(console, 'error', (text) => errors.push(text));
  t.mock.method(childProcess, 'spawnSync', (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return result;
  });
  syncBuiltinESMExports();
  try {
    for (role of [undefined, ' \n']) {
      assert.equal(await main(['colly'], env), 2);
      assert.match(errors.at(-1), /packs\/colly\/colly\.md is missing or empty/);
      assert.equal(calls.length, 0);
    }
    role = 'Fixture role';
    assert.equal(await main(['colly'], env), 0);
    const { cmd, args, options } = calls.at(-1);
    assert.equal(cmd, 'claude');
    assert.equal(options.stdio, 'inherit');
    assert.deepEqual(args.slice(0, 4), ['--append-system-prompt', role, '--name', 'colly']);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(settings.env.GH_TOKEN, '');
    assert.equal(settings.env.GITHUB_TOKEN, '');
    assert.deepEqual(fs.readdirSync(settings.env.GH_CONFIG_DIR), []);
    assert.equal(fs.statSync(settings.env.GH_CONFIG_DIR).mode & 0o777, 0o700);
    assert.deepEqual(settings.permissions.allow, ['Bash(factory use:*)', 'Bash(bin/factory use:*)', 'Bash(factory lead:*)', 'Bash(bin/factory lead:*)']);
    assert.deepEqual(settings.permissions.deny, [
      'Bash(gh auth:*)', 'Bash(security:*)', 'Bash(/usr/bin/security:*)',
      'Bash(*factory account*)', 'Bash(*factory store*)',
      'Bash(*lib/factory.mjs account*)', 'Bash(*lib/factory.mjs store*)',
    ]);
    result = { status: 7 };
    assert.equal(await main(['colly'], env), 7);
    result = { error: { code: 'ENOENT' } };
    assert.equal(await main(['colly'], env), 1);
    fs.writeFileSync(join(settings.env.GH_CONFIG_DIR, 'hosts.yml'), 'fixture');
    const count = calls.length;
    assert.equal(await main(['colly'], env), 1);
    assert.match(errors.at(-1), /hosts.yml/);
    assert.equal(await main(['colly'], { ...env, FACTORY_HOST_USER: userInfo().username }), 2);
    assert.equal(await main(['colly', '--unknown'], env), 2);
    assert.equal(calls.length, count);
    for (const flags of [['--line', '--once'], ['--line', '--after', '1'], ['--brief', '--width', '80'], ['--line', '--brief'], ['--brief', '--after', '1x']]) {
      assert.equal(await main(['colly', ...flags], env), 2);
      assert.equal(calls.length, count);
    }
    result = { status: 0 };
    for (const flags of [['--line'], ['--line', '--width', '80'], ['--brief'], ['--brief', '--after', '5']]) {
      assert.equal(await main(['colly', ...flags], env), 0);
      const colly = calls.at(-1);
      assert.equal(colly.cmd, 'ssh');
      assert.ok(!colly.args.includes('-t'));
      assert.ok(colly.args.at(-1).includes(`factory colly ${flags.join(' ')}`));
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('colly supplies the brief and status line, records its socket, and reuses the live pane', async (t) => {
  const state = fs.mkdtempSync(join(tmpdir(), 'colly-hooks-'));
  const env = { HOME: state, FACTORY_STATE: state, FACTORY_HOST_USER: 'nobody-here', HERDR_PANE_ID: 'w1:p7', PATH: state };
  const calls = [];
  const logs = [];
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  const lstat = fs.lstatSync;
  const run = childProcess.spawnSync;
  const socket = join(state, 'inbox.sock');
  let live = false;
  const isRole = (path) => String(path).endsWith('/packs/colly/colly.md');
  t.mock.method(fs, 'existsSync', (path) => isRole(path) || exists(path));
  t.mock.method(fs, 'readFileSync', (path, ...args) => isRole(path) ? 'Fixture role' : read(path, ...args));
  t.mock.method(fs, 'lstatSync', (path) => path === socket ? { isSocket: () => true, uid: process.getuid() } : lstat(path));
  t.mock.method(net, 'createConnection', () => {
    const connection = new EventEmitter();
    connection.destroy = () => {};
    connection.end = connection.write = () => assert.fail('liveness must not write');
    process.nextTick(() => live ? connection.emit('connect') : connection.emit('error', new Error('refused')));
    return connection;
  });
  t.mock.method(console, 'log', (line) => logs.push(line));
  t.mock.method(childProcess, 'spawnSync', (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0 };
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await main(['colly'], env), 0);
    const args = calls.at(-1).args;
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    const factory = fileURLToPath(new URL('../bin/lib/factory.mjs', import.meta.url));
    assert.equal(settings.statusLine.command, [process.execPath, factory, 'colly', '--line'].map(quote).join(' '));
    assert.equal(settings.statusLine.refreshInterval, 60);
    assert.equal(settings.statusLine.type, 'command');
    // Stub the brief's child process in Node, so the absolute CLI entry point is checked without running it.
    const preload = join(state, 'brief-fake.cjs');
    const called = join(state, 'brief-call.json');
    fs.writeFileSync(preload, `require('node:child_process').spawnSync = (cmd, args) => {
      require('node:fs').writeFileSync(${JSON.stringify(called)}, JSON.stringify({cmd, args}));
      return {status: 0, stdout: 'waits\\nteams\\nalerts\\n'};
    };`);
    const hookEnv = { ...env, NODE_OPTIONS: `--require=${preload}`, CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socket}` };
    const hook = (event) => settings.hooks[event][0].hooks.map(({ command }) => {
      const result = run('/bin/sh', ['-c', command], { env: hookEnv, input: JSON.stringify({ hook_event_name: event }), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    });
    const output = hook('SessionStart').filter((s) => s.trim()).map(JSON.parse);
    assert.deepEqual(output, [{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'waits\nteams\nalerts\n' } }]);
    assert.deepEqual(JSON.parse(read(called, 'utf8')), { cmd: process.execPath, args: [factory, 'colly', '--brief'] });
    assert.equal(read(join(state, 'colly/socket'), 'utf8').trim(), socket);
    live = true;
    const count = calls.length;
    assert.equal(await main(['colly'], { ...env, HERDR_PANE_ID: 'w1:p8' }), 0);
    assert.equal(calls.length, count, 'no second session and no Herdr when absent from PATH');
    assert.match(logs.at(-1), /w1:p7/);
    fs.writeFileSync(join(state, 'herdr'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(await main(['colly'], env), 0);
    assert.deepEqual(calls.at(-1).args, ['agent', 'focus', 'w1:p7']);
    assert.equal(calls.at(-1).cmd, join(state, 'herdr'));
    live = false;
    assert.equal(await main(['colly'], env), 0);
    assert.equal(calls.at(-1).cmd, 'claude', 'a stale socket does not block a new session');
    hook('SessionEnd');
    assert.equal(exists(join(state, 'colly/socket')), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(state, { recursive: true, force: true });
  }
});
