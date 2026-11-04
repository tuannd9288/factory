// scripts/pr-body (#386): rewrites a pull request's body through one gh call, against a fake gh.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from '../../../test/helpers.mjs';

const FAKE_GH = String.raw`#!/usr/bin/env node
require('fs').appendFileSync(process.env.SH + '/gh-calls', process.argv.slice(2).join(' ') + '\n');
`;

function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pr-body-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  writeFileSync(join(dir, 'body.md'), 'a body\n');
  const script = join(factory, 'packs/pstack/scripts/pr-body');
  return {
    dir,
    call: (...args) => run(dir, script, args, { SH: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }),
    calls: () => {
      try {
        return readFileSync(join(dir, 'gh-calls'), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

describe('scripts/pr-body', () => {
  test('runs exactly gh pr edit <n> --body-file <file>', () => {
    const w = world();
    const file = join(w.dir, 'body.md');
    const out = w.call('12', file);
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(w.calls(), [`pr edit 12 --body-file ${file}`]);
  });

  test('refuses a number that is not digits, a missing file, a folder and extra arguments, and runs no gh', () => {
    const w = world();
    const file = join(w.dir, 'body.md');
    for (const args of [['x', file], ['-1', file], ['12 --add-label x', file], ['12', join(w.dir, 'none.md')], ['12', w.dir], ['12', file, '--add-label'], ['12'], []]) {
      const out = w.call(...args);
      assert.equal(out.code, 1, JSON.stringify(args));
      assert.match(out.out, /usage: scripts\/pr-body/);
    }
    assert.deepEqual(w.calls(), []);
  });
});
