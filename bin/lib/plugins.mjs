// bin/lib/plugins.mjs (#185): where a profile's plugins are cached, and how a work folder's enabled plugins get there. Claude Code
// caches a plugin under CLAUDE_CONFIG_DIR, which the deny rules hide (secretsRead), so a session's plugin files would be
// unreadable. Each profile gets its own root outside ~/.agent-profiles, set as CLAUDE_CODE_PLUGIN_CACHE_DIR; the install runs
// against a throwaway config folder of its own, so no profile's folder is touched. Nothing here reads a credential or logs in.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export class PluginError extends Error {}

const LOGIN = /\blog ?in\b|\/login/i;
const TIMEOUT_MS = 180000;

/** The root and the install config folder of a profile's config dir, both under ~/.local/share/factory, mirroring the config
 * dir's place under the profiles folder. A config dir outside that folder, or the folder itself, is refused. */
export function pluginPaths(config, { home, profiles }) {
  const rel = relative(resolve(profiles), resolve(config));
  if (!isAbsolute(config) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new PluginError(`${config} is not a folder under the profiles folder ${profiles}`);
  const base = join(home, '.local/share/factory');
  return { root: join(base, 'plugins', rel), installConfig: join(base, 'plugin-install', rel) };
}

/** Makes a folder with mode 700, or sets 700 on one that exists. Nothing is ever deleted. */
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The pins of a settings text: the marketplaces declared as `settings` sources, by name. */
function pinsOf(settings) {
  const pins = new Map();
  for (const [name, m] of Object.entries(settings.extraKnownMarketplaces ?? {})) {
    if (m?.source?.source === 'settings' && Array.isArray(m.source.plugins)) pins.set(name, m.source.plugins);
  }
  return pins;
}

/** Runs one `claude plugin` call in the work folder: stdin closed, a time limit, and an environment of the two folders only. */
function run(args, { work, env, config, root, timeoutMs }) {
  const r = spawnSync('claude', ['plugin', ...args], {
    cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
    env: { PATH: env.PATH, HOME: env.HOME, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: root },
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const what = `claude plugin ${args[0]}${args[0] === 'marketplace' ? ' add' : ` ${args[1]}`}`;
  if (r.error) throw new PluginError(`${what}: ${r.error.code ?? r.error.message}`);
  if (r.status !== 0) throw new PluginError(`${what} exited ${r.status ?? `on ${r.signal}`}: ${text.trim().split('\n').pop() ?? ''}`);
  if (LOGIN.test(text)) throw new PluginError(`${what} asks to log in`);
}

/** Makes the profile's root and installs into it the plugins the work folder's .claude/settings.json enables, each from the
 * marketplace the settings pin: writes that marketplace as a folder in the install config, then `marketplace add` and `install`
 * in the work folder at local scope, every time (both are idempotent). Returns the root. A plugin with no pin, a failed call or
 * a login prompt is a PluginError. A work folder that enables none installs nothing. */
export function installPlugins({ work, config, home, profiles, env = process.env, timeoutMs = TIMEOUT_MS }) {
  const { root, installConfig } = pluginPaths(config, { home, profiles });
  privateDir(root);
  privateDir(installConfig);
  const path = join(work, '.claude/settings.json');
  let settings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new PluginError(`${path} is not JSON`);
    }
  }
  const wanted = Object.entries(settings.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => id);
  const pins = pinsOf(settings);
  const marketplaces = new Set();
  for (const id of wanted) {
    const at = id.lastIndexOf('@');
    const [plugin, name] = [id.slice(0, at), id.slice(at + 1)];
    if (at < 1 || !pins.get(name)?.some((p) => p?.name === plugin)) throw new PluginError(`${id} is enabled, but ${path} has no settings marketplace pin ${name} that lists ${plugin}`);
    marketplaces.add(name);
  }
  const opts = { work, env, config: installConfig, root, timeoutMs };
  for (const name of marketplaces) {
    const folder = join(installConfig, 'marketplaces', name);
    const file = join(folder, '.claude-plugin/marketplace.json');
    privateDir(dirname(file));
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ name, owner: { name: 'factory' }, plugins: pins.get(name) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    run(['marketplace', 'add', folder, '--scope', 'local', '--json'], opts);
    for (const id of wanted.filter((i) => i.endsWith(`@${name}`))) run(['install', id, '--scope', 'local'], opts);
  }
  return root;
}
