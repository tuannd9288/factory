// bin/onboard and a repository's own .claude/settings.json: the kit's deny lines are inserted as text and nothing else
// changes; a shape settings.mjs refuses stops onboard before it writes anything; a repository with none gets the composed file.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { commit, factory, git, run } from './helpers.mjs';
import { addDeny } from '../bin/lib/settings.mjs';
import { SETTINGS, seeded } from './seed-world.mjs';

const KIT_DENY = JSON.parse(readFileSync(join(factory, 'kit/.claude/settings.json'), 'utf8')).permissions.deny;

describe('bin/onboard and .claude/settings.json', () => {
  test('inserts the kit\'s deny lines into the repository\'s own file, and removing the inserted ranges gives its bytes back', () => {
    const s = seeded();
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      const head = s.read('.claude/settings.json');
      const { text, ranges, added } = addDeny(SETTINGS, KIT_DENY);
      assert.equal(head, text);
      assert.ok(added.length > 0 && added.every((line) => KIT_DENY.includes(line)) && !added.includes('Read(./.env*)'), added.join(', '));
      let back = head;
      for (const [from, to] of [...ranges].reverse()) back = back.slice(0, from) + back.slice(to);
      assert.equal(back, SETTINGS);
      const deny = JSON.parse(head).permissions.deny;
      assert.deepEqual([...new Set(deny)], deny, 'a deny line is repeated');
      for (const line of [...KIT_DENY, 'Bash(rm -rf *)']) assert.ok(deny.includes(line), line);
      assert.deepEqual(JSON.parse(head).enabledPlugins, { 'pstack@parcel-notes': true });
    } finally {
      s.cleanup();
    }
  });

  test('refuses a file the lines cannot be added to as text, before it writes anything, and removes the clone', () => {
    for (const bad of ['{\n  // ours\n  "permissions": { "deny": [] }\n}\n', '{\r\n  "permissions": { "deny": [] }\r\n}\r\n', '{ "enabledPlugins": {} }\n']) {
      const s = seeded({ '.claude/settings.json': bad });
      try {
        const out = s.onboard();
        assert.equal(out.code, 2, out.out);
        assert.match(out.out, /\.claude\/settings\.json/);
        assert.match(out.out, /the clone is removed/);
        assert.ok(!existsSync(s.repo), 'the clone is left behind');
        assert.ok(!existsSync(join(s.dir, 'profiles')), 'a profile was made');
      } finally {
        s.cleanup();
      }
    }
  });

  test('lays the kit\'s own file as it is, deny lines only, for a repository that has none', () => {
    const s = seeded({ '.claude/settings.json': null });
    try {
      const out = s.onboard();
      assert.equal(out.code, 0, out.out);
      assert.equal(s.read('.claude/settings.json'), readFileSync(join(factory, 'kit/.claude/settings.json'), 'utf8'));
    } finally {
      s.cleanup();
    }
  });

  test('refuses a .claude/settings.json that is a link or a directory, before it makes a profile, and removes the clone', () => {
    const cases = {
      link: (s) => {
        mkdirSync(join(s.seed, '.claude'), { recursive: true });
        symlinkSync('../shared.json', join(s.seed, '.claude/settings.json'));
        commit(s.seed, { 'shared.json': '{}\n' }, 'link');
        git(s.seed, 'push', '-q', join(s.dir, 'app.git'), 'main');
      },
      directory: () => {},
    };
    for (const [kind, prepare] of Object.entries(cases)) {
      const s = seeded(kind === 'directory' ? { '.claude/settings.json': null, '.claude/settings.json/inner.txt': 'x\n' } : { '.claude/settings.json': null });
      try {
        prepare(s);
        const out = s.onboard();
        assert.equal(out.code, 2, `${kind}: ${out.out}`);
        assert.match(out.out, /\.claude\/settings\.json is not a regular file/);
        assert.match(out.out, /the clone is removed/);
        assert.ok(!existsSync(s.repo), `${kind}: the clone is left behind`);
        assert.ok(!existsSync(join(s.dir, 'profiles')), `${kind}: a profile was made`);
      } finally {
        s.cleanup();
      }
    }
  });
});
