// The pass record (#85): a full scripts/verify and scripts/red-check leave a stamp under the git dir, named for the
// commits they judged, that scripts/ship reads. Never in the work tree; per worktree.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, script, write } from './helpers.mjs';

const MUL = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n';
const RED_AT_BASE =
  "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\n\ntest('multiplies', () => {\n  assert.equal(m.mul(2, 3), 6);\n});\n";

describe('the pass record', () => {
  let r;
  let stamps;
  before(() => {
    r = repoWithKit();
    stamps = () => {
      const dir = join(git(r.repo, 'rev-parse', '--absolute-git-dir'), 'factory');
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    };
  });
  after(() => r.cleanup());

  test('a full verify that passes on a clean head writes verify-<head>, and nowhere in the work tree', () => {
    const head = git(r.repo, 'rev-parse', 'HEAD');
    assert.deepEqual(stamps(), []);
    const out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(stamps(), [`verify-${head}`]);
    assert.equal(git(r.repo, 'status', '--porcelain'), '');
  });

  test('--fast, --only and --tests write none', () => {
    commit(r.repo, { 'README.md': '# app, again\n' }, 'Touch the readme');
    for (const args of [['--fast'], ['--only', 'policy'], ['--tests', 'test/math.test.js']]) {
      const out = script(r.repo, 'verify', args, { GATE_BASE: 'origin/main' });
      assert.equal(out.code, 0, `${args}: ${out.out}`);
    }
    assert.deepEqual(stamps(), [`verify-${git(r.repo, 'rev-parse', 'HEAD~1')}`]);
  });

  test('a verify that fails, or runs over an uncommitted change, writes none', () => {
    write(r.repo, { 'README.md': '# not committed\n' });
    let out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 0, out.out);
    assert.equal(stamps().length, 1);
    git(r.repo, 'checkout', '-q', '--', 'README.md');
    commit(r.repo, { 'AGENTS.md': 'x\n'.repeat(160) }, 'Break the instructions');
    out = script(r.repo, 'verify', [], { GATE_BASE: 'origin/main' });
    assert.equal(out.code, 1, out.out);
    assert.equal(stamps().length, 1);
    git(r.repo, 'reset', '-q', '--hard', 'HEAD~1');
  });

  test('red-check that passes writes red-check-<head>-<base>, with no source change and with a red test', () => {
    const base = git(r.repo, 'rev-parse', 'origin/main');
    const none = commit(r.repo, { 'README.md': '# app, once more\n' }, 'Docs only');
    let out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.ok(stamps().includes(`red-check-${none}-${base}`), stamps().join(' '));
    const head = commit(r.repo, { 'src/math.js': MUL, 'test/mul.test.js': RED_AT_BASE }, 'Add mul');
    out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 0, out.out);
    assert.ok(stamps().includes(`red-check-${head}-${base}`), stamps().join(' '));
  });

  test('red-check that fails writes none', () => {
    git(r.repo, 'reset', '-q', '--hard', 'origin/main');
    const head = commit(r.repo, { 'src/math.js': `${MUL}\nexport const one = 1;\n` }, 'A source change with no test');
    const out = script(r.repo, 'red-check', ['--base', 'origin/main']);
    assert.equal(out.code, 1, out.out);
    assert.ok(!stamps().some((s) => s.startsWith(`red-check-${head}`)), stamps().join(' '));
  });
});
