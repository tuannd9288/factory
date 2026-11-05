import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
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
      'Bash(*factory login*)', 'Bash(*factory store*)', 'Bash(*factory logout*)',
      'Bash(*lib/factory.mjs login*)', 'Bash(*lib/factory.mjs store*)', 'Bash(*lib/factory.mjs logout*)',
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
    result = { status: 0 };
    for (const flags of [['--line'], ['--line', '--width', '80'], ['--brief'], ['--brief', '--after', '5']]) {
      assert.equal(await main(['colly', ...flags], env), 0);
      const colly = calls.at(-1);
      assert.equal(await main(['top', ...flags], env), 0);
      assert.deepEqual(colly, calls.at(-1));
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(state, { recursive: true, force: true });
  }
});
