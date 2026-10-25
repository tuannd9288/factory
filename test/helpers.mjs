// A throwaway repository with the kit installed by bin/onboard, and helpers to change it and run its scripts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every letter with a diacritic that Vietnamese uses (U+00C0 to U+1EF9), and a few other languages' too. Built from
 * code points, so the file holds no such letter itself. */
export const VIETNAMESE = new RegExp(`[${String.fromCodePoint(0xc0)}-${String.fromCodePoint(0x1ef9)}]`, 'u');
export const factory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Commits made by the tests name a throwaway author and run no hooks unless a test asks for them.
export const quiet = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'user.name',
  GIT_CONFIG_VALUE_0: 'test',
  GIT_CONFIG_KEY_1: 'user.email',
  GIT_CONFIG_VALUE_1: 'test@localhost',
  GIT_CONFIG_KEY_2: 'core.hooksPath',
  GIT_CONFIG_VALUE_2: '/dev/null',
};

export function run(cwd, command, args = [], env = {}, timeout = undefined) {
  const { NODE_TEST_CONTEXT, ...outer } = process.env;
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...outer, ...env }, timeout });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function git(cwd, ...args) {
  const r = run(cwd, 'git', args, quiet);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.out}`);
  return r.out.trim();
}

export function write(cwd, files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(cwd, path), { force: true });
    else {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
  }
}

export function commit(cwd, files, message = 'change') {
  write(cwd, files);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message, '--allow-empty');
  return git(cwd, 'rev-parse', 'HEAD');
}

export const APP = {
  'package.json': '{ "name": "app", "private": true, "type": "module" }\n',
  'src/math.js': 'export function add(a, b) {\n  return a + b;\n}\n',
  'test/math.test.js':
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
  'README.md': '# app\n',
};

/** A repository whose main holds the app and the kit, on a fresh branch `work`; `dir` holds its origin and profiles. */
export function repoWithKit(extra = {}, onboardArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-test-'));
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, { ...APP, ...extra }, 'start');
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
  mkdirSync(join(dir, 'root'));
  const onboard = run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr', ...onboardArgs], {
    ...quiet,
    FACTORY_ROOT: join(dir, 'root'),
    AGENT_PROFILES: join(dir, 'profiles'),
    XDG_DATA_HOME: join(dir, 'xdg'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
  });
  if (onboard.code !== 0) throw new Error(`onboard failed: ${onboard.out}`);
  const repo = join(dir, 'root', 'app');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'merge', '-q', '--ff-only', 'factory/kit');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'work');
  return { dir, repo, onboard: onboard.out, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function script(repo, name, args = [], env = {}) {
  return run(repo, join(repo, 'scripts', name), args, { ...quiet, ...env });
}
