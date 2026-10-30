// bin/lib/plugins.mjs (#185): where a profile's plugins go and how the work folder's enabled plugins get there. A fake claude on
// PATH logs each call (test/seat-world.mjs); no live claude, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PSTACK_SETTINGS, world } from './seat-world.mjs';

const lib = () => import('../bin/lib/plugins.mjs');
const PIN = PSTACK_SETTINGS.extraKnownMarketplaces['pstack-4dd1d05'].source;
const mode = (p) => statSync(p).mode & 0o777;

/** What installPlugins needs for a world: the profile's config dir, which does not exist, and an env that finds the fake claude. */
const setup = (w) => ({ work: w.work, config: join(w.profiles, 'seats/2/claude'), home: w.home, profiles: w.profiles, env: { PATH: w.env().PATH, HOME: w.home, GH_TOKEN: 'x', CLAUDE_CONFIG_DIR: join(w.profiles, 'seats/2/claude') } });

test('the root and the install config mirror the config dir under the profiles folder', async () => {
  const { pluginPaths, PluginError } = await lib();
  const o = { home: '/h', profiles: '/h/.agent-profiles' };
  assert.deepEqual(pluginPaths('/h/.agent-profiles/seats/1/claude', o), { root: '/h/.local/share/factory/plugins/seats/1/claude', installConfig: '/h/.local/share/factory/plugin-install/seats/1/claude' });
  assert.equal(pluginPaths('/h/.agent-profiles/o/r/claude', o).root, '/h/.local/share/factory/plugins/o/r/claude');
  for (const bad of ['/h/.agent-profiles', '/h/.agent-profiles/', '/h/other/claude', '/h/.agent-profiles/../x', '/h/.agent-profilesX/a', 'seats/1/claude']) assert.throws(() => pluginPaths(bad, o), PluginError, bad);
});

test('add then install, each in the work folder with two folders in its env, at mode 700, and nothing under the profiles', () => world(async (w) => {
  const { installPlugins } = await lib();
  w.settings(PSTACK_SETTINGS);
  const s = setup(w);
  mkdirSync(join(w.home, '.local/share/factory/plugins/seats/2/claude'), { recursive: true, mode: 0o755 });
  const root = installPlugins(s);
  const install = join(w.home, '.local/share/factory/plugin-install/seats/2/claude');
  assert.equal(root, join(w.home, '.local/share/factory/plugins/seats/2/claude'));
  const calls = w.pluginCalls();
  assert.deepEqual(calls.map((c) => c.argv), [
    ['plugin', 'marketplace', 'add', join(install, 'marketplaces/pstack-4dd1d05'), '--scope', 'local', '--json'],
    ['plugin', 'install', 'pstack@pstack-4dd1d05', '--scope', 'local'],
  ]);
  for (const c of calls) {
    assert.equal(c.cwd, realpathSync(w.work));
    assert.equal(c.env.CLAUDE_CONFIG_DIR, install);
    assert.equal(c.env.CLAUDE_CODE_PLUGIN_CACHE_DIR, root);
    assert.equal(c.env.GH_TOKEN, undefined);
    assert.ok(!Object.values(c.env).some((v) => v.includes(w.profiles)), 'nothing in the env names a profile');
    assert.ok(!c.argv.includes('-y') && !c.argv.includes('--accept-command'));
  }
  for (const d of [root, install, join(install, 'marketplaces/pstack-4dd1d05/.claude-plugin')]) assert.equal(mode(d), 0o700, d);
  assert.deepEqual(JSON.parse(readFileSync(join(install, 'marketplaces/pstack-4dd1d05/.claude-plugin/marketplace.json'), 'utf8')), { name: 'pstack-4dd1d05', owner: { name: 'factory' }, plugins: PIN.plugins });
  assert.deepEqual(readdirSync(join(install, 'marketplaces/pstack-4dd1d05/.claude-plugin')), ['marketplace.json']);
  assert.ok(!existsSync(join(w.profiles, 'seats/2')), 'no file was made under the profile');
  assert.deepEqual(readdirSync(w.profiles), ['seats']);
  // A second run does both again, and changes nothing.
  installPlugins(s);
  assert.equal(w.pluginCalls().length, 4);
}));

test('a work folder that enables no plugin installs nothing, and still gets its root', () => world(async (w) => {
  const { installPlugins } = await lib();
  const root = installPlugins(setup(w));
  assert.equal(w.pluginCalls().length, 0);
  assert.equal(mode(root), 0o700);
  w.settings({ enabledPlugins: { 'off@x': false } });
  installPlugins(setup(w));
  assert.equal(w.pluginCalls().length, 0);
}));

test('a call that exits non-zero stops the install with the reason', () => world(async (w) => {
  const { installPlugins, PluginError } = await lib();
  w.settings(PSTACK_SETTINGS);
  w.pluginMode('fail');
  assert.throws(() => installPlugins(setup(w)), (e) => e instanceof PluginError && /marketplace add exited 1: boom/.test(e.message));
  assert.equal(w.pluginCalls().length, 1);
}));

test('output that asks to log in stops it, though the exit is 0', () => world(async (w) => {
  const { installPlugins, PluginError } = await lib();
  w.settings(PSTACK_SETTINGS);
  w.pluginMode('login');
  assert.throws(() => installPlugins(setup(w)), (e) => e instanceof PluginError && /asks to log in/.test(e.message));
}));

test('an enabled plugin with no settings pin is refused before any call', () => world(async (w) => {
  const { installPlugins, PluginError } = await lib();
  const refuse = (settings, re) => {
    w.settings(settings);
    assert.throws(() => installPlugins(setup(w)), (e) => e instanceof PluginError && re.test(e.message));
    assert.equal(w.pluginCalls().length, 0);
  };
  refuse({ ...PSTACK_SETTINGS, enabledPlugins: { 'pstack@other': true } }, /no settings marketplace pin other/);
  refuse({ ...PSTACK_SETTINGS, enabledPlugins: { 'nothere@pstack-4dd1d05': true } }, /lists nothere/);
  refuse({ enabledPlugins: { 'pstack@pstack-4dd1d05': true } }, /no settings marketplace pin/);
  refuse({ ...PSTACK_SETTINGS, extraKnownMarketplaces: { 'pstack-4dd1d05': { source: { source: 'github', repo: 'a/b' } } } }, /no settings marketplace pin/);
}));

test('a config dir outside the profiles folder is refused', () => world(async (w) => {
  const { installPlugins, PluginError } = await lib();
  assert.throws(() => installPlugins({ ...setup(w), config: join(w.home, 'elsewhere') }), PluginError);
}));
