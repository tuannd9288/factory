// #82 fix round 1: malformed gh output, a full page of issues and an unknown argument all exit 2, never 0 or 1.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, issue } from './sublayers-gh.mjs';

describe('bin/factory-sublayers input', () => {
  for (const [what, setup] of [
    ['null labels', { labels: 'null' }],
    ['an object for labels', { labels: '{"name":"x"}' }],
    ['null issues', { issues: 'null' }],
    ['an object for issues', { issues: '{"number":1}' }],
    ['an issue with no labels array', { issues: [{ number: 3, title: 'Bare' }] }],
    ['a label with no name', { labels: [{ description: 'x' }] }],
  ]) {
    test(`${what} exits 2`, async () => {
      const r = (await fake(setup))();
      assert.equal(r.status, 2, r.out + r.err);
      assert.match(r.err, /^factory-sublayers: gh (label|issue) list failed: its output is not a list of /m);
      assert.equal(r.out, '');
    });
  }

  test('exactly 500 open issues exits 2, saying the list may be cut', async () => {
    const issues = Array.from({ length: 500 }, (_, i) => issue(i + 1, 'sublayer-1a'));
    const r = (await fake({ issues }))();
    assert.equal(r.status, 2, r.out + r.err);
    assert.match(r.err, /^factory-sublayers: gh issue list returned 500 issues; the list may be cut at 500$/m);
    assert.equal(r.out, '');
  });

  test('499 open issues are still checked', async () => {
    const issues = Array.from({ length: 499 }, (_, i) => issue(i + 1, 'sublayer-1a'));
    const r = (await fake({ issues }))();
    assert.equal(r.status, 0, r.out + r.err);
  });

  for (const args of [['--rpo', 'o/x'], ['--repo', 'o/x', 'extra'], ['stray'], ['--repo']]) {
    test(`the arguments ${JSON.stringify(args)} exit 2 with the usage line`, async () => {
      const r = (await fake({}))(...args);
      assert.equal(r.status, 2, r.out + r.err);
      assert.match(r.err, /^usage: factory-sublayers \[--repo <owner\/name>\]$/m);
      assert.equal(r.out, '');
    });
  }
});
