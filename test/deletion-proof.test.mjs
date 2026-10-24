// red-check accepts a pure deletion on machine proof (#17): no added source line, no tracked file at the head that
// still names what went, and knip (6.42.1, run at the base commit) listed it as unused. knip is a fake `npx` on PATH:
// these tests never reach the network and never run npm or the real knip.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, factory, git, repoWithKit, script } from './helpers.mjs';

const LIB = 'export function used() {\n  return 1;\n}\n\nexport function unusedFn() {\n  return 2;\n}\n\nexport const localValue = 3;\nexport const a = 1;\n';
const LIB_WITHOUT_UNUSED = 'export function used() {\n  return 1;\n}\n\nexport const localValue = 3;\nexport const a = 1;\n';
const EXTRA = {
  'knip.json': '{}\n',
  'src/old.js': 'export const old = 1;\n',
  'src/gone.js': 'export const gone = 1;\n',
  'src/lib.js': LIB,
  'src/app.js': "import { used } from './lib.js';\nexport const run = () => used();\n",
  'docs/guide.md': 'The helper lives in src/gone.js.\n',
};
const PASSED = /red-check: passed as a pure deletion: knip listed every removed file and export at the base, and nothing names them/;
const HINT = /Add a test that fails without the change, or give the PR body a line 'No-red: /;

/** The JSON of `knip --reporter json` (https://knip.dev/features/reporters#json): one entry per file with issues. */
const entry = (file, found = {}) => ({ file, files: [], exports: [], types: [], dependencies: [], ...found });
const report = (...entries) => JSON.stringify({ issues: entries });
const names = (...list) => list.map((name) => ({ name }));
const listsFile = (file) => entry(file, { files: names(file) });
const listsExports = (file, ...list) => entry(file, { exports: list.map((name, i) => ({ name, line: 1 + i, col: 14, pos: 20 * i })) });

describe('red-check: a pure deletion', () => {
  let r;
  let bare;
  let bin;
  let log;
  before(() => {
    r = repoWithKit(EXTRA);
    bare = repoWithKit({ 'src/old.js': EXTRA['src/old.js'] });
    bin = join(r.dir, 'fake-bin');
    log = join(r.dir, 'npx.log');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'npx'),
      ['#!/bin/sh', 'echo "pwd=$(pwd -P) head=$(git rev-parse HEAD) args=$*" >>"$FAKE_NPX_LOG"', 'cat "$FAKE_KNIP_REPORT"', 'exit 1', ''].join('\n'),
    );
    chmodSync(join(bin, 'npx'), 0o755);
  });
  after(() => {
    r.cleanup();
    bare.cleanup();
  });

  /** Commits `files` on a branch from origin/main in `repo` and runs red-check there, with the fake npx printing `knip`. */
  const check = (name, files, knip, { body, repo = r } = {}) => {
    rmSync(log, { force: true });
    git(repo.repo, 'switch', '-q', '-C', name, 'origin/main');
    commit(repo.repo, files, name);
    const args = ['--base', 'origin/main'];
    if (body !== undefined) {
      writeFileSync(join(repo.dir, 'body.txt'), body);
      args.push('--body', join(repo.dir, 'body.txt'));
    }
    writeFileSync(join(r.dir, 'knip.json'), knip ?? report());
    return script(repo.repo, 'red-check', args, { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log, FAKE_KNIP_REPORT: join(r.dir, 'knip.json') });
  };
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');

  test('passes a deleted file knip listed, names the proof, and runs the pinned knip in the base worktree', () => {
    const out = check('del-file', { 'src/old.js': null }, report(listsFile('src/old.js')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
    const base = git(r.repo, 'rev-parse', 'origin/main');
    assert.match(ran(), new RegExp(`^pwd=\\S+ head=${base} args=--yes knip@6\\.42\\.1 `, 'm'));
    assert.notEqual(ran().match(/^pwd=(\S+)/)[1], realpathSync(r.repo));
  });
  test('passes the deletion of an unused export that knip listed', () => {
    const out = check('del-export', { 'src/lib.js': LIB_WITHOUT_UNUSED }, report(listsExports('src/lib.js', 'unusedFn')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('fails a deletion of a file knip did not list at the base: check 3 names the path, then the hint', () => {
    const out = check('del-unlisted', { 'src/old.js': null }, report(listsFile('src/other.js')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /source changed with no new or changed test:\n {2}src\/old\.js/);
    assert.match(out.out, /check 3: knip did not list src\/old\.js as unused at the base/);
    assert.match(out.out, HINT);
    assert.ok(out.out.indexOf('check 3') < out.out.search(HINT), 'the hint comes after the reason');
  });
  test('fails a deleted export knip listed no export for: check 3 names the export', () => {
    const out = check('del-export-unlisted', { 'src/lib.js': LIB_WITHOUT_UNUSED }, report(listsExports('src/lib.js', 'localValue')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 3: knip did not list unusedFn of src\/lib\.js as unused at the base/);
  });
  test('fails knip output that is not the documented JSON, without passing', () => {
    const out = check('del-garbage', { 'src/old.js': null }, 'not json\n');
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 3: knip's JSON report could not be read/);
  });
  test('fails a deletion that also adds a line: check 1 names the line', () => {
    const out = check('del-adds', { 'src/lib.js': `${LIB_WITHOUT_UNUSED}// the helper moved\n` }, report(listsExports('src/lib.js', 'unusedFn')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: src\/lib\.js adds a source line: \/\/ the helper moved/);
    assert.match(out.out, HINT);
  });
  test('fails a new source file: every line of it is an added line', () => {
    const out = check('add-file', { 'src/new.js': 'export const n = 1;\n', 'src/old.js': null }, report(listsFile('src/old.js')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: src\/new\.js adds a source line/);
  });
  test('a doc that names a removed path blocks the deletion until the doc changes too', () => {
    let out = check('del-doc', { 'src/gone.js': null }, report(listsFile('src/gone.js')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 2: src\/gone\.js is still named in docs\/guide\.md/);
    out = check('del-doc-too', { 'src/gone.js': null, 'docs/guide.md': 'The helper is gone.\n' }, report(listsFile('src/gone.js')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('a tracked file that holds only the removed file\'s name with its extension blocks the deletion', () => {
    const out = check('del-basename', { 'src/old.js': null, 'docs/note.md': 'Run old.js by hand.\n' }, report(listsFile('src/old.js')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 2: src\/old\.js is still named in docs\/note\.md/);
  });
  test('a removed export that another tracked file still names as a whole word blocks the deletion', () => {
    const files = { 'src/lib.js': LIB_WITHOUT_UNUSED, 'docs/note.md': 'Call unusedFn() for two.\n' };
    let out = check('del-name', files, report(listsExports('src/lib.js', 'unusedFn')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 2: unusedFn, exported by src\/lib\.js, is still named in docs\/note\.md/);
    // A longer identifier is not the name.
    out = check('del-name-longer', { ...files, 'docs/note.md': 'Call unusedFnTwo() for two.\n' }, report(listsExports('src/lib.js', 'unusedFn')));
    assert.equal(out.code, 0, out.out);
  });
  test('removing only the export keyword adds no line: it passes when knip listed the export', () => {
    const out = check('del-keyword', { 'src/lib.js': LIB.replace('export const localValue = 3;', 'const localValue = 3;') }, report(listsExports('src/lib.js', 'localValue')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('export const a = 1 becoming const a = 2 adds a line', () => {
    const out = check('del-keyword-edit', { 'src/lib.js': LIB.replace('export const a = 1;', 'const a = 2;') }, report(listsExports('src/lib.js', 'a')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: src\/lib\.js adds a source line: const a = 2;/);
  });
  test('a change that removes no file and no export proves nothing', () => {
    const out = check('del-body', { 'src/lib.js': LIB.replace('  return 2;\n', '') }, report());
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 3: the change removes no file and no export/);
  });
  test('in a repository with no knip config it says so, then behaves as today', () => {
    const out = check('del-bare', { 'src/old.js': null }, report(listsFile('src/old.js')), { repo: bare });
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /source changed with no new or changed test:\n {2}src\/old\.js/);
    assert.match(out.out, /knip has no config in this repository/);
    assert.match(out.out, HINT);
    assert.equal(ran(), '', 'knip does not run without a config');
  });
  test('a No-red line still passes, and knip does not run', () => {
    const out = check('del-no-red', { 'src/old.js': null }, report(), { body: 'No-red: nothing calls it and nothing can fail\n' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /passed by the PR body's No-red: /);
    assert.equal(ran(), '');
  });
  test('a change with no source change does not run knip', () => {
    const out = check('docs-only', { 'docs/guide.md': 'The helper lives in src/gone.js, still.\n' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /no source change/);
    assert.equal(ran(), '');
  });
});

describe('prove-check: the fixtures of the deletion proof', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const fixtures = {
    'red-check-adds-line': /check 1/,
    'red-check-names-removed': /check 2/,
    'red-check-knip-silent': /check 3/,
  };

  for (const [name, says] of Object.entries(fixtures)) {
    test(`${name} fails red-check with its own reason`, () => {
      const out = script(r.repo, 'prove-check', [name]);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /prove-check: 1 checks fail on their fixtures/);
      const header = readFileSync(join(factory, `kit/.gate/proofs/${name}.sh`), 'utf8').split('\n').find((l) => l.startsWith('# Says: '));
      assert.match(header, new RegExp(`^# Says: .*${says.source}`));
    });
  }
  test('prove-check --all runs them', () => {
    const text = readFileSync(join(factory, 'kit/scripts/prove-check'), 'utf8');
    for (const name of Object.keys(fixtures)) assert.ok(text.includes(name), `${name} is not among the checks --all proves`);
  });
});
