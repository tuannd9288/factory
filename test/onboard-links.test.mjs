// Two behaviours that outlived the code whose tests were retired with it (#132, REVIEW-3 N7), tested where they live now:
// bin/onboard never writes through a link at a file it generates, and a kit-update of a repository whose settings.json is a
// rendering of the old kit with the pstack pin takes it as the repository's own file with the deny lines inserted.
// Both hold already, so these pass as soon as they are written.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, git } from './helpers.mjs';
import { addDeny } from '../bin/lib/settings.mjs';
import { seeded } from './seed-world.mjs';
import { world } from './world.mjs';

describe('bin/onboard replaces a generated file the repository holds as a link, never writing through it', () => {
  test('.gate/kit-commit and .gate/kit-files', () => {
    const outside = mkdtempSync(join(tmpdir(), 'onboard-links-'));
    const links = {};
    for (const name of ['kit-commit', 'kit-files']) {
      writeFileSync(join(outside, name), 'theirs\n');
      links[`.gate/${name}`] = join(outside, name);
    }
    const s = seeded({ '.gate/README': 'the repository keeps a .gate folder of its own\n' }, { own: false, links });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      for (const name of ['kit-commit', 'kit-files']) {
        assert.equal(readFileSync(join(outside, name), 'utf8'), 'theirs\n', `onboard wrote through .gate/${name}`);
        assert.ok(!lstatSync(join(s.repo, '.gate', name)).isSymbolicLink(), `.gate/${name} is still a link`);
      }
      assert.equal(readFileSync(join(s.repo, '.gate/kit-commit'), 'utf8'), `${git(factory, 'rev-parse', 'HEAD')}\n`);
    } finally {
      s.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('bin/kit-update over a settings.json that is a rendering of the old kit with the pstack pin', () => {
  test('takes it as the repository\'s own file: the kit\'s new deny lines are inserted, every other byte and the pin stay', () => {
    const w = world();
    try {
      const kit = JSON.parse(readFileSync(join(w.fac, 'kit/.claude/settings.json'), 'utf8'));
      const pin = JSON.parse(readFileSync(join(w.fac, 'packs/pstack/settings.json'), 'utf8'));
      // What the old onboard wrote for a repository with none: the kit's keys and the pack's, two-space JSON.
      const legacy = `${JSON.stringify({ ...kit, ...pin }, null, 2)}\n`;
      w.repoCommit({ '.claude/settings.json': legacy });
      const base = git(w.repo, 'rev-parse', 'HEAD');
      const grown = { ...kit, permissions: { ...kit.permissions, deny: [...kit.permissions.deny, 'Bash(curl *)'] } };
      w.facCommit({ 'kit/.claude/settings.json': `${JSON.stringify(grown, null, 2)}\n` });
      const out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      const now = readFileSync(join(w.repo, '.claude/settings.json'), 'utf8');
      assert.equal(now, addDeny(legacy, grown.permissions.deny).text);
      assert.notEqual(now, legacy);
      assert.deepEqual(JSON.parse(now).enabledPlugins, pin.enabledPlugins);
      assert.deepEqual(JSON.parse(now).extraKnownMarketplaces, pin.extraKnownMarketplaces);
      assert.equal(git(w.repo, 'diff', '--name-only', base, 'HEAD', '--', '.claude/settings.json'), '.claude/settings.json');
    } finally {
      w.cleanup();
    }
  });
});
