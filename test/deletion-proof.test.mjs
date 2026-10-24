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

// Every removed line of a file that still exists is accounted for: a keyword-only `export ` removal, or part of a
// removed hunk of whole top-level declarations of exports knip listed (#17, rule A). Whole removal also searches the
// defining file for the name (rule B).
describe('red-check: every removed source line is part of an unused export', () => {
  const HANDLER = [
    'export function handler(req) {',
    '  if (!req.user) return 401;',
    '  if (!authorized(req)) return 403;',
    '  return 200;',
    '}',
    '',
  ].join('\n');
  const DOC_A = '/**\n * Not used anywhere.\n */\nexport function unusedA(x) {\n  return x + 1;\n}\n\n';
  const B = 'export function unusedB() {\n  return unusedA(2);\n}\n';
  const H = `${HANDLER}\n${DOC_A}${B}`;
  const S = 'export function unusedC() {\n  return 1;\n}\ndoThing({\n  a: 1,\n});\n';
  const CJS = 'export const unusedD = 1;\nconst x = 1;\nmodule.exports = {\n  x,\n};\n';
  const M = 'const a = 1;\nconst b = 2;\nexport {\n  a,\n  b,\n};\nexport const unusedE = 1;\n';
  let r;
  let bin;
  let log;
  before(() => {
    r = repoWithKit({ 'knip.json': '{}\n', 'src/h.js': H, 'src/s.js': S, 'src/cjs.js': CJS, 'src/m.js': M });
    bin = join(r.dir, 'fake-bin');
    log = join(r.dir, 'npx.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), ['#!/bin/sh', 'echo "args=$*" >>"$FAKE_NPX_LOG"', 'cat "$FAKE_KNIP_REPORT"', 'exit 1', ''].join('\n'));
    chmodSync(join(bin, 'npx'), 0o755);
  });
  after(() => r.cleanup());

  const check = (name, files, knip) => {
    rmSync(log, { force: true });
    git(r.repo, 'switch', '-q', '-C', name, 'origin/main');
    commit(r.repo, files, name);
    writeFileSync(join(r.dir, 'knip.json'), knip);
    return script(r.repo, 'red-check', ['--base', 'origin/main'], { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log, FAKE_KNIP_REPORT: join(r.dir, 'knip.json') });
  };
  const NOT_PART = /check 1: src\/\w+\.js removes a line that is not part of an unused export: /;

  test('a guard deleted in a used function, with an unused export removed in the same file, fails', () => {
    const guarded = H.replace('  if (!authorized(req)) return 403;\n', '').replace(`${B}`, '');
    const out = check('rule-a-guard', { 'src/h.js': guarded }, report(listsExports('src/h.js', 'unusedB')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: src\/h\.js removes a line that is not part of an unused export: if \(!authorized\(req\)\) return 403;/);
  });
  test('whole unused exports are deleted together with their JSDoc and pass', () => {
    const out = check('rule-a-jsdoc', { 'src/h.js': HANDLER }, report(listsExports('src/h.js', 'unusedA', 'unusedB')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('a hunk that spans an unused export and the start of the next statement fails', () => {
    const out = check('rule-a-span', { 'src/s.js': '  a: 1,\n});\n' }, report(listsExports('src/s.js', 'unusedC')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, NOT_PART);
  });
  test('a removed module.exports line fails', () => {
    const out = check('rule-a-cjs', { 'src/cjs.js': 'const x = 1;\n' }, report(listsExports('src/cjs.js', 'unusedD')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: src\/cjs\.js removes a line that is not part of an unused export: module\.exports = \{/);
  });
  test('a removed multi-line export { a, b } fails closed', () => {
    const out = check('rule-a-multiline', { 'src/m.js': 'const a = 1;\nconst b = 2;\nexport const unusedE = 1;\n' }, report(listsExports('src/m.js', 'a', 'b', 'unusedE')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: src\/m\.js removes a line that is not part of an unused export: export \{/);
  });
  test('an export removed whole is still named in its own file: check 2 searches the defining file', () => {
    const out = check('rule-b-own-file', { 'src/h.js': H.replace(DOC_A, '') }, report(listsExports('src/h.js', 'unusedA')));
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 2: unusedA, exported by src\/h\.js, is still named in src\/h\.js/);
  });
});

// The independent review of #17 (REVIEW.md, B1-B5, N1, N2, N7): each case is a change that must not pass as a pure
// deletion, with the report the real knip would give. A base commit holds the old files, a head commit the new ones.
describe('red-check: a deletion that is not one', () => {
  let r;
  let bin;
  let n = 0;
  before(() => {
    r = repoWithKit({ 'knip.json': '{}\n' });
    bin = join(r.dir, 'fake-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\ncat "$FAKE_KNIP_REPORT"\nexit 1\n');
    chmodSync(join(bin, 'npx'), 0o755);
  });
  after(() => r.cleanup());

  const DEAD = { 'src/dead.js': 'export const dead = 1;\n' };
  const GONE = { 'src/dead.js': null };
  const run = (baseFiles, headFiles, knip) => {
    n++;
    git(r.repo, 'switch', '-q', '-C', `adv${n}`, 'origin/main');
    commit(r.repo, baseFiles, `base ${n}`);
    const base = git(r.repo, 'rev-parse', 'HEAD');
    commit(r.repo, headFiles, `head ${n}`);
    writeFileSync(join(r.dir, 'knip.json'), knip);
    return script(r.repo, 'red-check', ['--base', base], { PATH: `${bin}:${process.env.PATH}`, FAKE_KNIP_REPORT: join(r.dir, 'knip.json') });
  };
  const refuses = (out, reason) => {
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, reason);
    assert.doesNotMatch(out.out, /passed as a pure deletion/);
  };
  const CHECK1 = /check 1: /;
  const HANDLER = (guard) => `export function handler(req) {\n  if (!req.user) return 401;\n${guard}  return 200;\n}\n`;

  test('a guard that starts with a block comment, in a used function', () => {
    const base = HANDLER('  /* authz */ if (!authorized(req)) return 403;\n');
    refuses(run({ 'src/h.js': base, ...DEAD }, { 'src/h.js': HANDLER(''), ...GONE }, report(listsFile('src/dead.js'))), CHECK1);
  });
  test('the same guard as an opened block', () => {
    const base = HANDLER('  /* authz */ if (!authorized(req)) {\n    return 403;\n  }\n');
    refuses(run({ 'src/h.js': base, ...DEAD }, { 'src/h.js': HANDLER(''), ...GONE }, report(listsFile('src/dead.js'))), CHECK1);
  });
  test('the same guard on a line that ends a multi-line comment', () => {
    const base = HANDLER('  /*\n   * authz */ if (!authorized(req)) return 403;\n');
    refuses(run({ 'src/h.js': base, ...DEAD }, { 'src/h.js': HANDLER(''), ...GONE }, report(listsFile('src/dead.js'))), CHECK1);
  });
  test('a top-level call after a comment, removed with an unused export', () => {
    const base = "import { app, auth } from './server.js';\n/* auth */ app.use(auth);\nexport const unusedC = 1;\n";
    refuses(run({ 'src/app.js': base }, { 'src/app.js': "import { app, auth } from './server.js';\n" }, report(listsExports('src/app.js', 'unusedC'))), CHECK1);
  });
  test('a /** @jsx h */ pragma removed with an unused export', () => {
    const base = "/** @jsx h */\nimport { h } from 'preact';\nexport const View = () => <p>hi</p>;\nexport const unusedC = 1;\n";
    const head = "import { h } from 'preact';\nexport const View = () => <p>hi</p>;\n";
    refuses(run({ 'src/view.jsx': base }, { 'src/view.jsx': head }, report(listsExports('src/view.jsx', 'unusedC'))), CHECK1);
  });
  test('a comment-only hunk inside a used function', () => {
    const base = 'export function f() {\n  // istanbul ignore next\n  return 1;\n}\n';
    refuses(run({ 'src/h.js': base, ...DEAD }, { 'src/h.js': 'export function f() {\n  return 1;\n}\n', ...GONE }, report(listsFile('src/dead.js'))), CHECK1);
  });
  test('another statement after the export on its line', () => {
    const app = (line) => `import { app, auth } from './server.js';\n${line}`;
    refuses(run({ 'src/app.js': app('export const unusedC = 1; app.use(auth);\n') }, { 'src/app.js': app('') }, report(listsExports('src/app.js', 'unusedC'))), CHECK1);
  });
  test('another statement after the closing brace of the export', () => {
    const app = (text) => `import { app, auth } from './server.js';\n${text}`;
    const base = app('export function unusedC() {\n  return 1;\n} app.use(auth);\n');
    refuses(run({ 'src/app.js': base }, { 'src/app.js': app('') }, report(listsExports('src/app.js', 'unusedC'))), CHECK1);
  });
  test('export const unusedA = 1, usedB = 2 claims only the first name', () => {
    const use = { 'src/use.js': "import { usedB } from './lib.js';\nexport const v = usedB;\n" };
    const base = { 'src/lib.js': 'export const unusedA = 1, usedB = 2;\nexport const keep = 3;\n', ...use };
    refuses(run(base, { 'src/lib.js': 'export const keep = 3;\n' }, report(listsExports('src/lib.js', 'unusedA'))), CHECK1);
  });
  test('two declarations on one line', () => {
    const use = { 'src/use.js': "import { usedB } from './lib.js';\nexport const v = usedB;\n" };
    const base = { 'src/lib.js': 'export function unusedA() {} export const usedB = 2;\nexport const keep = 3;\n', ...use };
    refuses(run(base, { 'src/lib.js': 'export const keep = 3;\n' }, report(listsExports('src/lib.js', 'unusedA'))), CHECK1);
  });
  const BANNER = (inner) => `export function banner() {\n  return \`\n${inner}\n\`;\n}\n`;
  test('an export line inside a template literal, removed with the real export', () => {
    const base = `export const unusedC = 1;\n${BANNER('export const unusedC = 1;')}`;
    refuses(run({ 'src/gen.js': base }, { 'src/gen.js': 'export function banner() {\n  return `\n`;\n}\n' }, report(listsExports('src/gen.js', 'unusedC'))), CHECK1);
  });
  test('the keyword of an export line inside a template literal', () => {
    const base = `export const unusedC = 1;\n${BANNER('export const unusedC = 1;')}`;
    const head = `export const unusedC = 1;\n${BANNER('const unusedC = 1;')}`;
    refuses(run({ 'src/gen.js': base }, { 'src/gen.js': head }, report(listsExports('src/gen.js', 'unusedC'))), CHECK1);
  });
  test('two keyword-only removals in the other order', () => {
    const base = 'export const sideAq = f();\nexport const sideBq = g();\n';
    const head = 'const sideBq = g();\nconst sideAq = f();\n';
    refuses(run({ 'src/side.js': base }, { 'src/side.js': head }, report(listsExports('src/side.js', 'sideAq', 'sideBq'))), CHECK1);
  });
  test('a default export can never be proved: check 1 says so', () => {
    const base = 'export const keep = 1;\nexport default function () {\n  return 1;\n}\n';
    refuses(run({ 'src/d.js': base }, { 'src/d.js': 'export const keep = 1;\n' }, report(listsExports('src/d.js', 'default'))), /check 1: src\/d\.js removes a default export/);
  });
  test('export { a }; becoming { a }; is a block statement, not a keyword removal', () => {
    const base = 'const a = 1;\nexport { a };\n';
    refuses(run({ 'src/b.js': base }, { 'src/b.js': 'const a = 1;\n{ a };\n' }, report(listsExports('src/b.js', 'a'))), CHECK1);
  });
  test('a knip item with a namespace is not the export of that name', () => {
    const base = 'export const keep = 1;\nexport const shared = 2;\n';
    const item = entry('src/ns.js', { exports: [{ name: 'shared', namespace: 'NS', line: 2 }] });
    refuses(run({ 'src/ns.js': base }, { 'src/ns.js': 'export const keep = 1;\n' }, report(item)), /check 3: knip did not list shared of src\/ns\.js/);
  });

  // The cases the review found correct stay refused or accepted.
  test('a top-level call removed with an unused export is refused', () => {
    const base = "import { register } from './reg.js';\nregister('x');\nexport const unusedC = 1;\n";
    refuses(run({ 'src/r.js': base }, { 'src/r.js': "import { register } from './reg.js';\n" }, report(listsExports('src/r.js', 'unusedC'))), CHECK1);
  });
  test('an object entry removed inside an export is refused', () => {
    const base = 'export const cfg = {\n  a: 1,\n  strict: true,\n};\nexport const unusedC = 1;\n';
    refuses(run({ 'src/o.js': base }, { 'src/o.js': 'export const cfg = {\n  a: 1,\n};\n' }, report(listsExports('src/o.js', 'unusedC'))), CHECK1);
  });
  test('a decorated class is refused', () => {
    const base = "import { register } from './reg';\n@register\nexport class UnusedK {}\nexport const keep = 1;\n";
    refuses(run({ 'src/k.ts': base }, { 'src/k.ts': "import { register } from './reg';\nexport const keep = 1;\n" }, report(listsExports('src/k.ts', 'UnusedK'))), CHECK1);
  });
  test('a whole unused TS enum is accepted', () => {
    const out = run({ 'src/e.ts': 'export enum Unused {\n  A,\n  B,\n}\nexport const keep = 1;\n' }, { 'src/e.ts': 'export const keep = 1;\n' }, report(listsExports('src/e.ts', 'Unused')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('an unused export with a leading JSDoc and a trailing blank line is accepted', () => {
    const base = 'export const keep = 1;\n\n/** Unused. */\nexport function retiredFn() {\n  return 2;\n}\n\nexport const tail = 3;\n';
    const out = run({ 'src/j.js': base }, { 'src/j.js': 'export const keep = 1;\n\nexport const tail = 3;\n' }, report(listsExports('src/j.js', 'retiredFn')));
    assert.equal(out.code, 0, out.out);
  });
});

describe('the knip config decides how strict the gate is: changing it is tier 3', () => {
  let r;
  before(() => (r = repoWithKit()));
  after(() => r.cleanup());
  const tierOf = (files) => {
    git(r.repo, 'switch', '-q', '-C', 'knip', 'origin/main');
    commit(r.repo, files, 'knip');
    return script(r.repo, 'tier', ['--base', 'origin/main']);
  };

  for (const file of ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc', 'knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js']) {
    test(`${file}`, () => assert.match(tierOf({ [file]: '{ "entry": [] }\n' }).out, /^tier 3/));
  }
  test('the "knip" key of package.json', () => {
    const out = tierOf({ 'package.json': '{ "name": "app", "private": true, "type": "module", "knip": { "entry": [] } }\n' });
    assert.match(out.out, /^tier 3/);
  });
  test('.gate/protected and CODEOWNERS still agree', () => {
    const out = script(r.repo, 'verify', ['--only', 'policy']);
    assert.equal(out.code, 0, out.out);
  });
});

// Removing an unused export whose initialisation can run code at load is not a pure deletion (the Human, 2026-10-24).
describe('red-check: an export that may run code at load', () => {
  let r;
  let bin;
  let n = 0;
  before(() => {
    r = repoWithKit({ 'knip.json': '{}\n' });
    bin = join(r.dir, 'fake-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\ncat "$FAKE_KNIP_REPORT"\nexit 1\n');
    chmodSync(join(bin, 'npx'), 0o755);
  });
  after(() => r.cleanup());

  /** Removes the whole of `declaration` (an export named `name`) from a file that keeps another export. */
  const removing = (name, declaration) => {
    n++;
    git(r.repo, 'switch', '-q', '-C', `load${n}`, 'origin/main');
    commit(r.repo, { 'src/x.js': `export const keep = 1;\n${declaration}\n` }, `base ${n}`);
    const base = git(r.repo, 'rev-parse', 'HEAD');
    commit(r.repo, { 'src/x.js': 'export const keep = 1;\n' }, `head ${n}`);
    writeFileSync(join(r.dir, 'knip.json'), report(listsExports('src/x.js', name)));
    return script(r.repo, 'red-check', ['--base', base], { PATH: `${bin}:${process.env.PATH}`, FAKE_KNIP_REPORT: join(r.dir, 'knip.json') });
  };
  const runsCode = (name, declaration) => {
    const out = removing(name, declaration);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, new RegExp(`check 1: src/x\\.js removes ${name}, whose initialisation may run code at load; a pure deletion cannot prove it`));
    assert.match(out.out, HINT);
  };
  const harmless = (name, declaration) => {
    const out = removing(name, declaration);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  };

  test('a call in the initialiser', () => runsCode('unusedC', 'export const unusedC = app.use(auth);'));
  test('an immediately invoked function', () => runsCode('unusedC', 'export const unusedC = (() => f())();'));
  test('an object holding an arrow', () => runsCode('unusedH', 'export const unusedH = { a: () => f() };'));
  test('new, await, an assignment, a tagged template and JSX', () => {
    runsCode('unusedN', 'export const unusedN = new Registry();');
    runsCode('unusedW', 'export const unusedW = await load;');
    runsCode('unusedG', 'export let unusedG = (x = 1);');
    runsCode('unusedT', 'export const unusedT = tag`x`;');
    runsCode('unusedX', 'export const unusedX = <p />;');
  });
  test('a class with a static block', () => runsCode('UnusedK', 'export class UnusedK {\n  static {\n    registry.add(this);\n  }\n}'));
  test('a class that extends a call', () => runsCode('UnusedK', 'export class UnusedK extends mixin(B) {}'));
  test('a class with a computed member key', () => runsCode('UnusedK', 'export class UnusedK {\n  [Symbol.iterator]() {}\n}'));
  test('a class with a static field', () => runsCode('UnusedK', 'export class UnusedK {\n  static id = 1;\n}'));
  test('a decorated class', () => runsCode('UnusedK', 'export class UnusedK {\n  @track value = 1;\n}'));
  test('an enum member that calls', () => runsCode('Unused', 'export enum Unused {\n  A = f(),\n}'));
  test('a namespace', () => runsCode('Unused', 'export namespace Unused {\n  export const x = 1;\n}'));
  test('a re-export, which loads the other module', () => runsCode('other', "export { other } from './other.js';"));

  test('numbers, strings and member reads are harmless', () => {
    harmless('unusedK', 'export const unusedK = 42;');
    harmless('unusedS', "export const unusedS = 'x';");
    harmless('unusedM', 'export const unusedM = Foo.BAR;');
  });
  test('functions and arrows are harmless', () => {
    harmless('unusedA', 'export const unusedA = () => f();');
    harmless('unusedB', 'export const unusedB = async (x) => {\n  return f(x);\n};');
    harmless('unusedC', 'export const unusedC = x => f(x);');
    harmless('unusedF', 'export function unusedF() {\n  return f();\n}');
    harmless('unusedG', 'export async function unusedG() {\n  return f();\n}');
  });
  test('a class with only methods and instance fields is harmless', () => {
    harmless('UnusedK', 'export class UnusedK {\n  value = f();\n  method() {\n    return this.value;\n  }\n}');
  });
  test('an enum of constants is harmless', () => harmless('Unused', 'export enum Unused {\n  A,\n  B = 2,\n}'));
});
