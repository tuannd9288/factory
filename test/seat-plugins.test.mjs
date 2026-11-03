// bin/seat (#185): before each session it installs the work folder's enabled plugins into the seat's own root, and gives the
// session that root as its plugin cache, whatever the caller had set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PSTACK_SETTINGS, until, world } from './seat-world.mjs';

test('the plugins install before the session, and the session gets the root as its cache', () => world(async (w) => {
  w.settings(PSTACK_SETTINGS);
  const r = w.start('worker', [], { CLAUDE_CODE_PLUGIN_CACHE_DIR: '/elsewhere' });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const root = join(w.home, '.local/share/factory/plugins/seats/2/claude');
  assert.equal(w.pluginCalls().length, 2);
  for (const c of w.pluginCalls()) assert.equal(c.env.CLAUDE_CODE_PLUGIN_CACHE_DIR, root);
  const { env } = w.saw();
  assert.equal(env.pluginCache, root);
  assert.equal(env.config, join(w.profiles, 'seats/2/claude'));
  assert.ok(!existsSync(join(w.profiles, 'seats/2')), 'nothing was made under the profile');
}));

test('a work folder with no plugin skips the install, and the root is still the cache', () => world(async (w) => {
  const r = w.start('worker');
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.pluginCalls().length, 0);
  assert.equal(w.saw().env.pluginCache, join(w.home, '.local/share/factory/plugins/seats/2/claude'));
}));

test('a failed install refuses the start, with the reason, and leaves no run behind', () => world(async (w) => {
  w.settings(PSTACK_SETTINGS);
  w.pluginMode('fail');
  const r = w.start('worker');
  assert.equal(r.code, 2);
  assert.match(r.err, /bin\/seat: plugins: .*marketplace add exited 1: boom/);
  assert.deepEqual(readdirSync(w.run).filter((n) => /\.(pid|seat|claim)/.test(n)), []);
  assert.deepEqual(w.records(), []);
}));
