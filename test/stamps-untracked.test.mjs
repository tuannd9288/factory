// A pass that leans on a file git does not hold (a forgotten `git add`) is no pass of the head: no stamp (#85).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, script, write } from './helpers.mjs';

describe('the pass record over an untracked file', () => {
  let r;
  let tested;
  const stamps = () => {
    const dir = join(git(r.repo, 'rev-parse', '--absolute-git-dir'), 'factory');
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };
  before(() => {
    r = repoWithKit();
    // The commit holds a test that imports a module only the work tree has.
    commit(r.repo, { 'test/extra.test.js': "import { test } from 'node:test';\nimport { extra } from '../src/extra.js';\ntest('extra', () => { if (extra !== 1) throw new Error('no'); });\n" }, 'A test of a file not added');
    tested = git(r.repo, 'rev-parse', 'HEAD');
    write(r.repo, { 'src/extra.js': 'export const extra = 1;\n' });
  });
  after(() => r.cleanup());

  test('verify passes there and writes no stamp; once the file is added and committed, it does', () => {
    assert.match(git(r.repo, 'status', '--porcelain'), /^\?\? src\/extra\.js$/m);
    const out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(stamps(), []);
    const head = commit(r.repo, {}, 'Add the file');
    assert.equal(script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' }).code, 0);
    assert.deepEqual(stamps(), [`verify-${head}`]);
  });

  test('red-check passes there and writes no stamp; once the file is gone, it does', () => {
    git(r.repo, 'reset', '-q', '--hard', tested);
    write(r.repo, { 'src/extra.js': 'export const extra = 1;\n' });
    let out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.ok(!stamps().some((s) => s.startsWith('red-check-')), stamps().join(' '));
    write(r.repo, { 'src/extra.js': null });
    const head = git(r.repo, 'rev-parse', 'HEAD');
    out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.ok(stamps().includes(`red-check-${head}-${git(r.repo, 'rev-parse', 'origin/main')}`), stamps().join(' '));
  });
});
