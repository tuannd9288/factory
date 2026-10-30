// bin/lib/plugins.mjs (#185): where a profile's plugins are cached, and how a work folder's enabled plugins get there. Claude Code
// caches a plugin under CLAUDE_CONFIG_DIR, which the deny rules hide (secretsRead), so a session's plugin files would be
// unreadable. Each profile gets its own root outside ~/.agent-profiles, set as CLAUDE_CODE_PLUGIN_CACHE_DIR; the install runs
// against a throwaway config folder of its own, so no profile's folder is touched. Nothing here reads a credential or logs in.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

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

/** A name from the work folder's settings: letters, digits, dot, dash and underscore, starting with a letter or digit, so it is
 * no path (no slash, no ..) and no option of claude. Anything else is a PluginError. */
function plain(name, what) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new PluginError(`the ${what} name ${JSON.stringify(name)} is not a plain name (letters, digits, dot, dash, underscore; not starting with a dot or dash)`);
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

/** The factory's own pin: packs/pstack/settings.json of the checkout (factoryRoot) whose code is running, which is reviewed. The
 * work folder may be a candidate branch, so it never says what the marketplace is. Returns { name, source, ids }. */
function factoryPin(factoryRoot) {
  const path = join(factoryRoot, 'packs/pstack/settings.json');
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new PluginError(`the factory's pin ${path} is missing or not JSON`);
  }
  const pins = [...pinsOf(settings)];
  if (pins.length !== 1) throw new PluginError(`the factory's pin ${path} must declare exactly one settings marketplace`);
  const [name] = pins[0];
  plain(name, 'marketplace');
  const ids = Object.entries(settings.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([id]) => id);
  return { name, source: settings.extraKnownMarketplaces[name].source, ids };
}

/** Makes the profile's root and installs into it the plugins the work folder's .claude/settings.json enables. The marketplace
 * comes only from the factory's pin (factoryPin): the work folder decides only whether to install, and only when it enables
 * the pin's plugin ids and declares no marketplace but the pin, with the pin's own source; anything else is refused before any
 * folder is made or any call run. The marketplace is written as a folder in the install config, then `marketplace add` and
 * `install` run in the work folder at local scope, every time (both are idempotent). Returns the root. A failed call or a login
 * prompt is a PluginError. A work folder that enables none installs nothing. */
export function installPlugins({ work, config, home, profiles, env = process.env, timeoutMs = TIMEOUT_MS, factoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..') }) {
  const { root, installConfig } = pluginPaths(config, { home, profiles });
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
  // Every check is made before any folder is made. A name from the work folder is a plain name, a second guard: a marketplace name
  // would become a folder and a plugin name an argument of claude.
  const declared = Object.keys(settings.extraKnownMarketplaces ?? {});
  for (const name of declared) plain(name, 'marketplace');
  for (const id of wanted) {
    const at = id.lastIndexOf('@');
    plain(id.slice(0, at), 'plugin');
    plain(id.slice(at + 1), 'marketplace');
  }
  const pin = wanted.length ? factoryPin(factoryRoot) : null;
  if (pin) {
    const kit = 'take the kit update if the repository\'s pin is older than the factory\'s';
    for (const id of wanted) {
      if (!pin.ids.includes(id)) throw new PluginError(`${path} enables ${id}, but only the factory's pin ${pin.ids.join(', ')} may be enabled; ${kit}`);
    }
    for (const name of declared) {
      if (name !== pin.name) throw new PluginError(`${path} declares the marketplace ${name}, but only the factory's pin ${pin.name} may be; ${kit}`);
      if (!isDeepStrictEqual(settings.extraKnownMarketplaces[name]?.source, pin.source)) throw new PluginError(`${path} declares the marketplace ${name} with a source that is not the factory's pin`);
    }
  }
  privateDir(root);
  privateDir(installConfig);
  if (!pin) return root;
  const opts = { work, env, config: installConfig, root, timeoutMs };
  const folder = join(installConfig, 'marketplaces', pin.name);
  const file = join(folder, '.claude-plugin/marketplace.json');
  privateDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ name: pin.name, owner: { name: 'factory' }, plugins: pin.source.plugins }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  run(['marketplace', 'add', folder, '--scope', 'local', '--json'], opts);
  for (const id of wanted) run(['install', id, '--scope', 'local'], opts);
  return root;
}
