// bin/seat (#185): Claude Code caches a plugin under the profile's CLAUDE_CONFIG_DIR unless CLAUDE_CODE_PLUGIN_CACHE_DIR says
// otherwise, and the deny list refuses a Read of the profiles' folder, so a plugin's own files must be cached elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { until, world } from './seat-world.mjs';

test('the plugin cache a seat session uses is outside every folder the deny list refuses', () => world(async (w) => {
  const { DENIED } = await import('../bin/lib/deny-read.mjs');
  // The profiles at their real place under HOME, which is where the deny rules point.
  mkdirSync(join(w.home, '.agent-profiles/tokens'), { recursive: true });
  writeFileSync(join(w.home, '.agent-profiles/tokens', w.account), 'fake-token-0123456789-do-not-leak\n');
  const r = w.start('worker', [], { AGENT_PROFILES: join(w.home, '.agent-profiles') });
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const { env } = w.saw();
  // Where Claude Code puts the cache: the variable, else a folder of the config dir.
  const cache = env.pluginCache ?? join(env.config, 'plugins');
  const denied = DENIED.filter((e) => !e.base).map((e) => join(w.home, e.path));
  assert.ok(denied.includes(join(w.home, '.agent-profiles')));
  // A glob entry (~/.claude*) refuses every path whose part under home starts with what precedes its *.
  const under = (folder) => (folder.endsWith('*') ? cache.startsWith(folder.slice(0, -1)) : cache === folder || cache.startsWith(folder + sep));
  for (const folder of denied) assert.ok(!under(folder), `the plugin cache ${cache} is under ${folder}, which the deny list refuses to read`);
}));
