// bin/kit-evidence: the kit pull request's files against a factory commit, over git objects only, on fixtures.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const DENY = { permissions: { deny: ['Read(./.env*)'] } };
const PIN = { enabledPlugins: { 'pstack@pin': true } };
const SECTION = '## Where pstack yields\n\nIt yields.\n\n';
const KEEPS = '## What the Human keeps\n\n- Tier 3.\n';
// A pack, as the factory commit holds it: bin/lib/pack.mjs composes it with the kit.
const PACKS = { 'packs/pstack/settings.json': json(PIN), 'packs/pstack/AGENTS.md': SECTION };

const KIT = {
  'kit/AGENTS.md': `# <repo>\n\nRules for <repo> and <repo>.\n\n${KEEPS}`,
  'kit/.claude/settings.json': json(DENY),
  'kit/.github/CODEOWNERS': '* @OWNER\n/.gate/ @OWNER\n',
  'kit/.github/pull_request_template.md': '## Tóm tắt\n',
  'kit/scripts/verify': '#!/usr/bin/env bash\necho ok\n',
};

/** A factory with the kit above (and `kit`'s files) and `packs` at one commit, and a repository whose main holds its own
 * files and `had`; on factory/kit, what bin/onboard lays for `pack`, with `laid` over it. */
function world({ kit: more = {}, had = {}, laid = {}, packs = PACKS, pack = 'pstack' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  const fac = join(dir, 'factory');
  mkdirSync(fac);
  git(fac, 'init', '-q', '-b', 'main');
  write(fac, { ...KIT, ...more, ...packs });
  for (const path of Object.keys(more)) if (/\.githooks\//.test(path)) chmodSync(join(fac, path), 0o755);
  chmodSync(join(fac, 'kit/scripts/verify'), 0o755);
  symlinkSync('scripts/verify', join(fac, 'kit/verify'));
  const kit = commit(fac, {}, 'kit');
  const repo = join(dir, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, { 'README.md': '# app\n', '.github/pull_request_template.md': '## Our own\n', ...had });
  for (const path of Object.keys(had)) if (/^\.githooks\//.test(path)) chmodSync(join(repo, path), 0o755);
  const base = commit(repo, {}, 'start');
  git(repo, 'switch', '-q', '-c', 'factory/kit');
  // What bin/onboard lays: every kit file the repository lacks, the two rendered ones, and the inventory.
  const inventory = [...Object.keys({ ...KIT, ...more }).map((p) => p.slice(4)), 'verify', '.gate/kit-files', '.gate/pack'].sort();
  write(repo, {
    'AGENTS.md': `# app\n\nRules for app and <repo>.\n\n${pack === 'pstack' ? SECTION : ''}${KEEPS}`,
    '.claude/settings.json': json(pack === 'pstack' ? { ...DENY, ...PIN } : DENY),
    '.gate/pack': `${pack}\n`,
    '.github/CODEOWNERS': '* @tuannd9288\n/.gate/ @tuannd9288\n',
    'scripts/verify': KIT['kit/scripts/verify'],
    ...laid,
    '.gate/kit-files': `${inventory.join('\n')}\n`,
  });
  for (const path of Object.keys(laid)) if (/^\.githooks\//.test(path)) chmodSync(join(repo, path), 0o755);
  chmodSync(join(repo, 'scripts/verify'), 0o755);
  symlinkSync('scripts/verify', join(repo, 'verify'));
  const head = commit(repo, {}, 'Join the factory');
  const evidence = (rev = 'HEAD', extra = []) =>
    run(dir, join(factory, 'bin/kit-evidence'), ['--factory', fac, '--commit', kit, '--repo', repo, '--base', base, '--head', rev, '--slug', 'tuannd9288/app', '--id', '1234', ...extra]);
  const change = (files, mode) => {
    write(repo, files);
    if (mode) mode();
    return commit(repo, {}, 'change');
  };
  return { dir, repo, kit, base, head, evidence, change, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The kit's AGENTS.md ends with the two sections a repository fills, and its own instructions and hook, which onboard
// lays over the repository's: a repository that had its own AGENTS.md, CLAUDE.md and pre-commit hook.
const SECTIONED = `# <repo>\n\nRules for <repo>.\n\n${KEEPS}\n## Layout\n\n<The directories.>\n\n## Facts the code cannot tell\n\n<Decisions.>\n`;
const HOOK = '#!/usr/bin/env bash\nexec scripts/verify --fast\n';
const OWN_LAYOUT = ['`src/` holds the app; `test/` its tests.'];
const OWN_FACTS = ['- 2026-10-01, the Human: the app ships on Fridays.', '- Its mail goes through one shared inbox.'];
const filled = (layout = OWN_LAYOUT, facts = OWN_FACTS) =>
  `# app\n\nRules for app.\n\n${SECTION}${KEEPS}\n## Layout\n\n${layout.join('\n')}\n\n## Facts the code cannot tell\n\n${facts.join('\n')}\n`;
const replacing = (laid = {}) =>
  world({
    kit: { 'kit/AGENTS.md': SECTIONED, 'kit/CLAUDE.md': '@AGENTS.md\n', 'kit/.githooks/pre-commit': HOOK },
    had: { 'AGENTS.md': '# Our map\n\nOur rules.\n', 'CLAUDE.md': '@AGENTS.md\n\nMore of our rules.\n', '.githooks/pre-commit': '#!/bin/sh\nmake lint\n' },
    laid: { 'AGENTS.md': filled(), 'CLAUDE.md': '@AGENTS.md\n', '.githooks/pre-commit': HOOK, ...laid },
  });

describe('kit evidence', () => {
  test('binds the factory commit, the kit tree, the repository id, base and head; shows rendering and kept files apart', () => {
    const w = world();
    try {
      const out = w.evidence();
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, new RegExp(`^factory commit: ${w.kit}, kit tree [0-9a-f]{40}$`, 'm'));
      assert.match(out.out, /^repository: tuannd9288\/app \(id 1234\)$/m);
      assert.match(out.out, new RegExp(`^base: ${w.base}$`, 'm'));
      assert.match(out.out, new RegExp(`^head: ${w.head}$`, 'm'));
      assert.match(out.out, /^managed files: 8: 2 as in the kit, 3 rendered, 1 kept, 2 generated$/m);
      assert.match(out.out, /^pack: pstack$/m);
      assert.match(out.out, /^ {2}AGENTS\.md:1: `# <repo>` → `# app`$/m);
      assert.match(out.out, /^ {2}AGENTS\.md:3: `Rules for <repo> and <repo>\.` → `Rules for app and <repo>\.`$/m);
      assert.match(out.out, /^ {2}\.github\/CODEOWNERS:2: `\/\.gate\/ @OWNER` → `\/\.gate\/ @tuannd9288`$/m);
      assert.match(out.out, /^kept \(the repository's own, unchanged\):\n {2}\.github\/pull_request_template\.md$/m);
    } finally {
      w.cleanup();
    }
  });

  test('fails on a mode, a content or a symlink that is not the kit\'s', () => {
    const w = world();
    try {
      w.change({}, () => chmodSync(join(w.repo, 'scripts/verify'), 0o644));
      let out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^kit-evidence: FAIL$/m);
      assert.match(out.out, /^ {2}differs: scripts\/verify \(mode 100644, the kit's 100755\)$/m);
      w.change({ 'scripts/verify': '#!/usr/bin/env bash\necho fine\n' }, () => chmodSync(join(w.repo, 'scripts/verify'), 0o755));
      out = w.evidence();
      assert.match(out.out, /^ {2}differs: scripts\/verify \(content\)$/m);
      w.change({ 'scripts/verify': KIT['kit/scripts/verify'] }, () => {
        rmSync(join(w.repo, 'verify'));
        symlinkSync('scripts/other', join(w.repo, 'verify'));
      });
      out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.doesNotMatch(out.out, /scripts\/verify \(/);
      assert.match(out.out, /^ {2}differs: verify \(content\)$/m);
      w.change({ 'AGENTS.md': '# app\n\nRules for app and app.\n' });
      out = w.evidence();
      assert.match(out.out, /^ {2}differs: AGENTS\.md \(content\)$/m);
      // Left as the kit has it, unrendered: not what bin/onboard writes.
      w.change({ 'AGENTS.md': KIT['kit/AGENTS.md'] });
      out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: AGENTS\.md \(content\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('fails on a managed file missing, a file the kit does not manage, a kept file changed and a wrong inventory', () => {
    const w = world();
    try {
      w.change({ '.github/CODEOWNERS': null, 'src/extra.js': 'export {};\n', '.github/pull_request_template.md': '## Changed\n', '.gate/kit-files': 'AGENTS.md\n' });
      const out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}missing: \.github\/CODEOWNERS$/m);
      assert.match(out.out, /^ {2}extra: src\/extra\.js \(not a kit file\)$/m);
      assert.match(out.out, /^ {2}differs: \.github\/pull_request_template\.md \(the repository's own, changed\)$/m);
      assert.match(out.out, /^ {2}differs: \.gate\/kit-files \(not the kit's inventory\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('names each file the kit replaced with the blob the repository had, and shows its own parts in full', () => {
    const w = replacing();
    try {
      const out = w.evidence();
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      const was = (path) => git(w.repo, 'rev-parse', `${w.base}:${path}`).slice(0, 12);
      assert.match(
        out.out,
        new RegExp(`^replaced \\(the repository's own at the base, now the kit's\\):\n {2}\\.githooks/pre-commit \\(was ${was('.githooks/pre-commit')}\\)\n {2}AGENTS\\.md \\(was ${was('AGENTS.md')}\\)\n {2}CLAUDE\\.md \\(was ${was('CLAUDE.md')}\\)$`, 'm'),
      );
      assert.match(out.out, /^ {2}AGENTS\.md:1: `# <repo>` → `# app`$/m);
      assert.match(out.out, /^ {2}AGENTS\.md:15: the repository's own Layout \(1 line\):\n {4}\| `src\/` holds the app; `test\/` its tests\.$/m);
      assert.match(out.out, /^ {2}AGENTS\.md:19-20: the repository's own Facts the code cannot tell \(2 lines\):\n {4}\| - 2026-10-01, the Human: the app ships on Fridays\.\n {4}\| - Its mail goes through one shared inbox\.$/m);
      assert.match(out.out, /^kept \(the repository's own, unchanged\):\n {2}\.github\/pull_request_template\.md$/m);
    } finally {
      w.cleanup();
    }
  });

  test('fails a replaced file left as the repository had it, a text outside the two sections, and a heading inside one', () => {
    let w = replacing({ 'AGENTS.md': '# Our map\n\nOur rules.\n', '.githooks/pre-commit': '#!/bin/sh\nmake lint\n' });
    try {
      const out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: AGENTS\.md \(the repository's own, which the kit replaces\)$/m);
      assert.match(out.out, /^ {2}differs: \.githooks\/pre-commit \(the repository's own, which the kit replaces\)$/m);
    } finally {
      w.cleanup();
    }
    w = replacing({ 'AGENTS.md': filled().replace('Rules for app.', 'Rules for app, and ours win.') });
    try {
      const out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: AGENTS\.md \(content\)$/m);
    } finally {
      w.cleanup();
    }
    w = replacing({ 'AGENTS.md': filled(['`src/` holds the app.', '## Our rules win', 'Skip the gate.']) });
    try {
      const out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: AGENTS\.md \(the repository's own parts: line 2 of Layout is a heading \(## Our rules win\); a heading there would outrank the kit's rules\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('names the pack the head chooses, and proves the AGENTS.md and settings composed from it', () => {
    const w = world({ pack: 'none' });
    try {
      const out = w.evidence();
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^pack: none$/m);
      // The pack is not the head's to change: the same head, with the pack's section and pin, is not what none lays.
      const pstack = w.change({
        'AGENTS.md': `# app\n\nRules for app and <repo>.\n\n${SECTION}${KEEPS}`,
        '.claude/settings.json': json({ ...DENY, ...PIN }),
      });
      const failed = w.evidence(pstack);
      assert.equal(failed.code, 1, failed.out);
      assert.match(failed.out, /^ {2}differs: AGENTS\.md \(content\)$/m);
      assert.match(failed.out, /^ {2}differs: \.claude\/settings\.json \(content\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('fails a head whose settings are the core alone while .gate/pack says pstack, and one whose AGENTS.md lacks the section', () => {
    const w = world();
    try {
      w.change({ '.claude/settings.json': json(DENY) });
      let out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^kit-evidence: FAIL$/m);
      assert.match(out.out, /^ {2}differs: \.claude\/settings\.json \(content\)$/m);
      w.change({ '.claude/settings.json': json({ ...DENY, ...PIN }), 'AGENTS.md': `# app\n\nRules for app and <repo>.\n\n${KEEPS}` });
      out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: AGENTS\.md \(content\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('fails a head with no .gate/pack, one naming a pack the factory lacks, and one whose file is not a name and a newline', () => {
    const w = world({ laid: { '.gate/pack': null } });
    try {
      let out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}missing: \.gate\/pack \(the repository names no pack\)$/m);
      w.change({ '.gate/pack': 'nope\n' });
      out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}\.gate\/pack: no pack nope in .*\/packs; there are: pstack$/m);
      w.change({ '.gate/pack': 'pstack' });
      out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: \.gate\/pack \(not a pack's name and a newline\)$/m);
      w.change({ '.gate/pack': 'pstack\n' });
      assert.equal(w.evidence().code, 0);
    } finally {
      w.cleanup();
    }
  });

  test('reads the pack from the factory commit\'s tree, not from the working tree', () => {
    const w = world();
    try {
      // The factory's working tree changes after the commit the evidence names; the commit decides.
      const fac = join(w.dir, 'factory');
      writeFileSync(join(fac, 'packs/pstack/settings.json'), json({ enabledPlugins: { 'other@pin': true } }));
      rmSync(join(fac, 'packs/pstack/AGENTS.md'));
      const out = w.evidence();
      assert.equal(out.code, 0, out.out);
    } finally {
      w.cleanup();
    }
  });

  test('refuses to run without the repository id it binds', () => {
    const w = world();
    try {
      const out = run(w.dir, join(factory, 'bin/kit-evidence'), ['--factory', w.dir, '--commit', w.kit, '--repo', w.repo, '--base', w.base, '--head', w.head, '--slug', 'tuannd9288/app']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /usage: bin\/kit-evidence/);
    } finally {
      w.cleanup();
    }
  });
});

// A gh that answers what bin/onboard asks on its pull request path, as the agents' account, and keeps the body.
const ONBOARD_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const said = (s) => { process.stdout.write(s + '\n'); process.exit(0); };
if (a[0] === 'api' && a[1] === 'user') said('tuan9288-agent');
if (a[0] === 'api' && a[1] === 'repos/tuannd9288/app/rules/branches/main') said('[{"type":"pull_request"}]');
if (a[0] === 'api' && a[1] === 'repos/tuannd9288/app') said('1234');
if (a[0] === 'repo' && a[1] === 'view') said('tuannd9288/app');
if (a[0] === 'label') process.exit(0);
if (a[0] === 'pr' && a[1] === 'create') { fs.writeFileSync(process.env.PR_BODY, a[a.indexOf('--body') + 1]); said('https://github.com/tuannd9288/app/pull/1'); }
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

/** A committed copy of this factory, with origin/main at its head, a bare repository seeded with the app and `files`,
 * and a gh that answers onboard as the agents' account; onboard(root, ...args) runs onboard's pull request path. */
function prWorld(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-evidence-'));
  // A copy of this factory, committed, so the test holds whatever the working tree has in it.
  const fac = join(dir, 'factory');
  const tracked = git(factory, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n');
  for (const f of tracked.filter((f) => f && existsSync(join(factory, f)))) {
    mkdirSync(dirname(join(fac, f)), { recursive: true });
    copyFileSync(join(factory, f), join(fac, f));
    chmodSync(join(fac, f), statSync(join(factory, f)).mode);
  }
  git(fac, 'init', '-q', '-b', 'main');
  const facHead = commit(fac, {}, 'factory');
  git(fac, 'update-ref', 'refs/remotes/origin/main', facHead);
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  write(seed, { ...APP, ...files });
  for (const hook of Object.keys(files).filter((p) => p.startsWith('.githooks/'))) chmodSync(join(seed, hook), 0o755);
  commit(seed, {}, 'start');
  const url = join(dir, 'remote/tuannd9288/app.git');
  git(dir, 'clone', '-q', '--bare', seed, url);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), ONBOARD_GH);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  const body = join(dir, 'body.md');
  const onboard = (root, ...args) =>
    run(dir, join(fac, 'bin/onboard'), [url, ...args], {
      ...quiet,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      PR_BODY: body,
      FACTORY_ROOT: join(dir, root),
      AGENT_PROFILES: join(dir, 'profiles'),
      XDG_DATA_HOME: join(dir, 'xdg'),
      XDG_CONFIG_HOME: join(dir, 'xdg-config'),
    });
  return { dir, fac, body, onboard, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the kit pull request', () => {
  test('carries the evidence, and opens only from a factory commit on main whose kit has no change outside it', () => {
    const w = prWorld();
    try {
      const { dir, fac, body, onboard } = w;
      appendFileSync(join(fac, 'kit/scripts/verify'), '# not committed\n');
      let out = onboard('dirty');
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /the factory's kit has changes no commit holds/);
      assert.ok(!existsSync(join(dir, 'dirty/app')), 'cloned before refusing');
      const ahead = commit(fac, {}, 'not on main');
      out = onboard('ahead');
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, new RegExp(`the factory's commit ${ahead.slice(0, 7)} is not on its origin/main`));
      git(fac, 'update-ref', 'refs/remotes/origin/main', ahead);

      out = onboard('root');
      assert.equal(out.code, 0, out.out);
      const text = readFileSync(body, 'utf8');
      assert.match(text, /^kit-evidence: PASS$/m);
      assert.match(text, /^pack: pstack$/m);
      assert.match(text, new RegExp(`^factory commit: ${ahead}, kit tree [0-9a-f]{40}$`, 'm'));
      assert.match(text, /^repository: tuannd9288\/app \(id 1234\)$/m);
      const head = git(join(dir, 'root/app'), 'rev-parse', 'HEAD');
      assert.match(text, new RegExp(`^head: ${head}$`, 'm'));
      // The Human's next step, ready to copy: the repository's own id, not a placeholder.
      assert.match(text, /`bin\/onboard-owner tuannd9288\/app --id 1234 --apply`/);
      assert.match(text, new RegExp(`bin/kit-evidence --factory <factory> --commit ${ahead} --repo <clone> --base [0-9a-f]{40} --head ${head} --slug tuannd9288/app --id 1234`));
      assert.match(text, /^## File repo đã có, kit đã thay\n {2}- không có$/m);
      // Nothing replaced, no --own: nothing to say about own parts or an old hook.
      assert.doesNotMatch(text, /--own|gate_fast/);
    } finally {
      w.cleanup();
    }
  });

  test('tells the Human that the gate check verify is red on this pull request, and why it does not block', () => {
    const w = prWorld();
    try {
      const out = w.onboard('root');
      assert.equal(out.code, 0, out.out);
      const text = readFileSync(w.body, 'utf8');
      assert.match(text, /^Lưu ý: check `verify` của PR này đỏ \(`scripts\/verify-trusted: No such file`, mã 127\) vì `main` chưa có kit; nó không chặn merge, vì `factory-bootstrap` không đòi check nào\.$/m);
    } finally {
      w.cleanup();
    }
  });

  test("says in its body and its evidence which of the repository's files the kit replaced, and where the old hook's commands go", () => {
    const w = prWorld({ 'AGENTS.md': '# Our map\n\nOur rules.\n', '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' });
    try {
      writeFileSync(join(w.dir, 'own.md'), '## Layout\n\n`src/` holds the app.\n\n## Facts the code cannot tell\n\n- Ships on Fridays.\n');
      const out = w.onboard('root', '--own', join(w.dir, 'own.md'));
      assert.equal(out.code, 0, out.out);
      const text = readFileSync(w.body, 'utf8');
      assert.match(text, /^## File repo đã có, kit đã thay\n {2}- `\.githooks\/pre-commit`\n {2}- `AGENTS\.md`\n/m);
      assert.match(text, /`gate_fast` trong `\.gate\/config\.sh`/);
      assert.match(text, /Phần riêng của repo mà anh đã duyệt \(`--own`\)/);
      assert.match(text, /^replaced \(the repository's own at the base, now the kit's\):\n {2}\.githooks\/pre-commit \(was [0-9a-f]{12}\)\n {2}AGENTS\.md \(was [0-9a-f]{12}\)$/m);
      assert.match(text, /^ {2}AGENTS\.md:\d+: the repository's own Layout \(1 line\):\n {4}\| `src\/` holds the app\.$/m);
    } finally {
      w.cleanup();
    }
  });
});
