// The deletion-proof module, step 1 (#71): with the module on, red-check passes a change whose only source change deletes
// whole files that knip 6.42.1 listed as unused at the base, and that no tracked file still names. Anything else takes a
// test or No-red:. knip is a fake `npx` on PATH: nothing here reaches the network, npm or the real knip.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, run, script } from '../../../test/helpers.mjs';
import { PREPARE, entry, fl, moduleRepo, report } from './lib.mjs';

const PASSED = /^red-check: passed as a pure deletion: knip listed every deleted file at the base, and nothing names them$/m;
const HINT = /Add a test that fails without the change, or give the PR body a line 'No-red: /;
const FILES = { 'src/old.js': 'export const old = 1;\n', 'src/gone.js': 'export const gone = 1;\n', 'src/view.jsx': 'export const View = () => null;\n', 'src/typed.tsx': 'export const T = () => null;\n' };
const refused = (out, re) => {
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /^red-check: source changed with no new or changed test:\n {2}/m);
  assert.match(out.out, re);
  assert.match(out.out, HINT);
  assert.ok(out.out.indexOf('not a pure deletion') < out.out.search(HINT), 'the reason comes before the hint');
};

describe('deletion-proof: whole files knip listed', () => {
  let r;
  before(() => (r = moduleRepo(FILES)));
  after(() => r.cleanup());
  const log = () => (existsSync(r.log) ? readFileSync(r.log, 'utf8') : '');

  test('passes a deleted file knip listed, names the proof, and runs the pinned knip in a prepared worktree at the base', () => {
    rmSync(r.log, { force: true });
    const out = r.attempt({ head: { 'src/old.js': null }, knip: report(fl('src/old.js')) });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
    assert.match(log(), new RegExp(`^pwd=\\S+ head=${out.base} prepared=yes args=--yes knip@6\\.42\\.1 --reporter json$`, 'm'));
    assert.equal(log().split('\n').filter(Boolean).length, 1);
    assert.notEqual(log().match(/^pwd=(\S+)/)[1], realpathSync(r.repo));
  });
  test('passes several files, .jsx and .tsx among them: the gate reads no code', () => {
    const out = r.attempt({ head: { 'src/old.js': null, 'src/view.jsx': null, 'src/typed.tsx': null }, knip: report(fl('src/old.js'), fl('src/view.jsx'), fl('src/typed.tsx')) });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, PASSED);
  });
  test('lets non-source files change with the deletion', () => {
    const out = r.attempt({ base: { 'docs/guide.md': 'The helper lives in src/gone.js.\n' }, head: { 'src/gone.js': null, 'docs/guide.md': 'The helper is gone.\n' }, knip: report(fl('src/gone.js')) });
    assert.equal(out.code, 0, out.out);
  });
  test('a No-red line still passes first, and the proof does not run', () => {
    rmSync(r.log, { force: true });
    const out = r.attempt({ head: { 'src/old.js': null }, body: 'No-red: removes a file nothing uses at all\n' });
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /passed by the PR body's No-red/);
    assert.equal(log(), '');
  });

  test('refuses a deleted file knip did not list: check 3 names the path, then the hint', () => {
    refused(r.attempt({ head: { 'src/old.js': null }, knip: report(fl('src/other.js')) }), /check 3: knip did not list src\/old\.js as unused at the base/);
  });
  test('refuses knip output that is not the documented JSON, a v5-shaped report, and an empty one', () => {
    refused(r.attempt({ head: { 'src/old.js': null }, knip: 'not json\n' }), /check 3: knip's JSON report could not be read/);
    refused(r.attempt({ head: { 'src/old.js': null }, knip: JSON.stringify({ files: ['src/old.js'], issues: [{ file: 'src/old.js', files: true }] }) }), /check 3: knip did not list src\/old\.js/);
    refused(r.attempt({ head: { 'src/old.js': null }, knip: '{"files":["src/old.js"],"issues":[]}' }), /check 3: knip did not list src\/old\.js/);
  });
  test('refuses when knip cannot run (exit 2) or the base cannot be prepared', () => {
    refused(r.attempt({ head: { 'src/old.js': null }, knip: 'boom\n', more: { FAKE_KNIP_EXIT: '2' } }), /check 3: knip could not run \(exit 2\)/);
    refused(
      r.attempt({ base: { '.gate/config.sh': `${readFileSync(join(r.repo, '.gate/config.sh'), 'utf8')}\ngate_prepare() { echo install failed; return 1; }\n` }, head: { 'src/old.js': null }, knip: report(fl('src/old.js')) }),
      /check 3: the base could not be prepared for knip: install failed/,
    );
  });
  test('refuses a file that is added, modified or changed in type: only whole-file deletions have a machine proof', () => {
    refused(r.attempt({ head: { 'src/old.js': 'export const old = 2;\n' }, knip: report(fl('src/old.js')) }), /check 1: src\/old\.js is modified, not deleted whole/);
    refused(r.attempt({ head: { 'src/new.js': 'export const n = 1;\n', 'src/old.js': null }, knip: report(fl('src/old.js')) }), /check 1: src\/new\.js is added, not deleted whole/);
    refused(r.attempt({ head: { 'src/old.js': null, 'src/gone.js': 'export const gone = 2;\n' }, knip: report(fl('src/old.js'), fl('src/gone.js')) }), /check 1: src\/gone\.js is modified/);
    refused(r.attempt({ head: { 'src/old.js': null }, symlink: ['gone.js', 'src/gone.js'], knip: report(fl('src/old.js')) }), /check 1: src\/gone\.js changes type/);
  });
  test('names at most five reasons and counts the rest', () => {
    const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`src/m${i}.js`, `export const m${i} = 1;\n`]));
    const out = r.attempt({ base: many, head: Object.fromEntries(Object.keys(many).map((p) => [p, 'export {};\n'])), knip: report() });
    refused(out, /check 1: src\/m0\.js is modified/);
    assert.match(out.out, /not a pure deletion: \.\.\. and 2 more/);
  });

  test('a tracked file that names the path or the basename blocks the deletion until it changes too', () => {
    refused(r.attempt({ base: { 'docs/guide.md': 'The helper lives in src/gone.js.\n' }, head: { 'src/gone.js': null }, knip: report(fl('src/gone.js')) }), /check 2: src\/gone\.js is still named in docs\/guide\.md/);
    refused(r.attempt({ base: { 'docs/note.md': 'Run gone.js by hand.\n' }, head: { 'src/gone.js': null }, knip: report(fl('src/gone.js')) }), /check 2: src\/gone\.js is still named in docs\/note\.md \(as "gone\.js"\)/);
  });
  test('a deleted file imported without its extension is named by neither path nor basename: protection of the config is what stands (round 1, B5)', () => {
    const out = r.attempt({
      base: { 'src/use.js': "import { old as o } from './old';\nexport const v = o;\n", '.gate/protected': '/.gate/\n' },
      head: { 'src/old.js': null },
      knip: report(fl('src/old.js')),
    });
    refused(out, /config: knip\.json is not in \.gate\/protected/);
  });
});

describe('deletion-proof: the knip config', () => {
  let r;
  before(() => (r = moduleRepo(FILES)));
  after(() => r.cleanup());
  const listed = report(fl('src/old.js'));
  const withConfig = (files, head = { 'src/old.js': null }) => r.attempt({ base: files, head, knip: listed });

  test('with no config at the base the proof is refused and says why', () => {
    refused(withConfig({ 'knip.json': null }), /config: knip has no config in this repository \(none of knip\.json, knip\.jsonc, \.knip\.json, \.knip\.jsonc at the base\), so no deletion can be proved unused/);
  });
  test('a JS or TS config, or the "knip" key of package.json, is refused with the way out', () => {
    for (const name of ['knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js']) {
      refused(withConfig({ 'knip.json': null, [name]: 'export default {};\n' }), /config: a JS or TS knip config can import files the gate does not protect/);
    }
    refused(withConfig({ 'knip.json': null, 'package.json': '{ "name": "app", "private": true, "type": "module", "knip": { "entry": [] } }\n' }), /config: the knip config is in package\.json; move it to knip\.json for a machine proof/);
  });
  test('a "knip" key nested elsewhere in package.json is no config', () => {
    refused(withConfig({ 'knip.json': null, 'package.json': '{ "name": "app", "private": true, "type": "module", "config": { "knip": {} } }\n' }), /config: knip has no config/);
  });
  test('a package.json "knip" key beside a protected knip.json is refused: knip 6.42.1 merges the two (create-options.js:35)', () => {
    for (const key of [{ entry: [] }, { next: false }, { preprocessor: './tools/knip-pre.js' }]) {
      refused(withConfig({ 'package.json': JSON.stringify({ name: 'app', private: true, type: 'module', knip: key }) }), /config: the knip config is in package\.json; move it to knip\.json for a machine proof/);
    }
  });
  test('a knip.json that is a symlink is refused: the link is protected, what it points at is not', () => {
    const out = r.attempt({ base: { '{}': '{ "preprocessor": "./tools/pre.js" }\n' }, link: ['{}', 'knip.json'], head: { 'src/old.js': null }, knip: listed });
    refused(out, /config: knip\.json is not a regular file \(mode 120000\), so no deletion can be proved unused/);
  });
  test('refuses a key that can load code, and a key the gate does not know, at the root and in a workspace', () => {
    for (const [config, key] of [
      [{ preprocessor: './tools/knip-pre.js' }, 'preprocessor'],
      [{ compilers: { mdx: true } }, 'compilers'],
      [{ eslint: { config: 'eslint.config.js' } }, 'eslint'],
      [{ somethingNew: 1 }, 'somethingNew'],
      [{ workspaces: { '.': { vitest: { config: 'vitest.config.ts' } } } }, 'vitest'],
    ]) {
      refused(withConfig({ 'knip.json': JSON.stringify(config) }), new RegExp(`config: knip\\.json holds the key "${key}": a knip config key can load code the gate does not protect`));
    }
  });
  test('refuses a config that is not a JSON object or cannot be read, and an escaped key is caught after parsing', () => {
    refused(withConfig({ 'knip.json': '[]' }), /config: knip\.json is not a JSON object/);
    refused(withConfig({ 'knip.json': '{ "entry": ' }), /config: knip\.json could not be read as JSON, so no deletion can be proved unused/);
    refused(withConfig({ 'knip.json': '{ "pre\\u0070rocessor": "./x.js" }' }), /holds the key "preprocessor"/);
  });
  test('accepts a data-only config: comments, trailing commas, globs, rules and workspaces with the same keys', () => {
    const config = '// knip\n{\n  "$schema": "https://unpkg.com/knip@6/schema.json",\n  "entry": ["src/app.js"], /* where it starts */\n  "project": ["src/**"],\n  "ignoreDependencies": ["x"],\n  "rules": { "files": "error" },\n  "workspaces": { "packages/a": { "entry": ["index.js"], }, },\n}\n';
    for (const name of ['knip.json', 'knip.jsonc', '.knip.json', '.knip.jsonc']) {
      const out = withConfig({ 'knip.json': null, '.gate/protected': `${readFileSync(join(r.repo, '.gate/protected'), 'utf8')}${name}\n`, [name]: config });
      assert.equal(out.code, 0, `${name}: ${out.out}`);
    }
  });
});

describe('deletion-proof: the config must be protected at the base', () => {
  let r;
  before(() => (r = moduleRepo(FILES)));
  after(() => r.cleanup());
  const protectedWith = (...lines) => `/.gate/\n${lines.map((l) => `${l}\n`).join('')}`;
  const listed = report(fl('src/old.js'));
  const go = (protectedText, extra = {}, head = { 'src/old.js': null }) => r.attempt({ base: { '.gate/protected': protectedText, ...extra }, head, knip: listed });

  test('refuses while the base\'s .gate/protected does not cover the config, and says what to add', () => {
    refused(go(protectedWith()), /config: knip\.json is not in \.gate\/protected/);
    refused(go(protectedWith('knip.js')), /config: knip\.json is not in \.gate\/protected/);
  });
  test('accepts a pattern that covers it: the name, anchored, or a glob', () => {
    for (const line of ['knip.json', '/knip.json', 'knip*.json', '*.json', '**/knip.json']) {
      const out = go(protectedWith(line));
      assert.equal(out.code, 0, `${line}: ${out.out}`);
    }
  });
  test('reads the base\'s list, not the head\'s: a pull request that protects the config itself is still refused', () => {
    const out = r.attempt({ base: { '.gate/protected': protectedWith() }, head: { '.gate/protected': protectedWith('knip.json'), 'src/old.js': null }, knip: listed });
    refused(out, /config: knip\.json is not in \.gate\/protected/);
  });
  test('a repository with no .gate/protected at the base is refused the same way', () => {
    refused(r.attempt({ base: { '.gate/protected': null }, head: { 'src/old.js': null }, knip: listed }), /config: knip\.json is not in \.gate\/protected/);
  });
  test('the config files the gate can trust are those it names, and a changed knip.json is tier 3 where it is protected', () => {
    const out = r.attempt({ head: { 'knip.json': '{ "entry": [] }\n', 'packages/a/knip.json': '{}\n' }, knip: listed });
    const tier = run(r.repo, join(r.repo, 'scripts/tier'), ['--base', out.base]);
    assert.match(tier.out, /^tier 3/m);
    assert.match(tier.out, /knip\.json/);
  });
});

describe('deletion-proof: errors are errors', () => {
  let r;
  before(() => (r = moduleRepo(FILES)));
  after(() => r.cleanup());
  const prove = (base, sources = 'src/old.js\n') => {
    const work = join(r.dir, 'work');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    writeFileSync(join(work, 'sources'), sources);
    return run(r.repo, 'node', ['scripts/lib/deletion.mjs', 'prove', '--base', base, '--sources', join(work, 'sources'), '--work', work], r.env());
  };

  test('a base git cannot read is exit 2 with its own words, never "knip has no config" (#60)', () => {
    const out = prove('0123456789abcdef0123456789abcdef01234567');
    assert.equal(out.code, 2, out.out);
    assert.match(out.out, /red-check: could not read the base 0123456789abcdef/);
    assert.doesNotMatch(out.out, /knip has no config|not a pure deletion/);
  });
  test('the usage line when run with nothing', () => {
    const out = run(r.repo, 'node', ['scripts/lib/deletion.mjs']);
    assert.equal(out.code, 2);
    assert.match(out.out, /usage: deletion\.mjs prove --base <rev> --sources <file> --work <dir> \| report --base <rev>/);
  });
  test('report prints what knip lists at the base as JSON: the base and the unused files', () => {
    const base = git(r.repo, 'rev-parse', 'HEAD');
    const out = run(r.repo, 'node', ['scripts/lib/deletion.mjs', 'report', '--base', base], r.env(report(fl('src/old.js'), entry('src/lib.js', { exports: [{ name: 'x' }] }))));
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(JSON.parse(out.out), { base, files: ['src/old.js'] });
  });
  test('report exits 4 and says why when knip cannot run, and nothing else', () => {
    const out = run(r.repo, 'node', ['scripts/lib/deletion.mjs', 'report', '--base', git(r.repo, 'rev-parse', 'HEAD')], r.env('boom\n', { FAKE_KNIP_EXIT: '2' }));
    assert.equal(out.code, 4, out.out);
    assert.match(out.out, /deletion-proof: knip could not run \(exit 2\)/);
  });
  test('the module\'s prepare marker is only in the worktree: the repository itself is untouched', () => {
    assert.ok(!existsSync(join(r.repo, '.prepared')));
    assert.equal(git(r.repo, 'worktree', 'list').split('\n').length, 1, 'no worktree is left behind');
    assert.match(PREPARE, /gate_prepare/);
  });
});

describe('deletion-proof: the composite of rounds 1 and 3 through package.json', () => {
  let r;
  before(() => (r = moduleRepo({ 'src/old.js': 'export const old = 1;\n', 'src/use.js': "import { old as o } from './old';\nexport const v = o;\n", 'tools/knip-pre.js': 'export default (o) => o;\n' })));
  after(() => r.cleanup());

  test('step 1 is tier 2, step 2 tier 1, and step 3, the deletion of a file still imported, is refused', () => {
    const land = (name, files) => {
      git(r.repo, 'switch', '-q', '-C', name, 'main');
      commit(r.repo, files, name);
      const tier = run(r.repo, join(r.repo, 'scripts/tier'), ['--base', 'main']);
      git(r.repo, 'switch', '-q', 'main');
      git(r.repo, 'merge', '-q', '--ff-only', name);
      git(r.repo, 'push', '-q', 'origin', 'main');
      return tier.out;
    };
    assert.match(land('step1', { 'package.json': '{ "name": "app", "private": true, "type": "module", "knip": { "preprocessor": "./tools/knip-pre.js" } }\n' }), /^tier 2/);
    assert.match(land('step2', { 'tools/knip-pre.js': 'export default (o) => { for (const i of o.issues ?? []) i.files = [{ name: i.file }]; return o; };\n' }), /^tier 1/);
    git(r.repo, 'switch', '-q', '-C', 'step3', 'origin/main');
    commit(r.repo, { 'src/old.js': null }, 'delete old.js');
    const out = script(r.repo, 'red-check', ['--base', 'origin/main'], r.env(report(fl('src/old.js'))));
    refused(out, /config: the knip config is in package\.json; move it to knip\.json for a machine proof/);
  });
});
