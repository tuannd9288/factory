// bin/kit-update over a repository composed by the old kit (#132): its AGENTS.md is the old kit's head, the pack's section,
// then the repository's own Layout and Facts. The update replaces that head with the Gate block and keeps the tail byte for
// byte; no instruction of the old kit is left beside the block. A composition it does not know is refused, unchanged.
// The old kit's texts are frozen in test/fixtures/legacy/ (the factory's own, from 0830dc3).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commit, git, quiet, run } from './helpers.mjs';
import { world } from './world.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OLD_KIT = readFileSync(join(here, 'fixtures/legacy/kit-AGENTS.md'), 'utf8');
const OLD_PACK = readFileSync(join(here, 'fixtures/legacy/pack-section.md'), 'utf8');
const exact = (w, rev, path) => run(w.repo, 'git', ['show', `${rev}:${path}`], quiet).out;

/** What the old onboard wrote: the kit with the pack's section before "What the Human keeps", the name filled in, and the
 * repository's own bodies under Layout and Facts. */
function composed(name, layout, facts, { finalNewline = true, edit = (t) => t } = {}) {
  const lines = OLD_KIT.split('\n');
  const at = lines.indexOf('## What the Human keeps');
  const merged = [...lines.slice(0, at), ...OLD_PACK.replace(/\n+$/, '').split('\n'), '', ...lines.slice(at)].map((l) => l.replace('<repo>', name));
  const head = merged.slice(0, merged.indexOf('## Layout') + 1);
  const text = [...head, '', ...layout, '', '## Facts the code cannot tell', '', ...facts].join('\n');
  return edit(finalNewline ? `${text}\n` : text);
}
const LAYOUT = ['`src/` holds the app; `test/` its tests.'];
const FACTS = ['- 2026-10-01, the Human: the app ships on Fridays.', '- Its mail goes through one shared inbox.'];

/** A factory whose history holds the old kit (then drops it), and a repository composed by that old kit and merged. */
function legacy({ agents = composed('app', LAYOUT, FACTS) } = {}) {
  const w = world({ onboardArgs: null });
  w.facCommit({ 'kit/AGENTS.md': OLD_KIT, 'packs/pstack/AGENTS.md': OLD_PACK });
  w.facCommit({ 'kit/AGENTS.md': null, 'packs/pstack/AGENTS.md': null });
  git(w.dir, 'clone', '-q', w.url, w.repo);
  commit(w.repo, {
    'AGENTS.md': agents,
    'CLAUDE.md': '@AGENTS.md\n',
    '.gate/pack': 'pstack\n',
    '.gate/kit-files': 'AGENTS.md\nCLAUDE.md\n.gate/kit-files\n.gate/pack\n',
  }, 'Join the factory');
  git(w.repo, 'push', '-q', 'origin', 'main');
  return w;
}

describe('bin/kit-update over a repository composed by the old kit', () => {
  test('replaces the old head with the block, keeps the tail byte for byte, and leaves no old instruction beside the block', () => {
    const w = legacy();
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const baseAgents = exact(w, base, 'AGENTS.md');
      const section = readFileSync(join(w.fac, 'kit/.gate/gate-section.md'), 'utf8');
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      const branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      const tail = baseAgents.slice(baseAgents.indexOf('## Layout'));
      const now = exact(w, branch, 'AGENTS.md');
      assert.equal(now, `# app\n\n${section}\n${tail}`);
      // No line of the old kit's head survives, but those the block or the tail say again.
      const oldHead = OLD_KIT.split('\n').slice(0, OLD_KIT.split('\n').indexOf('## Layout')).filter((l) => l.trim() && l !== '# <repo>');
      const kept = new Set([...section.split('\n'), ...tail.split('\n')]);
      assert.deepEqual(oldHead.filter((l) => now.split('\n').includes(l) && !kept.has(l)), []);
    } finally {
      w.cleanup();
    }
  });

  test('drops .gate/pack and the old inventory lines, adds .gate/kit-commit, and leaves CLAUDE.md alone', () => {
    const w = legacy();
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      const branch = git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD');
      assert.equal(git(w.repo, 'ls-tree', '--name-only', branch, '--', '.gate/pack'), '');
      assert.equal(exact(w, branch, '.gate/kit-commit'), `${git(w.fac, 'rev-parse', 'HEAD')}\n`);
      const inventory = exact(w, branch, '.gate/kit-files').split('\n');
      for (const path of ['AGENTS.md', 'CLAUDE.md', '.gate/pack']) assert.ok(!inventory.includes(path), path);
      assert.ok(inventory.includes('.gate/kit-commit') && inventory.includes('.gate/gate-section.md'));
      assert.equal(exact(w, branch, 'CLAUDE.md'), exact(w, base, 'CLAUDE.md'));
      assert.equal(git(w.repo, 'diff', '--name-only', base, branch, '--', 'CLAUDE.md'), '');
    } finally {
      w.cleanup();
    }
  });

  test('keeps a tail that has no final newline exactly as it is', () => {
    const w = legacy({ agents: composed('app', LAYOUT, FACTS, { finalNewline: false }) });
    try {
      const baseAgents = exact(w, 'HEAD', 'AGENTS.md');
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      const now = exact(w, git(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'AGENTS.md');
      assert.ok(now.endsWith(baseAgents.slice(baseAgents.indexOf('## Layout'))));
      assert.ok(!now.endsWith('\n'));
    } finally {
      w.cleanup();
    }
  });

  test('refuses a composition it does not know, changing nothing', () => {
    const w = legacy({ agents: composed('app', LAYOUT, FACTS, { edit: (t) => t.replace('Run `.gate/bin/setup` once per clone.', 'Run setup first.') }) });
    try {
      const before = w.state();
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /AGENTS\.md/);
      assert.deepEqual(w.state(), before);
    } finally {
      w.cleanup();
    }
  });
});
