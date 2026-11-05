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
  t.mock.method(childProcess, 'spawnSync', (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: 'name:Fixture\nemail:fixture@example.invalid\n' };
  });
  syncBuiltinESMExports();
  try {
    for (const linear of [false, true]) {
      if (linear) {
        mkdirSync(join(state, 'linear'));
        writeFileSync(join(state, 'linear/repos.json'), JSON.stringify({ alpha: { key: 'ALP', teamId: 'fixture' } }));
      }
      assert.equal(await main(['lead', 'alpha', '--team', 'beta', '--here'], {
        HOME: state, FACTORY_STATE: state, FACTORY_HOST_USER: 'nobody-here',
      }), 0);
      const { cmd, args } = calls.at(-1);
      assert.equal(cmd, 'claude');
      const index = args.indexOf('--append-system-prompt');
      assert.ok(index >= 0, 'the launch must supply the role prompt');
      const expected = roleOf(readFileSync(new URL('../packs/pstack/lead.md', import.meta.url), 'utf8'), linear)
        .replaceAll('{{TEAM}}', 'beta').replaceAll('{{TEAMKEY}}', linear ? 'ALP' : '');
      assert.equal(args[index + 1], expected);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(state, { recursive: true, force: true });
  }
});
