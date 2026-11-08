// The registry of repositories on Linear (#404): $FACTORY_STATE/linear/repos.json, { "<repo>": { key, teamId } }, one on each node that runs
// `factory linear` itself (FAC-38). Only `factory linear onboard` writes it (bin/lib/linear-cli.mjs), atomically and under a lock; a repository
// not in a node's registry is on GitHub for that node. A file that
// exists and does not parse is an error, never an empty registry: every reader refuses, and `onboard` writes nothing. It imports nothing but
// node: modules and bin/lib/files.mjs, which imports only node: modules, so the pack's launcher can read it without the rest of the factory.
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonObject, writeAtomic } from './files.mjs';

export const registryFile = (state) => join(state, 'linear', 'repos.json');

/** The grammar of a Linear team key; an entry whose key does not match is no entry. */
export const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

/** The registry as { repo: { key, teamId } }: {} when there is no file; throws when the file is there and does not read or parse. */
export function readRegistry(state) {
  const file = registryFile(state);
  try {
    return readJsonObject(file) ?? {};
  } catch (e) {
    if (e.code === 'ENOTOBJECT') throw new Error(`the registry ${file} exists but does not parse as an object; nothing was changed`);
    throw new Error(`the registry ${file} exists but cannot be read (${e.code ?? 'error'}); nothing was changed`);
  }
}

/** The repository's registry entry ({ key, teamId }), or null when it is on GitHub. Throws as readRegistry does. The registry is keyed
 * by the repository's name, as `onboard` writes it; an `owner/name` is read by its name, as `factory-move` and the ledger pass it. */
export function onLinear(repo, state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory')) {
  const registry = readRegistry(state);
  const name = String(repo).slice(String(repo).lastIndexOf('/') + 1);
  const e = Object.hasOwn(registry, name) ? registry[name] : null;
  return e && typeof e.key === 'string' && TEAM_KEY.test(e.key) && typeof e.teamId === 'string' ? e : null;
}

const writeRegistry = (state, registry) => writeAtomic(registryFile(state), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Reads the registry, hands it to `change`, and writes what that returns (nothing when it returns null), all under a mkdir lock so two
 * onboards cannot lose an update. Resolves to whether the file was written. */
export async function updateRegistry(state, change) {
  const dir = join(state, 'linear');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'repos.lock');
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    } catch {
      continue;
    }
    if (Date.now() > until) throw new Error('the registry lock is held');
    await sleep(25);
  }
  try {
    const next = change(readRegistry(state));
    if (next) writeRegistry(state, next);
    return Boolean(next);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
