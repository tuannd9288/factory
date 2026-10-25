// Modules (#71): a module's files are copied only into a repository that turns the module on, by bin/onboard --module
// (bin/lib/module.mjs). A module here is a throwaway one, `demo`, added to a copy of the factory.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './helpers.mjs';
import { world } from './world.mjs';

// Loaded inside each test, so a missing module fails a test and not the whole file.
const lib = () => import('../bin/lib/module.mjs');

const DEMO = {
  'modules/demo/kit/scripts/lib/demo.mjs': 'export const demo = 1;\n',
  'modules/demo/kit/scripts/demo-run': '#!/usr/bin/env bash\necho demo\n',
  'modules/demo/kit/.claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo.\n---\n\n# Demo\n',
  'modules/demo/test/demo.test.mjs': '// the factory keeps a module\'s tests here\n',
};
const EXEC = ['modules/demo/kit/scripts/demo-run'];
const DEMO_FILES = ['.claude/skills/demo/SKILL.md', 'scripts/demo-run', 'scripts/lib/demo.mjs'];

describe('.gate/modules', () => {
  test('is a sorted list of module names, one a line; absent or empty means none', async () => {
    const { MODULES_FILE, parseModules } = await lib();
    assert.equal(MODULES_FILE, '.gate/modules');
    assert.deepEqual(parseModules(null), []);
    assert.deepEqual(parseModules(''), []);
    assert.deepEqual(parseModules('alpha\nbeta-2\n'), ['alpha', 'beta-2']);
  });
  for (const [why, text] of [
    ['has no final newline', 'alpha'],
    ['is not sorted', 'beta\nalpha\n'],
    ['names a module twice', 'alpha\nalpha\n'],
    ['holds a blank line', 'alpha\n\nbeta\n'],
    ['holds a name that is not lowercase letters, digits and hyphens', 'Alpha\n'],
    ['holds a path', '../alpha\n'],
    ['holds a comment', '# alpha\n'],
    ['says none', 'none\n'],
  ]) {
    test(`refuses a file that ${why}`, async () => {
      const { parseModules } = await lib();
      assert.throws(() => parseModules(text), /\.gate\/modules/);
    });
  }
});

describe('the factory side', () => {
  test('lists modules/<name>/ and merges their kit/ with the kit, remembering where each file came from', async () => {
    const { mergedTree, moduleNames } = await lib();
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: null });
    try {
      const fac = git(w.fac, 'rev-parse', 'HEAD');
      assert.deepEqual(moduleNames(w.fac, fac), ['deletion-proof', 'demo']);
      const kitOnly = mergedTree(w.fac, fac, []);
      const both = mergedTree(w.fac, fac, ['demo']);
      assert.equal(both.size, kitOnly.size + DEMO_FILES.length);
      assert.deepEqual([...both.keys()].filter((p) => !kitOnly.has(p)).sort(), DEMO_FILES);
      assert.equal(kitOnly.get('scripts/verify').src, 'kit/scripts/verify');
      assert.equal(kitOnly.get('scripts/verify').module, undefined);
      assert.equal(both.get('scripts/demo-run').src, 'modules/demo/kit/scripts/demo-run');
      assert.equal(both.get('scripts/demo-run').module, 'demo');
      assert.equal(both.get('scripts/demo-run').mode, '100755');
      assert.throws(() => mergedTree(w.fac, fac, ['nosuch']), /no module nosuch.*there are: deletion-proof, demo/);
    } finally {
      w.cleanup();
    }
  });

  test('refuses a module file at a kit path, at another module\'s path, or at a generated file of the repository', async () => {
    const { mergedTree } = await lib();
    for (const [why, kit, names, re] of [
      ['a kit path', { 'modules/demo/kit/scripts/verify': 'x\n' }, ['demo'], /scripts\/verify.*module demo.*kit/],
      ['another module\'s path', { 'modules/demo/kit/x.txt': 'a\n', 'modules/other/kit/x.txt': 'b\n' }, ['demo', 'other'], /x\.txt.*modules? (demo|other)/],
      ['.gate/pack', { 'modules/demo/kit/.gate/pack': 'x\n' }, ['demo'], /\.gate\/pack.*generated/],
      ['.gate/modules', { 'modules/demo/kit/.gate/modules': 'x\n' }, ['demo'], /\.gate\/modules.*generated/],
    ]) {
      const w = world({ kit, onboardArgs: null });
      try {
        assert.throws(() => mergedTree(w.fac, git(w.fac, 'rev-parse', 'HEAD'), names), re, why);
      } finally {
        w.cleanup();
      }
    }
  });
});

describe('bin/onboard --module', () => {
  test('lays the module\'s files, writes .gate/modules and lists all in .gate/kit-files', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: ['--module', 'demo'] });
    try {
      for (const f of DEMO_FILES) assert.equal(readFileSync(join(w.repo, f), 'utf8'), readFileSync(join(w.fac, 'modules/demo/kit', f), 'utf8'), f);
      assert.equal(readFileSync(join(w.repo, '.gate/modules'), 'utf8'), 'demo\n');
      assert.notEqual(statSync(join(w.repo, 'scripts/demo-run')).mode & 0o111, 0, 'the mode is kept');
      const inventory = readFileSync(join(w.repo, '.gate/kit-files'), 'utf8').split('\n').filter(Boolean);
      for (const f of [...DEMO_FILES, '.gate/modules', '.gate/pack', '.gate/kit-files', 'scripts/verify']) assert.ok(inventory.includes(f), `${f} is in the inventory`);
      assert.deepEqual([...inventory].sort(), inventory, 'the inventory is sorted');
      assert.ok(!existsSync(join(w.repo, 'modules')) && !existsSync(join(w.repo, 'test/demo.test.mjs')), 'the module\'s tests stay in the factory');
      assert.equal(git(w.repo, 'status', '--porcelain'), '');
    } finally {
      w.cleanup();
    }
  });

  test('copies nothing of a module into a repository that does not turn it on', () => {
    const w = world({ kit: DEMO, executable: EXEC });
    try {
      for (const f of DEMO_FILES) assert.ok(!existsSync(join(w.repo, f)), `${f} is not there`);
      assert.ok(!existsSync(join(w.repo, '.gate/modules')), 'no .gate/modules');
      const inventory = readFileSync(join(w.repo, '.gate/kit-files'), 'utf8');
      assert.doesNotMatch(inventory, /demo|\.gate\/modules/);
      assert.ok(!existsSync(join(w.repo, '.claude/skills')), 'no skills folder');
    } finally {
      w.cleanup();
    }
  });

  test('refuses, before it clones, a module the factory lacks or a name that is no module name', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: null });
    try {
      for (const [name, re] of [['nosuch', /no module nosuch.*there are: deletion-proof, demo/], ['Bad_Name', /no module Bad_Name/]]) {
        const out = w.onboard(['--module', name], { FACTORY_ROOT: join(w.dir, `root-${name}`) });
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, re);
        assert.match(out.out, /nothing done/);
        assert.ok(!existsSync(join(w.dir, `root-${name}`, 'app')), 'nothing was cloned');
      }
    } finally {
      w.cleanup();
    }
  });

  test('refuses a module that lays a kit file, before it clones', () => {
    const w = world({ kit: { 'modules/demo/kit/scripts/verify': 'x\n' }, onboardArgs: null });
    try {
      const out = w.onboard(['--module', 'demo'], { FACTORY_ROOT: join(w.dir, 'root-two') });
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /scripts\/verify.*module demo.*kit/);
      assert.ok(!existsSync(join(w.dir, 'root-two', 'app')));
    } finally {
      w.cleanup();
    }
  });

  test('a file the repository already has at a module path is a conflict: onboard stops and removes its clone', () => {
    // src/math.js is the app's own file in the throwaway repository.
    const w = world({ kit: { 'modules/demo/kit/src/math.js': 'export const add = 0;\n' }, onboardArgs: null });
    try {
      const plain = w.onboard(['--module', 'demo'], { FACTORY_ROOT: join(w.dir, 'root-three') });
      assert.equal(plain.code, 2, plain.out);
      assert.match(plain.out, /src\/math\.js is the repository's own.*module demo/);
      assert.match(plain.out, /clone is removed/);
      assert.ok(!existsSync(join(w.dir, 'root-three', 'app')), 'the clone is removed');
    } finally {
      w.cleanup();
    }
  });

  test('without --module the default is the repository\'s own .gate/modules; one it names that the factory lacks is refused', () => {
    const w = world({ kit: DEMO, executable: EXEC, onboardArgs: null });
    try {
      // A repository that names a module in .gate/modules before onboarding (a hand-written file): the default.
      for (const [modules, code] of [['demo\n', 0], ['nosuch\n', 2]]) {
        const clone = join(w.dir, `edit-${code}`);
        git(w.dir, 'clone', '-q', w.url, clone);
        git(clone, 'switch', '-q', '-c', 'edit');
        git(clone, 'config', 'user.name', 'test');
        git(clone, 'config', 'user.email', 'test@localhost');
        mkdirSync(join(clone, '.gate'), { recursive: true });
        writeFileSync(join(clone, '.gate/modules'), modules);
        git(clone, 'add', '-A');
        git(clone, 'commit', '-qm', 'name a module');
        git(clone, 'push', '-q', 'origin', 'edit:main');
        const out = w.onboard([], { FACTORY_ROOT: join(w.dir, `root-${code}`) });
        assert.equal(out.code, code, out.out);
        if (code === 0) {
          assert.equal(readFileSync(join(w.dir, `root-${code}`, 'app', '.gate/modules'), 'utf8'), 'demo\n');
          assert.ok(existsSync(join(w.dir, `root-${code}`, 'app', 'scripts/lib/demo.mjs')));
        } else {
          assert.match(out.out, /\.gate\/modules: no module nosuch/);
          assert.ok(!existsSync(join(w.dir, `root-${code}`, 'app')), 'the clone is removed');
        }
      }
    } finally {
      w.cleanup();
    }
  });
});

