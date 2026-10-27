// bin/kit-evidence over a module's files (#71): they are judged as the kit's are, but stricter. A module file is as in the
// module, or updated from a past module blob; never kept as the repository's own, and once the module is off, removed.
// .gate/modules is generated: a hand edit that names a module without its files, or the files without the name, fails.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { commit, factory, git, run, write } from './helpers.mjs';

const BLOCK = readFileSync(join(factory, 'kit/.gate/gate-section.md'), 'utf8');
const KIT = {
  'kit/.gate/gate-section.md': BLOCK,
  'kit/.claude/settings.json': '{\n  "permissions": {\n    "deny": [\n      "Read(./.env*)"\n    ]\n  }\n}\n',
  'kit/.github/CODEOWNERS': '* @OWNER\n/.gate/ @OWNER\n',
  'kit/scripts/verify': '#!/usr/bin/env bash\necho ok\n',
};
const MOD = (name, files) => Object.fromEntries(Object.entries(files).map(([path, text]) => [`modules/${name}/kit/${path}`, text]));
const DEMO = { 'scripts/lib/demo.mjs': 'export const demo = 2;\n', '.claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo.\n---\n' };
const OTHER = { 'scripts/lib/other.mjs': 'export const other = 1;\n' };
const DEMO_V1 = { 'scripts/lib/demo.mjs': 'export const demo = 1;\n' };
const DEMO_PATHS = Object.keys(DEMO);

/** A factory whose last commit holds the kit, `demo` and `other`, after `old` (an earlier commit, for past blobs); a
 * repository whose main holds `had`; on factory/kit, what onboard lays for the modules `on`, with `laid` over it. */
function world({ on = ['demo'], old = null, had = {}, laid = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-module-'));
  const fac = join(dir, 'factory');
  mkdirSync(fac);
  git(fac, 'init', '-q', '-b', 'main');
  if (old) commit(fac, old, 'older');
  write(fac, { ...KIT, ...MOD('demo', DEMO), ...MOD('other', OTHER) });
  chmodSync(join(fac, 'kit/scripts/verify'), 0o755);
  const kit = commit(fac, {}, 'kit');
  const repo = join(dir, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, { 'README.md': '# app\n', ...had });
  const base = commit(repo, {}, 'start');
  git(repo, 'switch', '-q', '-c', 'factory/kit');
  const files = { demo: DEMO, other: OTHER };
  const modules = Object.fromEntries(on.flatMap((m) => Object.entries(files[m])));
  const inventory = [...Object.keys(KIT).map((p) => p.slice(4)), ...Object.keys(modules), '.gate/kit-files', '.gate/kit-commit', ...(on.length ? ['.gate/modules'] : [])].sort();
  write(repo, {
    'AGENTS.md': `# app\n\n${BLOCK}`,
    'CLAUDE.md': '@AGENTS.md\n',
    '.gate/gate-section.md': BLOCK,
    '.claude/settings.json': KIT['kit/.claude/settings.json'],
    '.github/CODEOWNERS': '* @tuannd9288\n/.gate/ @tuannd9288\n',
    'scripts/verify': KIT['kit/scripts/verify'],
    ...modules,
    '.gate/kit-commit': `${kit}\n`,
    ...(on.length ? { '.gate/modules': `${on.join('\n')}\n` } : {}),
    ...laid,
    '.gate/kit-files': `${inventory.join('\n')}\n`,
  });
  chmodSync(join(repo, 'scripts/verify'), 0o755);
  const head = commit(repo, {}, 'Join the factory');
  const evidence = (extra = []) =>
    run(dir, join(factory, 'bin/kit-evidence'), ['--factory', fac, '--commit', kit, '--repo', repo, '--base', base, '--head', head, '--slug', 'tuannd9288/app', '--id', '1234', ...extra]);
  return { dir, repo, fac, kit, evidence, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fails = (out) => {
  const lines = out.out.split('\n');
  const rest = lines.slice(lines.indexOf('failures:') + 1);
  return rest.slice(0, rest.findIndex((l) => !l.startsWith('  ')));
};

/** Runs the evidence on a world made with `options`, and calls `check` with its output; the world is cleaned up. */
const given = (options, check) => {
  const w = world(options);
  try {
    check(w.evidence(), w);
  } finally {
    w.cleanup();
  }
};

describe('bin/kit-evidence with modules', () => {
  test('passes a repository that turns a module on: its files are the module\'s, .gate/modules is generated', () =>
    given({}, (out) => {
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, /^modules: demo$/m);
      assert.match(out.out, /^managed files: 9: 5 as in the kit, 1 rendered, 0 kept, 3 generated$/m);
    }));

  test('says nothing of modules for a repository that turns none on', () =>
    given({ on: [] }, (out) => {
      assert.equal(out.code, 0, out.out);
      assert.doesNotMatch(out.out, /modules:/);
      assert.match(out.out, /^managed files: 6: 3 as in the kit, 1 rendered, 0 kept, 2 generated$/m);
    }));

  test('passes two modules, sorted', () =>
    given({ on: ['demo', 'other'] }, (out) => {
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^modules: demo, other$/m);
    }));

  test('fails .gate/modules naming a module whose files are missing', () =>
    given({ laid: { 'scripts/lib/demo.mjs': null } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.deepEqual(fails(out), ['  missing: scripts/lib/demo.mjs']);
    }));

  test('fails a module\'s files with no .gate/modules naming it, whether the inventory lists them or not', () => {
    given({ laid: { '.gate/modules': null } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /differs: \.gate\/kit-files \(not the kit's inventory\)/);
    });
    // An inventory written to match: the files are then paths the pull request changes outside the inventory.
    const w = world({ laid: { '.gate/modules': null, '.gate/kit-files': `${['.claude/settings.json', '.github/CODEOWNERS', '.gate/kit-files', '.gate/pack', 'AGENTS.md', 'scripts/verify'].sort().join('\n')}\n` } });
    try {
      const out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /extra: scripts\/lib\/demo\.mjs \(not a kit file\)/);
    } finally {
      w.cleanup();
    }
  });

  test('fails a module the factory commit lacks', () =>
    given({ laid: { '.gate/modules': 'nosuch\n' } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /\.gate\/modules: no module nosuch in [0-9a-f]+\/modules; there are: demo, other/);
    }));

  test('fails a .gate/modules that is empty, unsorted, or has no final newline', () => {
    for (const [text, why] of [['', 'empty'], ['other\ndemo\n', 'unsorted'], ['demo', 'no newline']]) {
      given({ on: ['demo', 'other'], laid: { '.gate/modules': text } }, (out) => {
        assert.equal(out.code, 1, `${why}: ${out.out}`);
        assert.match(out.out, /differs: \.gate\/modules/, why);
      });
    }
  });

  test('fails a .gate/modules whose mode is not 100644', () => {
    const w = world();
    try {
      chmodSync(join(w.repo, '.gate/modules'), 0o755);
      commit(w.repo, {}, 'mode');
      const head = git(w.repo, 'rev-parse', 'HEAD');
      const out = run(w.dir, join(factory, 'bin/kit-evidence'), ['--factory', w.fac, '--commit', w.kit, '--repo', w.repo, '--base', 'main', '--head', head, '--slug', 'tuannd9288/app', '--id', '1234']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /differs: \.gate\/modules \(mode 100755\)/);
    } finally {
      w.cleanup();
    }
  });

  test('fails a module file whose content or mode is not the module\'s, hand-edited code that red-check would run', () => {
    given({ laid: { 'scripts/lib/demo.mjs': 'export const demo = 3;\n' } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /differs: scripts\/lib\/demo\.mjs \(content, module demo\)/);
    });
    const w = world();
    try {
      chmodSync(join(w.repo, 'scripts/lib/demo.mjs'), 0o755);
      commit(w.repo, {}, 'mode');
      const out = run(w.dir, join(factory, 'bin/kit-evidence'), ['--factory', w.fac, '--commit', w.kit, '--repo', w.repo, '--base', 'main', '--head', git(w.repo, 'rev-parse', 'HEAD'), '--slug', 'tuannd9288/app', '--id', '1234']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /differs: scripts\/lib\/demo\.mjs \(mode 100755, the module's 100644, module demo\)/);
    } finally {
      w.cleanup();
    }
  });

  test('never keeps the repository\'s own file at a module path: it fails whether the pull request leaves it or replaces it', () => {
    given({ had: { 'scripts/lib/demo.mjs': 'ours\n' } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /differs: scripts\/lib\/demo\.mjs \(the repository's own, at a path module demo lays\)/);
    });
    given({ had: { 'scripts/lib/demo.mjs': 'ours\n' }, laid: { 'scripts/lib/demo.mjs': 'ours\n' } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /differs: scripts\/lib\/demo\.mjs/);
    });
  });

  test('shows a module file as updated when the base held a past blob of it, and fails any other blob', () => {
    const old = MOD('demo', DEMO_V1);
    given({ old, had: { 'scripts/lib/demo.mjs': DEMO_V1['scripts/lib/demo.mjs'], '.gate/modules': 'demo\n' } }, (out) => {
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^updated \(.*\):\n {2}scripts\/lib\/demo\.mjs \(was [0-9a-f]{12}, module demo at factory [0-9a-f]{7}\)$/m);
    });
    given({ old, had: { 'scripts/lib/demo.mjs': 'export const demo = 1.5;\n' } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /the repository's own, at a path module demo lays/);
    });
  });

  test('a module turned off is removed: its files go with .gate/modules, shown as removed, and none is left', () => {
    const had = { ...DEMO, '.gate/modules': 'demo\n', '.gate/kit-files': `${[...DEMO_PATHS, '.gate/modules'].join('\n')}\n` };
    const gone = { 'scripts/lib/demo.mjs': null, '.claude/skills/demo/SKILL.md': null, '.gate/modules': null };
    given({ on: [], had, laid: gone }, (out) => {
      assert.equal(out.code, 0, out.out);
      assert.doesNotMatch(out.out, /modules:/);
      assert.match(out.out, /^removed \(.*\):\n {2}\.claude\/skills\/demo\/SKILL\.md \(was [0-9a-f]{12}, module demo is off at factory [0-9a-f]{7}\)\n {2}scripts\/lib\/demo\.mjs \(was/m);
    });
    given({ on: [], had, laid: { '.claude/skills/demo/SKILL.md': null, '.gate/modules': null } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /left: scripts\/lib\/demo\.mjs \(module demo is off, so its files go\)/);
    });
  });

  test('a module file the repository changed is not removed with the module: that fails, never "kept"', () => {
    const had = { ...DEMO, 'scripts/lib/demo.mjs': 'ours\n', '.gate/modules': 'demo\n', '.gate/kit-files': `${[...DEMO_PATHS, '.gate/modules'].join('\n')}\n` };
    given({ on: [], had, laid: { 'scripts/lib/demo.mjs': null, '.claude/skills/demo/SKILL.md': null, '.gate/modules': null } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /extra: scripts\/lib\/demo\.mjs \(not a kit file\)/);
    });
  });

  test('fails, never swallows, a base that names a module the factory commit no longer has', () =>
    given({ on: [], had: { '.gate/modules': 'gone\n' }, laid: { '.gate/modules': null } }, (out) => {
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /the base's \.gate\/modules: no module gone in [0-9a-f]+\/modules; there are: demo, other/);
    }));
});
