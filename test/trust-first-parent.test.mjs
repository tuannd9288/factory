// "On the factory's main" means on the first-parent line of its main (#132, REVIEW-3 N1). A commit that main reaches only
// through a merge's second parent, such as an intermediate commit of a pull request that was rewritten before it merged,
// vouches for nothing; the merge commit itself does. The same rule holds where the factory's own clone is checked: onboard
// and kit-update. A key the walk cannot reach is red, never skipped.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commit, git } from './helpers.mjs';
import { world } from './world.mjs';
import { trustWorld } from './trust-world.mjs';

describe('the trust path vouches only for the first-parent line of the factory\'s main', () => {
  let t;
  before(() => {
    t = trustWorld();
  });
  after(() => t.cleanup());

  test('a commit main reaches only through a merge\'s second parent is red, though it is an ancestor', () => {
    t.candidate(t.update(t.MID, `${t.P}\n`));
    const out = t.objects();
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /first-parent/);
  });

  test('the merge commit of that pull request, with its final block, passes', () => {
    t.candidate(t.update(t.S2, `${t.F2}\n`));
    const out = t.objects();
    assert.equal(out.code, 0, out.out);
  });

  test('a key the walk cannot reach is red', () => {
    t.candidate(t.update(t.S2, `${'e'.repeat(40)}\n`));
    const out = t.objects();
    assert.equal(out.code, 1, out.out);
  });
});

describe('bin/kit-update takes the factory commit only from the first-parent line of origin/main', () => {
  test('refuses a commit reached through a merge\'s second parent, and takes the merge commit', () => {
    const w = world();
    try {
      const { fac } = w;
      git(fac, 'switch', '-q', '-c', 'side');
      const side = commit(fac, { 'kit/.gate/side.txt': 'a side file\n' }, 'side');
      git(fac, 'switch', '-q', 'main');
      commit(fac, {}, 'main moves');
      git(fac, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
      const merged = git(fac, 'rev-parse', 'HEAD');
      git(fac, 'update-ref', 'refs/remotes/origin/main', merged);
      git(fac, 'switch', '-q', '--detach', side);
      let out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /not on its origin\/main/);
      git(fac, 'switch', '-q', '--detach', merged);
      out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
    } finally {
      w.cleanup();
    }
  });
});
