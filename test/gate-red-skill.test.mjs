// #94: the kit's skill gate-red, laid in every repository like any kit file. Nothing here reads what the skill says. The
// file is read inside each test, so a test fails on its own while the skill is missing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

const SKILL = '.claude/skills/gate-red/SKILL.md';
const kit = (path) => readFileSync(join(factory, 'kit', path), 'utf8');

describe('onboard lays the skill and the rules file', () => {
  test('both are in the repository as the kit has them, and listed in .gate/kit-files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-red-'));
    try {
      const seed = join(dir, 'seed');
      git(dir, 'init', '-q', '-b', 'main', seed);
      write(seed, APP);
      commit(seed, {}, 'start');
      git(dir, 'clone', '-q', '--bare', seed, join(dir, 'app.git'));
      const out = run(dir, join(factory, 'bin/onboard'), [join(dir, 'app.git'), '--no-pr'], {
        ...quiet,
        FACTORY_ROOT: join(dir, 'root'),
        AGENT_PROFILES: join(dir, 'profiles'),
        XDG_DATA_HOME: join(dir, 'xdg'),
        XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      });
      assert.equal(out.code, 0, out.out);
      const repo = join(dir, 'root/app');
      const listed = readFileSync(join(repo, '.gate/kit-files'), 'utf8').split('\n');
      for (const path of [SKILL, '.gate/enforced-rules.md']) {
        assert.equal(readFileSync(join(repo, path), 'utf8'), kit(path), path);
        assert.ok(listed.includes(path), `${path} is listed in .gate/kit-files`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
