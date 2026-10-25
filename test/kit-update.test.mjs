// bin/kit-update: brings an onboarded repository up to a factory commit, from throwaway repositories, a local bare
// origin and a fake gh. Nothing here touches the network or a real repository.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP, commit, factory, git, quiet, run, write } from './helpers.mjs';

import { world } from './world.mjs';


const OWN = '## Layout\n\n`src/` holds the app.\n\n## Facts the code cannot tell\n\n- Ships on Fridays.\n';


const blob = (repo, rev, path) => git(repo, 'rev-parse', `${rev}:${path}`).slice(0, 12);

describe('bin/kit-update', () => {
  test('on a repository that already holds the kit rendered, adds only .gate/pack and its inventory lines (#53)', () => {
    const w = world();
    try {
      // What the first hand-made kit pull requests found: the rendered files are the kit's, and .gate/pack is missing.
      const inventory = readFileSync(join(w.repo, '.gate/kit-files'), 'utf8').split('\n').filter(Boolean);
      w.repoCommit({ '.gate/pack': null, '.gate/kit-files': `${inventory.filter((l) => l !== '.gate/pack' && l !== 'scripts/lib/budget.mjs').join('\n')}\n` });
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const before = w.state();
      const sha7 = w.sha7();
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, /--no-pr/);
      assert.equal(git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), `factory/kit-${sha7}`);
      const changed = git(w.repo, 'diff', '--name-only', base, 'HEAD').split('\n');
      assert.deepEqual(changed, ['.gate/kit-files', '.gate/pack']);
      assert.deepEqual(git(w.repo, 'diff', '-U0', base, 'HEAD', '--', '.gate/kit-files').split('\n').filter((l) => /^[+-][^+-]/.test(l)), ['+.gate/pack', '+scripts/lib/budget.mjs']);
      assert.equal(w.show('HEAD', '.gate/pack'), 'pstack');
      assert.equal(git(w.repo, 'log', '-1', '--format=%s'), `Bring the kit up to factory main ${sha7}`);
      assert.match(git(w.repo, 'log', '-1', '--format=%b'), new RegExp(git(w.fac, 'rev-parse', 'HEAD')));
      // The three rendered files are reported as rendered, and none as kept or replaced.
      assert.match(out.out, /^ {2}AGENTS\.md:1: /m);
      assert.match(out.out, /^replaced \(the repository's own at the base, now the kit's\):\n {2}none$/m);
      assert.doesNotMatch(out.out, /^ {2}(AGENTS\.md|\.github\/CODEOWNERS|\.claude\/settings\.json)$/m);
      // --no-pr: nothing pushed, and gh was never asked anything.
      assert.deepEqual(w.state().remote, before.remote);
      assert.deepEqual(w.calls(), []);
    } finally {
      w.cleanup();
    }
  });

  test('replaces a stale kit file, adds a missing one, keeps and names the repository\'s own, removes a dropped one, and opens the pull request', () => {
    const w = world({ kit: { 'kit/.gate/old-a.txt': 'old a\n', 'kit/.gate/old-b.txt': 'old b\n' } });
    try {
      // The repository's own changes at the base: a file it fills in, a dropped kit file it edited, the Layout and Facts
      // of its AGENTS.md, and a kit file it lacks.
      writeFileSync(join(w.dir, 'own.md'), OWN);
      assert.equal(run(w.repo, 'node', [join(w.fac, 'bin/lib/own.mjs'), 'fill', join(w.dir, 'own.md'), join(w.repo, 'AGENTS.md')]).code, 0);
      w.repoCommit({ '.gate/config.sh': `${readFileSync(join(w.repo, '.gate/config.sh'), 'utf8')}# ours\n`, '.gate/old-b.txt': 'ours b\n', '.github/pull_request_template.md': null });
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const promptWas = blob(w.repo, base, 'scripts/lib/reviewer-prompt.md');
      const codeownersWas = blob(w.repo, base, '.github/CODEOWNERS');
      const agentsWas = blob(w.repo, base, 'AGENTS.md');
      // The factory moves on: a changed file, a changed rendered file, a changed AGENTS.md, a new file, two dropped.
      const kitFile = (p) => readFileSync(join(w.fac, p), 'utf8');
      w.facCommit({
        'kit/scripts/lib/reviewer-prompt.md': `${kitFile('kit/scripts/lib/reviewer-prompt.md')}\nA new line.\n`,
        'kit/.github/CODEOWNERS': `/docs/ @OWNER\n${kitFile('kit/.github/CODEOWNERS')}`,
        'kit/AGENTS.md': kitFile('kit/AGENTS.md').replace('\n## What the Human keeps', '\nKit marker line.\n\n## What the Human keeps'),
        'kit/.gate/new-c.txt': 'new c\n',
        'kit/.gate/old-a.txt': null,
        'kit/.gate/old-b.txt': null,
      });
      const sha7 = w.sha7();
      const full = git(w.fac, 'rev-parse', 'HEAD');
      const out = w.update(['app']);
      assert.equal(out.code, 0, out.out);
      const branch = `factory/kit-${sha7}`;
      assert.equal(git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
      const rev = branch;
      assert.match(git(w.dir, '--git-dir', w.url, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), new RegExp(`refs/heads/${branch}`));
      // Stale: replaced by the kit's. Missing: added. Dropped and stale: removed; dropped and the repository's own: kept.
      assert.equal(w.show(rev, 'scripts/lib/reviewer-prompt.md'), kitFile('kit/scripts/lib/reviewer-prompt.md').trim());
      assert.equal(w.show(rev, '.github/pull_request_template.md'), kitFile('kit/.github/pull_request_template.md').trim());
      assert.equal(w.show(rev, '.gate/new-c.txt'), 'new c');
      assert.throws(() => w.show(rev, '.gate/old-a.txt'));
      assert.equal(w.show(rev, '.gate/old-b.txt'), 'ours b');
      // The repository's own change to a file the kit does not replace is kept.
      assert.match(w.show(rev, '.gate/config.sh'), /# ours$/);
      // Rendered files: CODEOWNERS and AGENTS.md come up to date, and AGENTS.md keeps the repository's own parts.
      assert.match(w.show(rev, '.github/CODEOWNERS'), /^\/docs\/ @tuannd9288$/m);
      assert.match(w.show(rev, 'AGENTS.md'), /^Kit marker line\.$/m);
      assert.match(w.show(rev, 'AGENTS.md'), /^`src\/` holds the app\.$/m);
      assert.match(w.show(rev, 'AGENTS.md'), /^- Ships on Fridays\.$/m);
      const inventory = w.show(rev, '.gate/kit-files').split('\n');
      assert.ok(inventory.includes('.gate/new-c.txt') && inventory.includes('.gate/pack'));
      assert.ok(!inventory.includes('.gate/old-a.txt') && !inventory.includes('.gate/old-b.txt'));
      // The evidence, in the output and in the body.
      const text = readFileSync(w.body, 'utf8');
      for (const seen of [out.out, text]) {
        assert.match(seen, /^kit-evidence: PASS$/m);
        assert.match(seen, new RegExp(`^ {2}scripts/lib/reviewer-prompt\\.md \\(was ${promptWas}, kit at factory ${sha7}\\)$`, 'm'));
        assert.match(seen, new RegExp(`^ {2}\\.github/CODEOWNERS \\(was ${codeownersWas}, kit at factory ${sha7}\\)$`, 'm'));
        assert.match(seen, new RegExp(`^ {2}AGENTS\\.md \\(was ${agentsWas}, kit at factory ${sha7}\\)$`, 'm'));
        assert.match(seen, /^kept \(the repository's own, unchanged\):\n(?: {2}.*\n)* {2}\.gate\/config\.sh$/m);
        assert.match(seen, /^removed \(.*\):\n {2}\.gate\/old-a\.txt \(was [0-9a-f]{12}, no longer in the kit at factory /m);
      }
      assert.match(text, /\.gate\/old-b\.txt/);
      // The commit and the pull request.
      assert.equal(git(w.repo, 'log', '-1', '--format=%s', rev), `Bring the kit up to factory main ${sha7}`);
      assert.match(git(w.repo, 'log', '-1', '--format=%b', rev), new RegExp(full));
      assert.equal(readFileSync(w.title, 'utf8'), `Bring the kit up to factory main ${sha7}`);
      const lines = text.split('\n');
      assert.deepEqual(lines.slice(0, 3).map((l) => l.split(':**')[0]), ['**What changed', '**Effect', '**Evidence']);
      // A blank line between, or the rule would turn the third line into a heading.
      assert.deepEqual(lines.slice(3, 5), ['', '---']);
      assert.match(text, new RegExp(`tuannd9288/factory.*${full.slice(0, 7)}`));
      // gh: the login and the rule were checked, the labels made, and no call began with api.
      const calls = w.calls();
      assert.ok(calls.some((c) => c.startsWith('auth status')), calls.join('\n'));
      assert.ok(calls.some((c) => c.startsWith('ruleset check')), calls.join('\n'));
      assert.equal(calls.filter((c) => c.startsWith('label create')).length, 6);
      assert.equal(calls.filter((c) => c.startsWith('pr create')).length, 1);
      assert.ok(calls.every((c) => !c.startsWith('api')), calls.join('\n'));
    } finally {
      w.cleanup();
    }
  });

  test('fails a repository\'s own CLAUDE.md, AGENTS.md or hook, which the kit replaces, and does nothing', () => {
    const w = world();
    try {
      for (const files of [{ 'CLAUDE.md': 'Our rules.\n' }, { 'AGENTS.md': '# Ours\n\nOur rules.\n' }, { '.githooks/pre-commit': '#!/bin/sh\nmake lint\n' }]) {
        const [path] = Object.keys(files);
        w.repoCommit(files);
        const before = w.state();
        const out = w.update(['app', '--no-pr']);
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, new RegExp(path.replaceAll('.', '\\.')));
        assert.match(out.out, /by hand/);
        assert.match(out.out, /nothing done/);
        assert.deepEqual(w.state(), before);
        assert.deepEqual(w.calls(), []);
        git(w.repo, 'revert', '--no-edit', 'HEAD');
        git(w.repo, 'push', '-q', 'origin', 'main');
      }
      assert.equal(w.update(['app', '--no-pr']).code, 0);
    } finally {
      w.cleanup();
    }
  });

  test('refuses, saying why and changing nothing, when the clone, the factory, the branch or the login is wrong', () => {
    const w = world();
    try {
      const refuses = (pattern, args = ['app'], more = {}) => {
        const before = w.state();
        const out = w.update(args, more);
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, pattern);
        assert.match(out.out, /nothing done/);
        assert.deepEqual(w.state(), before);
        assert.ok(!w.calls().some((c) => c.startsWith('pr create') || c.startsWith('label create')), 'opened a pull request');
        assert.ok(!existsSync(w.body), 'wrote a pull request body');
      };
      refuses(/not a git clone/, ['nosuch']);
      refuses(/unknown argument/, ['app', '--frobnicate']);
      // A dirty clone: an untracked file, then a modified one.
      writeFileSync(join(w.repo, 'stray.txt'), 'x\n');
      refuses(/uncommitted changes/);
      rmSync(join(w.repo, 'stray.txt'));
      writeFileSync(join(w.repo, 'README.md'), '# changed\n');
      refuses(/uncommitted changes/);
      git(w.repo, 'checkout', '--', 'README.md');
      // The factory's kit has a change no commit holds, then its HEAD is not on origin/main.
      const verify = join(w.fac, 'kit/scripts/verify');
      const text = readFileSync(verify, 'utf8');
      writeFileSync(verify, `${text}# not committed\n`);
      refuses(/the factory's kit has changes no commit holds/);
      writeFileSync(verify, text);
      const ahead = w.facCommit({ 'kit/.gate/ahead.txt': 'a\n' }, { onMain: false });
      refuses(new RegExp(`the factory's commit ${ahead.slice(0, 7)} is not on its origin/main`));
      git(w.fac, 'update-ref', 'refs/remotes/origin/main', ahead);
      const branch = `factory/kit-${w.sha7()}`;
      // The branch exists here, then on origin only.
      git(w.repo, 'branch', branch);
      refuses(new RegExp(`${branch} already exists here`));
      git(w.repo, 'branch', '-q', '-D', branch);
      git(w.repo, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      refuses(new RegExp(`${branch} already exists on origin`));
      git(w.repo, 'push', '-q', 'origin', `:refs/heads/${branch}`);
      // Another login, and a main with no pull request rule; --no-pr asks gh nothing, so neither stops it.
      refuses(/not as someone-else/, ['app'], { GH_LOGIN: 'someone-else' });
      refuses(/main has no pull request rule/, ['app'], { NO_RULE: '1' });
      // A repository that never had the kit: origin/main has no .gate/kit-files.
      w.repoCommit({ '.gate/kit-files': null });
      refuses(/never onboarded/);
      assert.ok(w.calls().every((c) => !c.startsWith('api')));
    } finally {
      w.cleanup();
    }
  });

  test('takes a repository URL for its name, and does nothing, leaving no branch, when the repository already holds the kit', () => {
    const w = world();
    try {
      const before = w.state();
      const out = w.update([w.url, '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /already holds the kit at factory [0-9a-f]{7}; nothing to do/);
      assert.deepEqual(w.state(), before);
      assert.deepEqual(w.calls(), []);
    } finally {
      w.cleanup();
    }
  });

  test('leaves the branch committed and nothing pushed when the repository\'s own verify fails', () => {
    const w = world();
    try {
      w.repoCommit({ 'src/math.js': 'export function add(a, b) {\n  return a - b;\n}\n' });
      const kitFile = join(w.fac, 'kit/scripts/lib/reviewer-prompt.md');
      w.facCommit({ 'kit/scripts/lib/reviewer-prompt.md': `${readFileSync(kitFile, 'utf8')}\nA new line.\n` });
      const before = w.state();
      const out = w.update(['app']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /scripts\/verify fails/);
      const branch = `factory/kit-${w.sha7()}`;
      assert.equal(git(w.repo, 'log', '-1', '--format=%s', branch), `Bring the kit up to factory main ${w.sha7()}`);
      assert.equal(w.state().remote, before.remote);
      assert.ok(!w.calls().some((c) => c.startsWith('pr create') || c.startsWith('label create')), w.calls().join('\n'));
      assert.ok(!existsSync(w.body));
    } finally {
      w.cleanup();
    }
  });
});

// Review of 1a13447 (#53).
describe('bin/kit-update, after review', () => {
  const touch = (w) => {
    const file = join(w.fac, 'kit/scripts/lib/reviewer-prompt.md');
    w.facCommit({ 'kit/scripts/lib/reviewer-prompt.md': `${readFileSync(file, 'utf8')}\nA new line.\n` });
  };

  test('goes back to a detached HEAD, and leaves no branch, when there is nothing to do', () => {
    const w = world();
    try {
      git(w.repo, 'switch', '-q', '--detach', 'main');
      const heads = () => git(w.repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
      const before = { head: w.state().head, heads: heads() };
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /nothing to do/);
      assert.deepEqual({ head: w.state().head, heads: heads() }, before);
      assert.equal(git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
    } finally {
      w.cleanup();
    }
  });

  test('leaves the branch committed and nothing pushed when the kit evidence fails', () => {
    const w = world();
    try {
      touch(w);
      writeFileSync(join(w.fac, 'bin/kit-evidence'), '#!/usr/bin/env bash\necho "kit-evidence: FAIL"\nexit 1\n');
      const before = w.state();
      const out = w.update(['app']);
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /kit evidence fails/);
      assert.equal(git(w.repo, 'log', '-1', '--format=%s', `factory/kit-${w.sha7()}`), `Bring the kit up to factory main ${w.sha7()}`);
      assert.equal(w.state().remote, before.remote);
      assert.ok(!w.calls().some((c) => c.startsWith('pr create') || c.startsWith('label create')), w.calls().join('\n'));
      assert.ok(!existsSync(w.body));
    } finally {
      w.cleanup();
    }
  });

  test('refuses when gh\'s active login does not authenticate', () => {
    const w = world();
    try {
      // gh auth status exits 0 under --json whatever the token is; only the plain form tells.
      mkdirSync(join(w.dir, 'bin2'));
      writeFileSync(join(w.dir, 'bin2/gh'), `#!/bin/sh\ncase "$*" in\n  "auth status --active --hostname github.com") echo "token invalid" >&2; exit 1 ;;\nesac\nexec ${join(w.dir, 'bin/gh')} "$@"\n`);
      chmodSync(join(w.dir, 'bin2/gh'), 0o755);
      const before = w.state();
      const out = w.update(['app'], { PATH: `${join(w.dir, 'bin2')}:${join(w.dir, 'bin')}:${process.env.PATH}` });
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /does not authenticate/);
      assert.match(out.out, /nothing done/);
      assert.deepEqual(w.state(), before);
    } finally {
      w.cleanup();
    }
  });

  test('names a kept settings.json in the summary lines, words the removed heading for any past version, and fences evidence that holds a fence', () => {
    const w = world({ kit: { 'kit/.gate/old-a.txt': 'old a\n' } });
    try {
      const settings = JSON.parse(readFileSync(join(w.repo, '.claude/settings.json'), 'utf8'));
      settings.permissions.deny.push('Read(./secrets/**)');
      writeFileSync(join(w.dir, 'own.md'), '## Layout\n\n```text\nsrc/\n```\n\n## Facts the code cannot tell\n\n- Ships on Fridays.\n');
      assert.equal(run(w.repo, 'node', [join(w.fac, 'bin/lib/own.mjs'), 'fill', join(w.dir, 'own.md'), join(w.repo, 'AGENTS.md')]).code, 0);
      w.repoCommit({ '.claude/settings.json': `${JSON.stringify(settings, null, 2)}\n` });
      touch(w);
      w.facCommit({ 'kit/.gate/old-a.txt': null });
      const out = w.update(['app']);
      assert.equal(out.code, 0, out.out);
      const body = readFileSync(w.body, 'utf8');
      const lines = body.split('\n');
      assert.match(lines.slice(0, 3).join('\n'), /`\.claude\/settings\.json`[^\n]*is its own, so it is kept[^\n]*deny rules/);
      assert.equal(lines.filter((l) => /^```(?!`)/.test(l)).length, 0, 'a 3-backtick fence opens the evidence');
      assert.equal(lines.filter((l) => l === '````text').length, 1);
      assert.equal(lines.filter((l) => l === '````').length, 1);
      assert.ok(lines.includes('Removed (the kit dropped them; the repository held a past kit version unchanged):'), lines.join('\n'));
    } finally {
      w.cleanup();
    }
  });

  test('says a merge by hand is needed when an older AGENTS.md has no Layout section', () => {
    const real = readFileSync(join(factory, 'kit/AGENTS.md'), 'utf8');
    const w = world({ kit: { 'kit/AGENTS.md': `${real.split('\n## Layout')[0]}\n` } });
    try {
      w.facCommit({ 'kit/AGENTS.md': real });
      const before = w.state();
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /AGENTS\.md.*## Layout.*by hand|by hand.*AGENTS\.md/s);
      assert.match(out.out, /nothing done/);
      assert.deepEqual(w.state(), before);
    } finally {
      w.cleanup();
    }
  });

  test('takes a settings.json equal to the raw kit blob, and an AGENTS.md without the pack\'s section, as the repository\'s own; reads inventory paths literally', () => {
    const w = world();
    try {
      touch(w);
      const section = readFileSync(join(w.fac, 'packs/pstack/AGENTS.md'), 'utf8').replace(/\n+$/, '');
      const agents = readFileSync(join(w.repo, 'AGENTS.md'), 'utf8');
      assert.ok(agents.includes(`${section}\n\n`));
      w.repoCommit({ 'AGENTS.md': agents.replace(`${section}\n\n`, '') });
      let before = w.state();
      let out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /AGENTS\.md/);
      assert.match(out.out, /nothing done/);
      assert.deepEqual(w.state(), before);
      git(w.repo, 'revert', '--no-edit', 'HEAD');
      git(w.repo, 'push', '-q', 'origin', 'main');
      // The pack's keys are out of settings.json, which then equals the kit's raw blob; and the repository lists a file
      // by a name that globs onto a kit file.
      const raw = readFileSync(join(w.fac, 'kit/.claude/settings.json'), 'utf8');
      const config = readFileSync(join(w.repo, '.gate/config.sh'), 'utf8');
      const inventory = readFileSync(join(w.repo, '.gate/kit-files'), 'utf8');
      w.repoCommit({ '.claude/settings.json': raw, '.gate/config?sh': config, '.gate/kit-files': `${inventory}.gate/config?sh\n` });
      before = w.state();
      out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.equal(w.show('HEAD', '.claude/settings.json'), raw.trim());
      assert.match(out.out, /^kept \(the repository's own, unchanged\):\n(?: {2}.*\n)* {2}\.claude\/settings\.json$/m);
      assert.equal(w.show('HEAD', '.gate/config?sh'), config.trim());
    } finally {
      w.cleanup();
    }
  });
});
