import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/lib/factory.mjs';
import { roleOf } from '../packs/pstack/bin/lead.mjs';

test('lead --here passes the pack role as an appended system prompt', async (t) => {
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
      }), 0);
      const { cmd, args, options } = calls.at(-1);
      assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, 'made-up-local-token');
      // A key in the caller's shell outranks the team's token, and a plugin cache would be another profile's (#366).
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) assert.equal(options.env[key], undefined, key);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, join(state, '.agent-profiles/leads/alpha-beta/claude'));
      assert.ok(!args.join(' ').includes('made-up-local-token'));
      assert.equal(cmd, 'claude');
      const index = args.indexOf('--append-system-prompt');
      assert.ok(index >= 0, 'the launch must supply the role prompt');
      const expected = roleOf(readFileSync(new URL('../packs/pstack/lead.md', import.meta.url), 'utf8'), linear)
        .replaceAll('{{TEAM}}', 'beta').replaceAll('{{TEAMKEY}}', linear ? 'ALP' : '');
      assert.equal(args[index + 1], expected);
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
