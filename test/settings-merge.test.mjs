// bin/lib/settings.mjs: the kit's deny lines added to a repository's own .claude/settings.json as text, so that every
// other byte stays. The shapes are the pig repositories' (a one-line deny array, a multi-line one, no permissions key);
// anything else is refused with a message.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run, write } from './helpers.mjs';

const load = () => import(join(factory, 'bin/lib/settings.mjs'));
const WANT = ['Read(./.env*)', 'Bash(git tag:*)'];
const PIN = '"enabledPlugins": {\n    "pstack@x": true\n  }';

const SHAPES = {
  'a multi-line deny array': `{\n  "permissions": {\n    "deny": [\n      "Read(./.env*)",\n      "Bash(rm -rf *)"\n    ]\n  },\n  ${PIN}\n}\n`,
  'a multi-line deny array indented with tabs': '{\n\t"permissions": {\n\t\t"deny": [\n\t\t\t"Bash(rm -rf *)"\n\t\t]\n\t}\n}\n',
  'a one-line deny array': `{\n  "permissions": { "deny": ["Bash(rm -rf *)"] },\n  ${PIN}\n}\n`,
  'no permissions key': `{\n  ${PIN}\n}\n`,
};

/** The text with the inserted ranges cut out. */
const without = (text, ranges) => ranges.reduceRight((t, [from, to]) => t.slice(0, from) + t.slice(to), text);

describe('addDeny', () => {
  for (const [name, text] of Object.entries(SHAPES)) {
    test(`${name}: the missing lines go in, and cutting what was inserted gives the original byte for byte`, async () => {
      const { addDeny } = await load();
      const out = addDeny(text, WANT);
      assert.deepEqual(JSON.parse(out.text).permissions.deny.filter((d) => WANT.includes(d)), WANT);
      assert.equal(without(out.text, out.ranges), text);
      assert.deepEqual(JSON.parse(out.text).enabledPlugins, JSON.parse(text).enabledPlugins);
    });

    test(`${name}: a second call changes nothing`, async () => {
      const { addDeny } = await load();
      const once = addDeny(text, WANT);
      const twice = addDeny(once.text, WANT);
      assert.equal(twice.text, once.text);
      assert.deepEqual(twice.ranges, []);
    });
  }

  test('a line the file already has is not repeated, and the rest of its array is untouched', async () => {
    const { addDeny } = await load();
    const out = addDeny(SHAPES['a multi-line deny array'], WANT);
    assert.equal(JSON.parse(out.text).permissions.deny.filter((d) => d === 'Read(./.env*)').length, 1);
    assert.deepEqual(JSON.parse(out.text).permissions.deny.slice(0, 2), ['Read(./.env*)', 'Bash(rm -rf *)']);
  });

  test('refuses what it cannot promise to leave alone, saying why', async () => {
    const { addDeny } = await load();
    assert.throws(() => addDeny('{\r\n  "permissions": {}\r\n}\r\n', WANT), /CRLF/);
    assert.throws(() => addDeny('{\n  // ours\n  "permissions": { "deny": [] }\n}\n', WANT), /not plain JSON/);
    assert.throws(() => addDeny('{\n  "permissions": { "allow": ["x"] }\n}\n', WANT), /deny/);
    assert.throws(() => addDeny('{ "enabledPlugins": {} }\n', WANT), /one line/);
    assert.throws(() => addDeny('[]\n', WANT), /object/);
  });
});

describe('add <file> <kit file>', () => {
  test('rewrites the repository\'s file in place, and prints what it added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-merge-'));
    try {
      write(dir, { 'mine.json': SHAPES['a one-line deny array'], 'kit.json': JSON.stringify({ permissions: { deny: WANT } }) });
      const out = run(dir, 'node', [join(factory, 'bin/lib/settings.mjs'), 'add', join(dir, 'mine.json'), join(dir, 'kit.json')]);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /added 2 deny lines/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mine.json'), 'utf8')).permissions.deny, ['Bash(rm -rf *)', ...WANT]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
