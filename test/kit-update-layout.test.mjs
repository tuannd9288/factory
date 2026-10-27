// bin/kit-update on the new layout: it refuses a repository onboarded in the old one, inserts the deny lines the kit has
// gained into the repository's own .claude/settings.json as text, and leaves its own scripts/ and .githooks/ alone.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './helpers.mjs';
import { addDeny } from '../bin/lib/settings.mjs';
import { EXECUTABLE, SEED, SETTINGS } from './seed-world.mjs';
import { world } from './world.mjs';

const { 'AGENTS.md': _agents, ...OWN_FILES } = SEED;
const seededWorld = () => world({ seedFiles: OWN_FILES, seedExecutable: EXECUTABLE });

describe('bin/kit-update on the new layout', () => {
  test('refuses a repository whose kit files list scripts/verify (the old layout), saying to onboard it afresh, and does nothing', () => {
    const w = world();
    try {
      const inventory = readFileSync(join(w.repo, '.gate/kit-files'), 'utf8');
      w.repoCommit({ '.gate/kit-files': `${inventory}scripts/verify\n` });
      const before = w.state();
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /old layout/);
      assert.match(out.out, /scripts\/verify/);
      assert.match(out.out, /onboard it afresh/);
      assert.match(out.out, /nothing done/);
      assert.deepEqual(w.state(), before);
      assert.deepEqual(w.calls(), []);
      // .gate/pack is still written by onboard, so it is no reason to refuse.
      git(w.repo, 'revert', '--no-edit', 'HEAD');
      git(w.repo, 'push', '-q', 'origin', 'main');
      assert.ok(readFileSync(join(w.repo, '.gate/pack'), 'utf8').length > 0);
      const again = w.update(['app', '--no-pr']);
      assert.equal(again.code, 0, again.out);
    } finally {
      w.cleanup();
    }
  });

  test("inserts the deny lines the kit gained into the repository's own settings.json, and leaves its scripts/ and hooks alone", () => {
    const w = seededWorld();
    try {
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const had = readFileSync(join(w.repo, '.claude/settings.json'), 'utf8');
      const kit = JSON.parse(readFileSync(join(w.fac, 'kit/.claude/settings.json'), 'utf8'));
      kit.permissions.deny.push('Bash(curl *)');
      const wanted = kit.permissions.deny;
      w.facCommit({ 'kit/.claude/settings.json': `${JSON.stringify(kit, null, 2)}\n` });
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      const { text, ranges, added } = addDeny(had, wanted);
      assert.deepEqual(added, ['Bash(curl *)']);
      const head = readFileSync(join(w.repo, '.claude/settings.json'), 'utf8');
      assert.equal(head, text);
      let back = head;
      for (const [from, to] of [...ranges].reverse()) back = back.slice(0, from) + back.slice(to);
      assert.equal(back, had);
      assert.deepEqual(JSON.parse(head).enabledPlugins, JSON.parse(SETTINGS).enabledPlugins);
      assert.match(out.out, /^merged \(.*\):\n {2}\.claude\/settings\.json$/m);
      assert.equal(git(w.repo, 'diff', '--name-only', base, 'HEAD', '--', 'scripts', '.githooks'), '');
      assert.match(out.out, /^untouched \(.*\):\n {2}\.githooks\/pre-commit\n {2}\.githooks\/pre-push\n {2}scripts\/size\.mjs\n {2}scripts\/verify$/m);
    } finally {
      w.cleanup();
    }
  });
});
