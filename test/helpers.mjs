// A throwaway repository with the kit installed by bin/onboard, and helpers to change it and run its scripts.
import './caller-env.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeName } from '../bin/lib/node.mjs';
import { FACTORY_URL } from '../kit/.gate/bin/lib/instructions.mjs';

export const factory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The reader's setting every test runs with (#518): the model pass on, on its pi side, so a pull request that turns the shipped switch
// (bin/lib/reader.json) off changes no sweep test. A child a test starts with this process's environment gets it too. The one test of the
// shipped file reads it by its own path (REPO_SETTING).
export const READER_ON = join(factory, 'test/fixtures/reader/setting-on.json');
process.env.FACTORY_READER_SETTING ??= READER_ON;

// The settings that make this machine and user the factory host (placeOf, bin/lib/node.mjs): its user and its name.
export const HOST_ENV = { FACTORY_HOST_USER: userInfo().username, FACTORY_HOST_NAME: nodeName() };

// Commits made by the tests name a throwaway author and run no hooks unless a test asks for them. They also start no
// background gc or maintenance: git's own default starts one detached after a commit, and it can write into a test's
// folder (objects/info/packs) while the test removes it, which fails the removal with ENOTEMPTY.
export const quiet = {
  GIT_CONFIG_COUNT: '6',
  GIT_CONFIG_KEY_3: 'gc.auto',
  GIT_CONFIG_VALUE_3: '0',
  GIT_CONFIG_KEY_4: 'gc.autoDetach',
  GIT_CONFIG_VALUE_4: 'false',
  GIT_CONFIG_KEY_5: 'maintenance.auto',
  GIT_CONFIG_VALUE_5: 'false',
  GIT_CONFIG_KEY_0: 'user.name',
  GIT_CONFIG_VALUE_0: 'test',
  GIT_CONFIG_KEY_1: 'user.email',
  GIT_CONFIG_VALUE_1: 'test@localhost',
  GIT_CONFIG_KEY_2: 'core.hooksPath',
  GIT_CONFIG_VALUE_2: '/dev/null',
};

/** quiet, with git fetching `url` from the local `folder` instead, by its own url.<folder>.insteadOf. */
export const insteadOf = (folder, url) => ({ ...quiet, GIT_CONFIG_COUNT: '7', GIT_CONFIG_KEY_6: `url.${folder}.insteadOf`, GIT_CONFIG_VALUE_6: url });

/** quiet, with the trust check's fetch of the public factory (FACTORY_URL) sent to a local folder. */
export const factoryAt = (folder) => insteadOf(folder, FACTORY_URL);

/** A process lister (bin/lib/ps.mjs) that knows this test's own process alone, started at performance.timeOrigin, and asks no ps, which
 * a seat's sandbox refuses: a liveness test that passes it runs there too. Any other pid has no process it can read. */
export const OWN_PROCESS = {
  signal: (pid) => process.kill(pid, 0),
  info: (pid) => (pid === process.pid ? { uid: process.getuid(), started: Math.floor(performance.timeOrigin) } : null),
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
export function repoWithKit(extra = {}, onboardArgs = [], executable = []) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-test-'));
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  write(seed, { ...APP, ...extra });
  for (const path of executable) chmodSync(join(seed, path), 0o755);
  commit(seed, {}, 'start');
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
  return run(repo, join(repo, '.gate/bin', name), args, { ...quiet, ...env });
}
