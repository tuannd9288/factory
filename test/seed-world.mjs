// A repository seeded like the scratch seed, parcel-notes: its own scripts/verify with a helper, its own hooks, and
// a .claude/settings.json with its own deny lines; bin/onboard runs over it from a local bare origin. Nothing here
// touches the network.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

export const OWN_VERIFY = [
  '#!/usr/bin/env node',
  "import { appendFileSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "if (process.env.NATIVE_MARK) appendFileSync(process.env.NATIVE_MARK, 'ran\\n');",
  "process.exit(spawnSync(process.execPath, ['scripts/size.mjs'], { stdio: 'inherit' }).status ?? 1);",
  '',
].join('\n');
export const SIZE = "console.log('size rule ok');\n";
export const PRE_COMMIT = '#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/scripts/verify" --fast\n';
export const PRE_PUSH = '#!/bin/sh\necho "pre-push: not main" >&2\nexit 0\n';
export const SETTINGS = `${JSON.stringify({ permissions: { deny: ['Read(./.env*)', 'Bash(rm -rf *)'] }, enabledPlugins: { 'pstack@parcel-notes': true } }, null, 2)}\n`;
export const OWN = '## Layout\n\n`src/` holds the app.\n\n## Facts the code cannot tell\n\n- Ships on Fridays.\n';
export const ADAPTER = '\n# --- adapter, written by bin/onboard from the repository\'s own files ---\nGATE_NATIVE=scripts/verify\nGATE_CHECKS="${GATE_CHECKS:+$GATE_CHECKS }native"\ngate_fast() { .githooks/pre-commit; }\n';

export const SEED = {
  'scripts/verify': OWN_VERIFY,
  'scripts/size.mjs': SIZE,
  '.githooks/pre-commit': PRE_COMMIT,
  '.githooks/pre-push': PRE_PUSH,
  '.claude/settings.json': SETTINGS,
  'AGENTS.md': '# parcel-notes\n\nOur rules.\n',
};
export const EXECUTABLE = ['scripts/verify', '.githooks/pre-commit', '.githooks/pre-push'];

/** The seed with `files` over it (a null value drops one), a bare origin, and `onboard(...args)` that runs bin/onboard
 * --no-pr over it with --own already given unless `own` is false. */
export function seeded(files = {}, { own = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-world-'));
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  const all = { ...APP, ...SEED, ...files };
  write(seed, all);
  for (const path of EXECUTABLE) if (all[path] != null) chmodSync(join(seed, path), 0o755);
  commit(seed, {}, 'start');
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
  mkdirSync(join(dir, 'root'));
  writeFileSync(join(dir, 'own.md'), OWN);
  const env = {
    ...quiet,
    FACTORY_ROOT: join(dir, 'root'),
    AGENT_PROFILES: join(dir, 'profiles'),
    XDG_DATA_HOME: join(dir, 'xdg'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
    NATIVE_MARK: join(dir, 'native.log'),
  };
  const onboard = (...args) => run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr', ...(own ? ['--own', join(dir, 'own.md')] : []), ...args], env);
  const repo = join(dir, 'root/app');
  const read = (path) => readFileSync(join(repo, path), 'utf8');
  return { dir, seed, repo, env, onboard, read, mark: () => { try { return readFileSync(env.NATIVE_MARK, 'utf8'); } catch { return ''; } }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
