// The registry of repositories on Linear (#404): $FACTORY_STATE/linear/repos.json, { "<repo>": { key, teamId } }, on the factory host. Only
// `factory linear onboard` writes it (bin/lib/linear-cli.mjs), atomically; a repository not in it is on GitHub. It imports nothing but node:
// modules, so the pack's launcher can read it without the rest of the factory.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const registryFile = (state) => join(state, 'linear', 'repos.json');

/** The registry as { repo: { key, teamId } }; an absent or unreadable file is no repository on Linear. */
export function readRegistry(state) {
  try {
    const r = JSON.parse(readFileSync(registryFile(state), 'utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  } catch {
    return {};
  }
}

/** The grammar of a Linear team key; an entry whose key does not match is no entry. */
export const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

/** The repository's registry entry ({ key, teamId }), or null when it is on GitHub. */
export function onLinear(repo, state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory')) {
  const registry = readRegistry(state);
  const e = Object.hasOwn(registry, repo) ? registry[repo] : null;
  return e && typeof e.key === 'string' && TEAM_KEY.test(e.key) && typeof e.teamId === 'string' ? e : null;
}

export function writeRegistry(state, registry) {
  const file = registryFile(state);
  mkdirSync(join(state, 'linear'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
