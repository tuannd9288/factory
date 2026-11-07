import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/lib/factory.mjs';
import { roleFor } from '../packs/pstack/bin/lead.mjs';
import { HOST_ENV } from './helpers.mjs';

test('lead --here passes the pack role as an appended system prompt; run as a user other than the agents\', the Human\'s own, it starts no seat: no FACTORY_TEAM, no bin/seat grant, and a role with no seat path (#366)', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'factory-role-'));
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: 'name:Fixture\nemail:fixture@example.invalid\n' };
  });
  syncBuiltinESMExports();
  try {
    mkdirSync(join(state, '.agent-profiles/tokens'), { recursive: true });
    writeFileSync(join(state, '.agent-profiles/tokens/fixture'), 'made-up-local-token');
    writeFileSync(join(state, 'accounts'), 'factory/alpha-beta=fixture\n');
    for (const linear of [false, true]) {
      if (linear) {
        mkdirSync(join(state, 'linear'));
        writeFileSync(join(state, 'linear/repos.json'), JSON.stringify({ alpha: { key: 'ALP', teamId: 'fixture' } }));
      }
      assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], {
        HOME: state, FACTORY_STATE: state, FACTORY_HOST_USER: 'nobody-here', CLAUDE_CODE_OAUTH_TOKEN: 'made-up-wrong-node-token',
        ANTHROPIC_API_KEY: 'made-up-key', ANTHROPIC_AUTH_TOKEN: 'made-up-auth', CLAUDE_CODE_PLUGIN_CACHE_DIR: join(state, 'other-plugins'),
        FACTORY_TEAM: 'other-gamma',
      }), 0);
      const { cmd, args, options } = calls.at(-1);
      assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, 'made-up-local-token');
      // A key in the caller's shell outranks the team's token, and a plugin cache would be another profile's (#366).
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) assert.equal(options.env[key], undefined, key);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, join(state, '.agent-profiles/leads/alpha-beta/claude'));
      assert.ok(!args.join(' ').includes('made-up-local-token'));
      assert.equal(cmd, 'claude');
      // Seats run only as the agents' user (#366 (a)): bin/seat refuses a start with no FACTORY_TEAM (bin/lib/seat.mjs), one in the
      // caller's shell included, and nothing grants bin/seat or names it in the role.
      assert.equal(options.env.FACTORY_TEAM, undefined);
      // Nor the setting that names the agents' user to bin/seat, which the caller's environment here has (`nobody-here`).
      assert.equal(options.env.FACTORY_HOST_USER, undefined);
      assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).permissions.allow, undefined);
      const index = args.indexOf('--append-system-prompt');
      assert.ok(index >= 0, 'the launch must supply the role prompt');
      const role = args[index + 1];
      assert.ok(!role.includes('/bin/seat'), 'no seat path');
      assert.doesNotMatch(role, /\{\{|<!--/, 'no token or form marker is left');
      const expected = roleFor(readFileSync(new URL('../packs/pstack/lead.md', import.meta.url), 'utf8'),
        { linear: linear && { key: 'ALP' }, team: 'beta', seat: null, runs: join(state, 'factory-runs') });
      assert.equal(role, expected);
    }
    rmSync(join(state, '.agent-profiles/tokens/fixture'));
    calls.length = 0;
    assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], {
      HOME: state, FACTORY_STATE: state, FACTORY_HOST_USER: 'nobody-here', CLAUDE_CODE_OAUTH_TOKEN: 'made-up-wrong-node-token',
    }), 2);
    assert.ok(!calls.some((c) => c.cmd === 'claude'), 'no fallback to another node or inherited token');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(state, { recursive: true, force: true });
  }
});

test('lead --here run as the agents\' user on a machine that is not the host, the MacBook\'s `factory`, starts its seats: FACTORY_TEAM, the installed copy\'s bin/seat granted and named in its role (#366)', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'factory-role-'));
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: 'name:Fixture\nemail:fixture@example.invalid\n' };
  });
  syncBuiltinESMExports();
  try {
    mkdirSync(join(state, '.agent-profiles/tokens'), { recursive: true });
    writeFileSync(join(state, '.agent-profiles/tokens/fixture'), 'made-up-local-token');
    writeFileSync(join(state, 'accounts'), 'factory/alpha-beta=fixture\n');
    assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], {
      HOME: state, FACTORY_STATE: state, ...HOST_ENV, FACTORY_HOST_NAME: 'another-machine', FACTORY_TEAM: 'other-gamma',
    }), 0);
    const { cmd, args, options } = calls.at(-1);
    assert.equal(cmd, 'claude');
    const seat = join(state, '.local/share/factory/checkout/bin/seat');
    assert.equal(options.env.FACTORY_TEAM, 'alpha-beta', 'its own team, not the caller\'s');
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]).permissions.allow, [`Bash(${seat}:*)`]);
    const role = args[args.indexOf('--append-system-prompt') + 1];
    assert.ok(role.includes(seat), 'the role names the bin/seat its grant allows');
    assert.equal(role, roleFor(readFileSync(new URL('../packs/pstack/lead.md', import.meta.url), 'utf8'), { linear: null, team: 'beta', seat, runs: join(state, 'factory-runs') }));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(state, { recursive: true, force: true });
  }
});
