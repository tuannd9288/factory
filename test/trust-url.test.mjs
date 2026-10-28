// GATE_FACTORY_URL (#132, REVIEW-3 N3) is for tests: it names a local folder, as an absolute path. A URL, a file:// URL or a
// relative path is a problem, not a fallback to the public factory and not a fetch from wherever it points. Unset or empty
// means the public factory (not fetched here: no test uses the network).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { trustWorld } from './trust-world.mjs';

describe('GATE_FACTORY_URL', () => {
  let t;
  before(() => {
    t = trustWorld();
  });
  after(() => t.cleanup());

  test('an absolute path to a local folder still works', () => {
    t.candidate(t.update(t.S2, `${t.F2}\n`));
    assert.equal(t.objects().code, 0);
  });

  test('a URL, a file:// URL and a relative path are red, and the message names the variable', () => {
    t.candidate(t.update(t.S2, `${t.F2}\n`));
    const values = ['https://github.com/someone/fork.git', `file://${t.factory}`, join('..', 'fac.git'), 'fac.git'];
    for (const value of values) {
      const out = t.objects(t.baseSha, { GATE_FACTORY_URL: value });
      assert.equal(out.code, 1, `${value}: ${out.out}`);
      assert.match(out.out, /GATE_FACTORY_URL/, value);
    }
  });

  test('an absolute path that is not a folder is red too', () => {
    t.candidate(t.update(t.S2, `${t.F2}\n`));
    const out = t.objects(t.baseSha, { GATE_FACTORY_URL: join(t.r.dir, 'no-such-folder.git') });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /GATE_FACTORY_URL/);
  });
});
