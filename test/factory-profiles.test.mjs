import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, profilesOf } from '../bin/lib/factory.mjs';

test('MacBook Leads and Colly use private factory folders and their own authentication', async (t) => {
  const state = fs.mkdtempSync(join(tmpdir(), 'factory-profiles-'));
  const agentProfiles = join(state, 'store');
  const env = { HOME: state, FACTORY_STATE: state, AGENT_PROFILES: agentProfiles,
    FACTORY_RUNS: join(state, 'runs'), FACTORY_HOST_USER: 'nobody-here',
    CLAUDE_CONFIG_DIR: join(state, 'personal'), CLAUDE_CODE_OAUTH_TOKEN: 'inherited',
    ANTHROPIC_API_KEY: 'inherited', ANTHROPIC_AUTH_TOKEN: 'inherited',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: join(state, 'personal-plugins') };
  const calls = [];
  const reads = [];
  const read = fs.readFileSync;
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => String(p).endsWith('/packs/colly/colly.md') || exists(p));
  t.mock.method(fs, 'readFileSync', (p, ...args) => {
    reads.push(String(p));
    assert.ok(!String(p).startsWith(env.CLAUDE_CONFIG_DIR), 'never read the inherited profile');
    return String(p).endsWith('/packs/colly/colly.md') ? 'Fixture role' : read(p, ...args);
  });
  t.mock.method(childProcess, 'spawnSync', (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: 'name:Fixture\nemail:fixture@example.invalid\n' };
  });
  syncBuiltinESMExports();
  try {
    fs.mkdirSync(join(agentProfiles, 'tokens'), { recursive: true });
    fs.writeFileSync(join(agentProfiles, 'tokens/fixture'), 'fixture-token\n');
    fs.writeFileSync(join(state, 'accounts'), 'factory/alpha-beta=fixture\nfactory/alpha-gamma=fixture\n');
    const configs = [];
    for (const team of ['beta', 'gamma', 'beta']) {
      assert.equal(await main(['lead', 'alpha', '--team', team, '--here'], env), 0);
      const child = calls.at(-1).options.env;
      const config = join(state, 'lead-here', 'profiles', 'alpha', team);
      assert.equal(child.CLAUDE_CONFIG_DIR, config);
      assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-token');
      assert.equal(child.FACTORY_TEAM, `alpha-${team}`);
      assert.equal(fs.lstatSync(config).isSymbolicLink(), false);
      assert.equal(fs.statSync(config).mode & 0o777, 0o700);
      assert.equal(JSON.parse(fs.readFileSync(join(config, '.claude.json'))).hasCompletedOnboarding, true);
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) assert.equal(child[key], undefined);
      configs.push(config);
    }
    assert.notEqual(configs[0], configs[1]);
    assert.equal(configs[0], configs[2]);
    reads.length = 0;
    assert.equal(await main(['colly'], env), 0);
    assert.ok(!reads.some((p) => p.startsWith(agentProfiles)), 'Colly launch never reads the token store');
    const child = calls.at(-1).options.env;
    const config = join(state, 'colly/profile');
    assert.equal(child.CLAUDE_CONFIG_DIR, config);
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) assert.equal(child[key], undefined);
    assert.equal(fs.statSync(config).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(config), []);
    fs.writeFileSync(join(config, 'login-fixture'), 'owned by client');
    assert.equal(await main(['colly'], env), 0);
    assert.equal(fs.readFileSync(join(config, 'login-fixture'), 'utf8'), 'owned by client');
    const rows = profilesOf('macbook', { home: state, state });
    const row = rows.find((r) => r.role === 'Colly');
    assert.equal(row.check.env.CLAUDE_CONFIG_DIR, config);
    assert.match(row.login, /\/login/);
    assert.ok(!rows.some((r) => r.role === 'Colly gh'));
    fs.unlinkSync(join(agentProfiles, 'tokens/fixture'));
    const starts = calls.filter((c) => c.cmd === 'claude').length;
    assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], env), 2);
    assert.equal(calls.filter((c) => c.cmd === 'claude').length, starts);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(state, { recursive: true, force: true });
  }
});
