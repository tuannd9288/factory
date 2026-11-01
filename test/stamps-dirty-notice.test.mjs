// A pass on a work tree that is not clean still passes, but says why it left no stamp (#85).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commit, repoWithKit, script, write } from './helpers.mjs';

describe('the notice of a stamp not written', () => {
  let r;
  before(() => {
    r = repoWithKit();
    commit(r.repo, { 'README.md': '# app, changed\n' }, 'Docs only');
  });
  after(() => r.cleanup());

  test('red-check names what makes the tree unclean, with the lines, and a tracked change as well', () => {
    write(r.repo, { 'README.md': '# app, edited again\n', 'junk1.txt': 'x\n' });
    const out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /^red-check: no stamp written, the work tree is not clean:$/m);
    assert.match(out.out, /^ {2} M README\.md$/m);
    assert.match(out.out, /^ {2}\?\? junk1\.txt$/m);
  });
});
