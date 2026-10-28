// bin/kit-update with modules (#71): --module <name> turns one on, --no-module <name> off, and with neither the base's
// .gate/modules stands. A module's files are added, updated from past module blobs and removed as the kit's are, but
// stricter: the repository's own file at a module path is a conflict, never kept, and a file left after turning the
// module off is removed, never kept. From throwaway repositories and a fake gh, as test/kit-update.test.mjs does.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './helpers.mjs';
import { world } from './world.mjs';

const DEMO = {
  'modules/demo/kit/scripts/lib/demo.mjs': 'export const demo = 1;\n',
  'modules/demo/kit/scripts/demo-run': '#!/usr/bin/env bash\necho demo\n',
  'modules/demo/kit/.claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo.\n---\n\n# Demo\n',
};
const EXEC = ['modules/demo/kit/scripts/demo-run'];
const FILES = ['.claude/skills/demo/SKILL.md', 'scripts/demo-run', 'scripts/lib/demo.mjs'];
const changed = (w, base) => git(w.repo, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
const refused = (w, out, re) => {
  assert.equal(out.code, 2, out.out);
  assert.match(out.out, re);
  assert.match(out.out, /nothing done/);
  assert.doesNotMatch(git(w.repo, 'branch', '--list'), /factory\/kit-/, 'no branch was made');
};

describe('bin/lib/module.mjs updateModules', () => {
  test('adds and removes names, sorted, and refuses a name in both', async () => {
    const { updateModules } = await import('../bin/lib/module.mjs');
    assert.deepEqual(updateModules(['b'], ['a'], []), ['a', 'b']);
    assert.deepEqual(updateModules(['a', 'b'], [], ['a']), ['b']);
    assert.deepEqual(updateModules(['a'], ['a'], []), ['a']);
    assert.deepEqual(updateModules([], [], ['x']), []);
    assert.throws(() => updateModules([], ['a'], ['a']), /--module and --no-module both name a/);
  });
});

describe('bin/kit-update --module / --no-module', () => {
  test('--module turns a module on: adds its files, .gate/modules and inventory lines, and opens the pull request naming it', () => {
    const w = world({ kit: DEMO, executable: EXEC });
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const out = w.update(['app', '--module', 'demo']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, /^modules: demo$/m);
      assert.deepEqual(changed(w, base), ['.claude/skills/demo/SKILL.md', '.gate/kit-files', '.gate/modules', 'scripts/demo-run', 'scripts/lib/demo.mjs']);
      assert.equal(w.show('HEAD', '.gate/modules'), 'demo');
      assert.match(w.show('HEAD', '.gate/kit-files'), /^scripts\/lib\/demo\.mjs$/m);
      assert.match(git(w.repo, 'log', '-1', '--format=%b'), /Added: 3\./);
      const body = readFileSync(w.body, 'utf8');
      assert.match(body, /`\.gate\/modules`.*`demo`|`demo`.*`\.gate\/modules`/);
      assert.match(body, /^- `scripts\/lib\/demo\.mjs`$/m);
    } finally {
      w.cleanup();
    }
  });

  test('with neither flag the base\'s modules stand: a changed module file is updated, a new one added, a dropped one removed', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: ['--module', 'demo'] });
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      w.facCommit({ 'modules/demo/kit/scripts/lib/demo.mjs': 'export const demo = 2;\n', 'modules/demo/kit/scripts/lib/more.mjs': 'export const more = 1;\n', 'modules/demo/kit/scripts/demo-run': null });
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, /^modules: demo$/m);
      assert.deepEqual(changed(w, base), ['.gate/kit-commit', '.gate/kit-files', 'scripts/demo-run', 'scripts/lib/demo.mjs', 'scripts/lib/more.mjs']);
      assert.equal(w.show('HEAD', 'scripts/lib/demo.mjs'), 'export const demo = 2;');
      assert.equal(w.show('HEAD', '.gate/modules'), 'demo');
      assert.match(out.out, /^updated \(.*\):\n {2}scripts\/lib\/demo\.mjs \(was [0-9a-f]{12}, module demo at factory/m);
      assert.match(out.out, /^removed \(.*\):\n {2}scripts\/demo-run \(was/m);
    } finally {
      w.cleanup();
    }
  });

  test('--no-module turns it off: files, .gate/modules and inventory lines go, and the evidence passes', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: ['--module', 'demo'] });
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const out = w.update(['app', '--no-pr', '--no-module', 'demo']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.doesNotMatch(out.out, /^modules:/m);
      assert.deepEqual(changed(w, base), ['.claude/skills/demo/SKILL.md', '.gate/kit-files', '.gate/modules', 'scripts/demo-run', 'scripts/lib/demo.mjs']);
      for (const f of [...FILES, '.gate/modules']) assert.ok(!existsSync(join(w.repo, f)), `${f} is gone`);
      assert.doesNotMatch(w.show('HEAD', '.gate/kit-files'), /demo|\.gate\/modules/);
      assert.match(git(w.repo, 'log', '-1', '--format=%b'), /Removed: 3\./);
    } finally {
      w.cleanup();
    }
  });

  test('--no-module for a module that is not on does nothing to the files', () => {
    const w = world({ kit: DEMO, executable: EXEC });
    try {
      const out = w.update(['app', '--no-pr', '--no-module', 'demo']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /already holds the kit/);
    } finally {
      w.cleanup();
    }
  });

  test('a repository already on the factory commit with its module on has nothing to update', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: ['--module', 'demo'] });
    try {
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /already holds the kit at factory/);
    } finally {
      w.cleanup();
    }
  });

  test('a module file the repository changed is a conflict, never kept: the update stops while the module is on', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: ['--module', 'demo'] });
    try {
      w.repoCommit({ 'scripts/lib/demo.mjs': 'ours\n' });
      const out = w.update(['app', '--no-pr']);
      refused(w, out, /scripts\/lib\/demo\.mjs: .*repository's own.*module demo/);
    } finally {
      w.cleanup();
    }
  });

  test('turning a module off does not keep a file the repository changed: the update stops', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: ['--module', 'demo'] });
    try {
      w.repoCommit({ 'scripts/lib/demo.mjs': 'ours\n' });
      const out = w.update(['app', '--no-pr', '--no-module', 'demo']);
      refused(w, out, /scripts\/lib\/demo\.mjs: .*repository's own.*module demo/);
    } finally {
      w.cleanup();
    }
  });

  test('the repository\'s own file at a path the module lays is a conflict when the module is turned on', () => {
    // src/math.js is the app's own file.
    const w = world({ kit: { ...DEMO, 'modules/demo/kit/src/math.js': 'export const add = 0;\n' } });
    try {
      refused(w, w.update(['app', '--no-pr', '--module', 'demo']), /src\/math\.js: .*repository's own.*module demo/);
    } finally {
      w.cleanup();
    }
  });

  test('refuses a module the factory lacks, a name in both flags, and a .gate/modules the base cannot read', () => {
    const w = world({ kit: DEMO, executable: EXEC });
    try {
      refused(w, w.update(['app', '--no-pr', '--module', 'nosuch']), /no module nosuch.*there are: deletion-proof, demo/);
      refused(w, w.update(['app', '--no-pr', '--module', 'demo', '--no-module', 'demo']), /--module and --no-module both name demo/);
      w.repoCommit({ '.gate/modules': 'demo' });
      refused(w, w.update(['app', '--no-pr']), /\.gate\/modules: not a list of names/);
    } finally {
      w.cleanup();
    }
  });

  test('a repository that never turned a module on gets none of its files from a plain update', () => {
    const w = world({ kit: DEMO, executable: EXEC });
    try {
      w.facCommit({ 'modules/demo/kit/scripts/lib/demo.mjs': 'export const demo = 2;\n' });
      const out = w.update(['app', '--no-pr']);
      assert.match(out.out, /already holds the kit|kit committed/);
      for (const f of FILES) assert.ok(!existsSync(join(w.repo, f)), `${f} is not there`);
      assert.ok(!existsSync(join(w.repo, '.gate/modules')));
    } finally {
      w.cleanup();
    }
  });

  test('stops, never carries on, when the base names a module the factory lacks and --no-module would turn it off', () => {
    const w = world({ kit: DEMO, executable: EXEC });
    try {
      w.repoCommit({ '.gate/modules': 'gone\n' });
      refused(w, w.update(['app', '--no-pr', '--no-module', 'gone']), /the base's \.gate\/modules: no module gone.*there are: .*demo/);
    } finally {
      w.cleanup();
    }
  });
});
