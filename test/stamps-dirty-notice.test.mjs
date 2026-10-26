// A pass on a work tree that is not clean still passes, but says why it left no stamp (#85).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commit, repoWithKit, script, write } from './helpers.mjs';

const junk = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`junk${i + 1}.txt`, 'x\n']));

describe('the notice of a stamp not written', () => {
  let r;
  before(() => {
    r = repoWithKit();
    commit(r.repo, { 'README.md': '# app, changed\n' }, 'Docs only');
  });
  after(() => r.cleanup());

  test('verify names what makes the tree unclean, at most five lines and then a count, before its summary', () => {
    write(r.repo, junk(7));
    const out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^verify: no stamp written, the work tree is not clean:$/m);
    assert.equal(out.out.split('\n').filter((l) => /^ {2}\?\? junk\d\.txt$/.test(l)).length, 5, out.out);
    assert.match(out.out, /^ {2}… and 2 more$/m);
    assert.match(out.out.trim().split('\n').at(-1), /^verify: \d+ passed in \d+s$/);
  });

  test('verify says nothing of it on a clean tree', () => {
    for (const name of Object.keys(junk(7))) write(r.repo, { [name]: null });
    const out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 0, out.out);
    assert.doesNotMatch(out.out, /no stamp written/);
  });

  test('red-check says the same, with the lines, and names a tracked change as well', () => {
    write(r.repo, { 'README.md': '# app, edited again\n', 'junk1.txt': 'x\n' });
    const out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^red-check: no stamp written, the work tree is not clean:$/m);
    assert.match(out.out, /^ {2} M README\.md$/m);
    assert.match(out.out, /^ {2}\?\? junk1\.txt$/m);
  });
});
