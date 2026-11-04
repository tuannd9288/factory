// The kit's review-categories lines (#380) are review attributes only: the gate's attributes-driver rule, which blocks a
// .gitattributes line that names a filter or a diff or merge driver, does not fire on them.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, repoWithKit, script, write } from './helpers.mjs';

describe('the attributes-driver rule and the kit\'s review categories', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());

  test('passes the kit\'s lines as an added .gitattributes, and still blocks a filter driver', () => {
    write(r.repo, { 'sub/.gitattributes': readFileSync(join(factory, 'kit/.gate/review-categories'), 'utf8') });
    let out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    write(r.repo, { 'sub/.gitattributes': '*.js filter=mine\n' });
    out = script(r.repo, 'rules', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /attributes-driver/);
  });
});
