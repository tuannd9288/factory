// Round 4 of the review of #17: the proof no longer reads regex literals, template literals or JSX. A file gets a machine
// proof only when it is .js, .mjs, .cjs, .ts, .mts or .cts, holds no backtick, holds no `/` in code (outside a comment or a
// quoted string) and continues no string onto the next line; and a JSON knip config may hold only plain data keys.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repoWithKit, script } from './helpers.mjs';

const PASSED = /red-check: passed as a pure deletion/;
const entry = (file, found = {}) => ({ file, files: [], exports: [], types: [], dependencies: [], ...found });
const report = (...entries) => JSON.stringify({ issues: entries });
const listsExports = (file, ...list) => entry(file, { exports: list.map((name, i) => ({ name, line: 1 + i, col: 14, pos: 20 * i })) });
const listsFile = (file) => entry(file, { files: [{ name: file }] });

const SLASH = (n) => new RegExp(`line ${n} holds a "/" outside a comment or string; the gate cannot tell a regex from a division`);
const TICK = (n) => new RegExp(`line ${n} holds a backtick`);

describe('red-check: a file the gate cannot read gets no machine proof, and the refusal names the first line', () => {
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

  const run = (baseFiles, headFiles, knip) => {
    n++;
    git(r.repo, 'switch', '-q', '-C', `nr${n}`, 'origin/main');
    commit(r.repo, baseFiles, `base ${n}`);
    const base = git(r.repo, 'rev-parse', 'HEAD');
    commit(r.repo, headFiles, `head ${n}`);
    writeFileSync(join(r.dir, 'knip.json'), knip);
    return script(r.repo, 'red-check', ['--base', base], { PATH: `${bin}:${process.env.PATH}`, FAKE_KNIP_REPORT: join(r.dir, 'knip.json') });
  };
  const refuses = (out, reason) => {
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /check 1: /);
    assert.match(out.out, reason);
    assert.doesNotMatch(out.out, /passed as a pure deletion/);
  };
  const SERVER = "import { app, auth } from './server.js';\n";
  const KEEP = `${SERVER}export const keep = 1;\n`;

  test('M1: a keyword used as a member name (s.new) before a division', () => {
    const base = `${SERVER}export function unusedRf(s, t) { return Math.round(s.new / t) / 2; }\napp.use(auth);\nexport function usedRg(s, t, f) { return s.new / f(t(1) / 2); }\nexport const keep = 1;\n`;
    const files = { 'src/m.js': base, 'src/u.js': "import { usedRg } from './m.js';\nexport const v = usedRg;\n" };
    refuses(run(files, { 'src/m.js': KEEP }, report(listsExports('src/m.js', 'unusedRf'))), SLASH(2));
  });
  test('M2: postfix ++ before a division', () => {
    const base = `${SERVER}export function unusedRf(i, w) { return Math.floor(i++ / w) / 2; }\napp.use(auth);\nexport function unusedRh(i, f, g) { return i++ / f(g(1) / 2); }\nexport const keep = 1;\n`;
    refuses(run({ 'src/m.js': base }, { 'src/m.js': KEEP }, report(listsExports('src/m.js', 'unusedRf', 'unusedRh'))), SLASH(2));
  });
  test('M3: a parameter named of before a division', () => {
    const base = `${SERVER}export function unusedRf(of, w) { return Math.floor(of / w) / 2; }\napp.use(auth);\nexport function unusedRh(of, f, g) { return of / f(g(1) / 2); }\nexport const keep = 1;\n`;
    refuses(run({ 'src/m.js': base }, { 'src/m.js': KEEP }, report(listsExports('src/m.js', 'unusedRf', 'unusedRh'))), SLASH(2));
  });
  test('T1: a template inside ${} in a template hides a brace', () => {
    const base = `${SERVER}export function unusedRf() { return \`\${\`{\`}\`; }\napp.use(auth);\nexport function usedRg() { return \`\${\`}\`}\`; }\nexport const keep = 1;\n`;
    const files = { 'src/t.js': base, 'src/u.js': "import { usedRg } from './t.js';\nexport const v = usedRg;\n" };
    refuses(run(files, { 'src/t.js': KEEP }, report(listsExports('src/t.js', 'unusedRf'))), TICK(2));
  });
  test('T2: a backtick in a quoted string in ${}, with a keyword-only edit inside the real template', () => {
    const gen = (inner) => `export const unusedTc = 1;\nexport const banner = () => \`\${'\`'}\n${inner}\n\`;\n`;
    refuses(run({ 'src/t.js': gen('export const unusedTc = 1;') }, { 'src/t.js': gen('const unusedTc = 1;') }, report(listsExports('src/t.js', 'unusedTc'))), TICK(2));
  });
  test('T3: the same template, with the real export and the template line removed whole', () => {
    const base = "export const unusedTc = 1;\nexport const banner = () => `${'`'}\nexport const unusedTc = 1;\n`;\n";
    refuses(run({ 'src/t.js': base }, { 'src/t.js': "export const banner = () => `${'`'}\n`;\n" }, report(listsExports('src/t.js', 'unusedTc'))), TICK(2));
  });
  test('J1: a .jsx file gets no machine proof, and the refusal says why', () => {
    const base = `${SERVER}export function UnusedJ() { return <b>1</b>; } app.use(auth); //}\nexport const keep = 1;\n`;
    refuses(run({ 'src/view.jsx': base }, { 'src/view.jsx': KEEP }, report(listsExports('src/view.jsx', 'UnusedJ'))), /src\/view\.jsx.*\.jsx/);
  });
  test('a .tsx file gets none either', () => {
    const base = 'export const keep = 1;\nexport function UnusedT() {\n  return null;\n}\n';
    refuses(run({ 'src/view.tsx': base }, { 'src/view.tsx': 'export const keep = 1;\n' }, report(listsExports('src/view.tsx', 'UnusedT'))), /src\/view\.tsx.*\.tsx/);
  });

  test('the refusal names the first line that disqualifies the file: a slash on line 5, a backtick on line 6', () => {
    const base = 'export const keep = 1;\nexport function unusedA() {\n  return 1;\n}\nexport const half = keep / 2;\nexport const tpl = `x`;\nexport function unusedB() {}\n';
    const out = run({ 'src/d.js': base }, { 'src/d.js': 'export const keep = 1;\n' }, report(listsExports('src/d.js', 'unusedA', 'unusedB')));
    refuses(out, /check 1: src\/d\.js: line 5 holds a "\/" outside a comment or string; the gate cannot tell a regex from a division/);
    assert.doesNotMatch(out.out, /line 6/);
  });
  test('a backtick on line 2, before a slash on line 3, is the line named', () => {
    const base = 'export const keep = 1;\nexport const tpl = `x`;\nexport const half = keep / 2;\n';
    refuses(run({ 'src/d.js': base }, { 'src/d.js': 'export const keep = 1;\n' }, report(listsExports('src/d.js', 'tpl', 'half'))), /check 1: src\/d\.js: line 2 holds a backtick/);
  });
  test('a backtick in a comment or a string disqualifies the file too', () => {
    const base = "export const keep = 1;\n// the `tick`\nexport function unusedC() {\n  return 'a`b';\n}\n";
    refuses(run({ 'src/d.js': base }, { 'src/d.js': 'export const keep = 1;\n' }, report(listsExports('src/d.js', 'unusedC'))), TICK(2));
  });
  test('a string that continues onto the next line with a trailing backslash disqualifies the file', () => {
    const base = "export const keep = 1;\nexport const unusedS = 'a \\\nexport const unusedZ = 1; //';\n";
    refuses(run({ 'src/d.js': base }, { 'src/d.js': 'export const keep = 1;\n' }, report(listsExports('src/d.js', 'unusedS'))), /line 2 continues a string onto the next line with a trailing "\\"/);
  });

  test('a slash inside a quoted string or a comment is fine: an import path, a URL, a block comment', () => {
    const base = "import { x } from './lib/x.js';\nexport const keep = x;\n/* a / b */ // and a / here\nexport function unusedU() {\n  return 'https://example.com/a' + \"b/c\";\n}\n";
    const out = run({ 'src/d.js': base }, { 'src/d.js': "import { x } from './lib/x.js';\nexport const keep = x;\n/* a / b */ // and a / here\n" }, report(listsExports('src/d.js', 'unusedU')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('a plain file with none of those passes', () => {
    const base = "import { app, auth } from './server.js';\nexport const keep = 1;\nexport function unusedP(a) {\n  return a ? 'x' : \"y\";\n}\n";
    const out = run({ 'src/d.js': base }, { 'src/d.js': "import { app, auth } from './server.js';\nexport const keep = 1;\n" }, report(listsExports('src/d.js', 'unusedP')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('a deleted file needs no reading: a deleted .jsx file with a slash and a backtick still passes', () => {
    const out = run({ 'src/gone.jsx': 'export const g = <b>{`${1 / 2}`}</b>;\n' }, { 'src/gone.jsx': null }, report(listsFile('src/gone.jsx')));
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
});

describe('red-check: a JSON knip config may hold only plain data keys', () => {
  const OLD = { 'src/old.js': 'export const old = 1;\n' };
  let dir;
  let bin;
  let log;
  before(() => {
    dir = repoWithKit();
    bin = join(dir.dir, 'fake-bin');
    log = join(dir.dir, 'npx.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho ran >>"$FAKE_NPX_LOG"\ncat "$FAKE_KNIP_REPORT"\nexit 1\n');
    chmodSync(join(bin, 'npx'), 0o755);
  });
  after(() => dir.cleanup());

  let n = 0;
  const attempt = (config, file = 'knip.json') => {
    n++;
    rmSync(log, { force: true });
    git(dir.repo, 'switch', '-q', '-C', `k${n}`, 'origin/main');
    commit(dir.repo, { ...OLD, [file]: typeof config === 'string' ? config : JSON.stringify(config) }, `base ${n}`);
    const base = git(dir.repo, 'rev-parse', 'HEAD');
    commit(dir.repo, { 'src/old.js': null }, `head ${n}`);
    writeFileSync(join(dir.dir, 'knip.json'), report(listsFile('src/old.js')));
    const out = script(dir.repo, 'red-check', ['--base', base], { PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_LOG: log, FAKE_KNIP_REPORT: join(dir.dir, 'knip.json') });
    return { ...out, ran: existsSync(log) };
  };
  const WHY = /a knip config key can load code the gate does not protect/;
  const refused = (out, key) => {
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, new RegExp(`"${key}"`));
    assert.match(out.out, WHY);
    assert.equal(out.ran, false);
  };

  test('K: a "preprocessor" names a file knip loads and runs, so the config is refused with the key and the reason', () => {
    refused(attempt({ preprocessor: './tools/knip-pre.js' }), 'preprocessor');
  });
  test('preprocessorOptions goes with it', () => refused(attempt({ preprocessorOptions: { a: 1 } }), 'preprocessorOptions'));
  test('a reporter key is refused', () => refused(attempt({ reporter: ['./r.js'] }), 'reporter'));
  test('compilers are refused', () => refused(attempt({ compilers: { mdx: true } }), 'compilers'));
  test('a plugin config that points at a JS file is refused', () => refused(attempt({ vitest: { config: ['./tools/vitest.config.js'] } }), 'vitest'));
  test('a key the gate does not recognise is refused, fail closed', () => refused(attempt({ somethingNew: true }), 'somethingNew'));
  test('a key inside a workspace is judged the same way', () => refused(attempt({ workspaces: { '.': { entry: ['a.js'], preprocessor: './p.js' } } }), 'preprocessor'));
  test('a .jsonc config with comments is read, and refused for the same key', () => {
    refused(attempt('{\n  // a comment\n  "entry": ["src/a.js"], /* more */\n  "preprocessor": "./p.js",\n}\n', 'knip.jsonc'), 'preprocessor');
  });
  test('a dot-form config is judged the same way', () => {
    refused(attempt({ preprocessor: './p.js' }, '.knip.json'), 'preprocessor');
  });
  test('a config of globs, lists of names and rules is plain data, and passes', () => {
    const out = attempt({
      $schema: 'https://unpkg.com/knip@6/schema.json',
      entry: ['src/index.js'],
      project: ['src/**/*.js'],
      ignore: ['**/fixtures/**'],
      ignoreDependencies: ['left-pad'],
      ignoreExportsUsedInFile: true,
      ignoreIssues: { 'src/generated/**': ['exports'] },
      rules: { files: 'error', exports: 'warn' },
      include: ['files', 'exports'],
      workspaces: { 'packages/a': { entry: ['index.js'], project: ['**/*.js'] } },
    });
    assert.equal(out.code, 0, out.out);
    assert.equal(out.ran, true);
  });
});
