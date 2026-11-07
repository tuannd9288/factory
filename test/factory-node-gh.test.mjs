// #366: no live commands or stores; the child-process seam records environments only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/lib/factory.mjs';
import { HOST_ENV } from './helpers.mjs';

test('a node with its agents token uses local gh and git with the other node down (#366)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-node-gh-'));
  const env = { HOME: dir, AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'), FACTORY_HOST_USER: 'absent-test-user', FACTORY_AGENT: 'fake-agent', GH_TOKEN: 'wrong-inherited-token' };
  const token = 'made-up-github-token';
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), `#!${process.execPath}
if (process.env.GH_TOKEN !== 'made-up-github-token') process.exit(9);
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['api', '-X', 'GET', 'user'])) process.exit(8);
if (process.env.FAKE_GH_FAIL) process.exit(1);
console.log(process.env.FAKE_GH_BODY ?? JSON.stringify({ login: 'fake-agent', id: 12345 }));
`, { mode: 0o755 });
  env.PATH = join(dir, 'bin');
  const calls = [];
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === 'ssh') return { status: 255, stdout: '' };
    if (cmd === 'git') throw new Error('the local git identity must never be read');
    if (cmd === 'gh' && args[0] === 'api') return original(cmd, args, options);
    return { status: 0 };
  };
  syncBuiltinESMExports();
  try {
    const stored = original(process.execPath, ['--input-type=module', '-e',
      `import { main } from ${JSON.stringify(new URL('../bin/lib/factory.mjs', import.meta.url).href)}; process.exitCode = await main(['store', process.env.FACTORY_AGENT]);`],
    { env, input: `${token}\n`, encoding: 'utf8' });
    assert.equal(stored.status, 0, stored.stderr);
    assert.equal(readFileSync(join(env.AGENT_PROFILES, 'tokens', env.FACTORY_AGENT), 'utf8'), `${token}\n`);
    assert.ok(!stored.stdout.includes(token));
    // The Lead also needs its own local Claude account; store above creates only the GitHub token.
    mkdirSync(env.FACTORY_STATE, { recursive: true });
    writeFileSync(join(env.FACTORY_STATE, 'accounts'), 'factory/alpha-beta=fixture\n');
    writeFileSync(join(env.AGENT_PROFILES, 'tokens/fixture'), 'made-up-claude-token\n');
    const args = ['pr', 'create', '--body-file', 'local.md'];
    assert.equal(await main(['gh', ...args], env), 0);
    assert.equal(calls[0].cmd, 'gh');
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].options.env.GH_TOKEN, token);
    assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], env), 0);
    assert.ok(!calls.some((c) => c.cmd === 'ssh'));
    const lead = calls.find((c) => c.cmd === 'claude');
    assert.equal(lead.options.env.GH_TOKEN, token);
    assert.equal(lead.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'made-up-claude-token');
    assert.equal(lead.options.env.CLAUDE_CONFIG_DIR, join(env.AGENT_PROFILES, 'leads/alpha-beta/claude'));
    const settings = JSON.parse(lead.args[lead.args.indexOf('--settings') + 1]);
    assert.equal(settings.env.GH_TOKEN, undefined, 'settings arguments must not carry the token or override it');
    assert.equal(settings.env.GIT_AUTHOR_NAME, 'fake-agent');
    assert.equal(settings.env.GIT_COMMITTER_EMAIL, '12345+fake-agent@users.noreply.github.com');
    const config = Array.from({ length: Number(settings.env.GIT_CONFIG_COUNT) }, (_, i) => [settings.env[`GIT_CONFIG_KEY_${i}`], settings.env[`GIT_CONFIG_VALUE_${i}`]]);
    assert.deepEqual(config[0], ['credential.helper', '']);
    assert.ok(!config.some(([key]) => key.includes('pushInsteadOf')));
    assert.deepEqual(config.slice(2), [['url.https://github.com/.insteadOf', 'git@github.com:'], ['url.https://github.com/.insteadOf', 'ssh://git@github.com/']]);
    const helper = config[1][1].slice(1);
    const credentials = original('sh', ['-c', `${helper} get`], { env: { GH_TOKEN: token }, encoding: 'utf8' });
    assert.equal(credentials.status, 0);
    assert.equal(credentials.stdout, `username=x-access-token\npassword=${token}\n`);
    assert.equal(original('sh', ['-c', `${helper} store`], { env: { GH_TOKEN: token }, encoding: 'utf8' }).stdout, '');
    assert.ok(calls.every((c) => !JSON.stringify(c.args).includes(token)));
    const count = calls.length;
    assert.equal(await main(['gh', 'auth', 'token'], env), 2);
    assert.equal(calls.length, count);
    for (const failure of [{ FAKE_GH_FAIL: '1' }, { FAKE_GH_BODY: 'not JSON' }, { FAKE_GH_BODY: '{}' }]) {
      const start = calls.length;
      assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], { ...env, ...failure }), 1);
      assert.deepEqual(calls.slice(start).map((c) => c.cmd), ['gh'], 'failed identity lookup starts no Lead and reads no git config');
    }
    rmSync(join(env.AGENT_PROFILES, 'tokens', env.FACTORY_AGENT));
    assert.equal(await main(['gh', 'pr', 'list'], env), 255);
    assert.equal(calls.at(-1).cmd, 'ssh');
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a stored token leaves factory-host gh, lead --here and store unchanged (#366)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-host-gh-'));
  const env = { HOME: dir, AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: join(dir, 'state'), ...HOST_ENV, FACTORY_AGENT: 'fake-agent', GH_TOKEN: 'existing-host-token' };
  const calls = [];
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 7 };
  };
  syncBuiltinESMExports();
  try {
    mkdirSync(join(env.AGENT_PROFILES, 'tokens'), { recursive: true });
    writeFileSync(join(env.AGENT_PROFILES, 'tokens', env.FACTORY_AGENT), 'made-up-stored-token\n');
    assert.equal(await main(['gh', 'auth', 'token'], env), 7, 'host auth commands remain unrestricted');
    assert.equal(calls[0].cmd, 'gh');
    assert.deepEqual(calls[0].args, ['auth', 'token']);
    assert.equal(calls[0].options.env, env, 'host environment passes through unchanged');
    assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], env), 2);
    assert.equal(calls.length, 1, 'host --here refuses before any identity lookup or launch');
    const stored = original(process.execPath, ['--input-type=module', '-e',
      `import { main } from ${JSON.stringify(new URL('../bin/lib/factory.mjs', import.meta.url).href)}; process.exitCode = await main(['store', 'fake-other']);`],
    { env, input: 'made-up-other-token\n', encoding: 'utf8' });
    assert.equal(stored.status, 0, stored.stderr);
    assert.equal(readFileSync(join(env.AGENT_PROFILES, 'tokens/fake-other'), 'utf8'), 'made-up-other-token\n');
    assert.equal(readFileSync(join(env.AGENT_PROFILES, 'tokens', env.FACTORY_AGENT), 'utf8'), 'made-up-stored-token\n');
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
