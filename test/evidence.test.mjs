// bin/kit-evidence: the kit pull request's files against a factory commit, over git objects only, on fixtures.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

const KIT = {
  'kit/AGENTS.md': '# <repo>\n\nRules for <repo> and <repo>.\n',
  'kit/.github/CODEOWNERS': '* @OWNER\n/.gate/ @OWNER\n',
  'kit/.github/pull_request_template.md': '## Tóm tắt\n',
  'kit/scripts/verify': '#!/usr/bin/env bash\necho ok\n',
};

/** A factory with the kit above at one commit, and a repository whose main holds its own files. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  const fac = join(dir, 'factory');
  mkdirSync(fac);
  git(fac, 'init', '-q', '-b', 'main');
  write(fac, KIT);
  chmodSync(join(fac, 'kit/scripts/verify'), 0o755);
  symlinkSync('scripts/verify', join(fac, 'kit/verify'));
  const kit = commit(fac, {}, 'kit');
  const repo = join(dir, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const base = commit(repo, { 'README.md': '# app\n', '.github/pull_request_template.md': '## Our own\n' }, 'start');
  git(repo, 'switch', '-q', '-c', 'factory/kit');
  // What bin/onboard lays: every kit file the repository lacks, the two rendered ones, and the inventory.
  write(repo, {
    'AGENTS.md': '# app\n\nRules for app and <repo>.\n',
    '.github/CODEOWNERS': '* @tuannd9288\n/.gate/ @tuannd9288\n',
    'scripts/verify': KIT['kit/scripts/verify'],
    '.gate/kit-files': ['.gate/kit-files', '.github/CODEOWNERS', '.github/pull_request_template.md', 'AGENTS.md', 'scripts/verify', 'verify'].join('\n') + '\n',
  });
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
      assert.match(out.out, /^managed files: 6: 2 as in the kit, 2 rendered, 1 kept, 1 generated$/m);
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

describe('the kit pull request', () => {
  test('carries the evidence, and opens only from a factory commit on main whose kit has no change outside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-evidence-'));
    try {
      // A copy of this factory, committed, so the test holds whatever the working tree has in it.
      const fac = join(dir, 'factory');
      const files = git(factory, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n');
      for (const f of files.filter((f) => f && existsSync(join(factory, f)))) {
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
      commit(seed, APP, 'start');
      const url = join(dir, 'remote/tuannd9288/app.git');
      git(dir, 'clone', '-q', '--bare', seed, url);
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin/gh'), ONBOARD_GH);
      chmodSync(join(dir, 'bin/gh'), 0o755);
      const body = join(dir, 'body.md');
      const onboard = (root) =>
        run(dir, join(fac, 'bin/onboard'), [url], {
          ...quiet,
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          PR_BODY: body,
          FACTORY_ROOT: join(dir, root),
          AGENT_PROFILES: join(dir, 'profiles'),
          XDG_DATA_HOME: join(dir, 'xdg'),
          XDG_CONFIG_HOME: join(dir, 'xdg-config'),
        });

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
      assert.match(text, new RegExp(`^factory commit: ${ahead}, kit tree [0-9a-f]{40}$`, 'm'));
      assert.match(text, /^repository: tuannd9288\/app \(id 1234\)$/m);
      const head = git(join(dir, 'root/app'), 'rev-parse', 'HEAD');
      assert.match(text, new RegExp(`^head: ${head}$`, 'm'));
      // The Human's next step, ready to copy: the repository's own id, not a placeholder.
      assert.match(text, /`bin\/onboard-owner tuannd9288\/app --id 1234 --apply`/);
      assert.match(text, new RegExp(`bin/kit-evidence --factory <factory> --commit ${ahead} --repo <clone> --base [0-9a-f]{40} --head ${head} --slug tuannd9288/app --id 1234`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
