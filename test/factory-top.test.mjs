import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { main } from '../bin/lib/factory.mjs';

test('removed top directs every invocation to Linear without starting a process', async (t) => {
  const messages = [];
  t.mock.method(console, 'error', (text) => messages.push(text));
  t.mock.method(childProcess, 'spawnSync', () => { throw new Error('must not start a process'); });
  syncBuiltinESMExports();
  try {
    for (const args of [[], ['--once'], ['--line'], ['--brief'], ['--full']]) {
      assert.equal(await main(['top', ...args], { FACTORY_HOST_USER: 'no-host' }), 2);
      assert.match(messages.at(-1), /factory top was removed.*Linear.*Factory release 1/);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
