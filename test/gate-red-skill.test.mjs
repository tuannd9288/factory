// #94: the kit's skill gate-red, laid in every repository like any kit file. Claude Code loads a skill from its front matter
// and its path, so that is all these tests check; nothing here reads what the skill says. The file is read inside each test,
// so a test fails on its own while the skill is missing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

const SKILL = '.claude/skills/gate-red/SKILL.md';
const kit = (path) => readFileSync(join(factory, 'kit', path), 'utf8');

/** The front matter of a SKILL.md: its keys with single-line values, and the body after it. */
function parse(source) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(m, 'SKILL.md starts with a --- front matter block');
  const front = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+): (.*)$/.exec(line);
    assert.ok(kv, `front matter line is "key: value": ${line}`);
    front[kv[1]] = kv[2];
  }
  return { front, body: m[2] };
}

describe('the skill loads', () => {
  test('front matter: the name is the folder\'s and a valid skill name; the description is not empty and at most 1024 characters', () => {
    const { front } = parse(kit(SKILL));
    assert.equal(front.name, SKILL.split('/').at(-2));
    assert.match(front.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(front.name.length <= 64);
    assert.ok(front.description.length > 0 && front.description.length <= 1024, `${front.description.length} characters`);
    assert.ok(front.compatibility === undefined || front.compatibility.length <= 500);
  });

  test('step 5 of the kit\'s AGENTS.md names a skill path that the kit holds', () => {
    const step = /^5\. [\s\S]*?(?=^\d+\. |^## )/m.exec(kit('AGENTS.md'))?.[0] ?? '';
    const named = [...step.matchAll(/`(\.claude\/skills\/[a-z0-9-]+\/SKILL\.md)`/g)].map((m) => m[1]);
    assert.deepEqual(named, [SKILL]);
    assert.ok(kit(named[0]).length > 0);
  });
});

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
