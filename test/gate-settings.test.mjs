// #335: the gate's three settings as the kit's workflows hold them once bin/onboard filled them in, read back from the text,
// the form an option gives one in, and the runner rule over them (#210's cases, which bin/onboard-owner checked before).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';
import { DEFAULTS, GATE, MAIN, TRUSTED, WORKFLOWS, parseOptions, render, runnerProblems, valuesIn, valuesOf } from '../bin/lib/gate-settings.mjs';

const kit = (path) => readFileSync(join(factory, 'kit', path), 'utf8');
const VALUES = { runner: ['self-hosted', 'macOS', 'main'], prRunner: ['ubuntu-24.04'], trustedRunner: ['self-hosted', 'linux', 'trusted'] };
const filled = (values) => Object.fromEntries(WORKFLOWS.map((p) => [p, render(p, kit(p), values)]));
const opts = (argv) => {
  const { values, problem } = parseOptions(argv);
  assert.equal(problem, undefined, argv.join(' '));
  return values;
};

test('the kit filled in with the defaults is the kit, and every value it holds is read back from the filled-in text', () => {
  for (const p of WORKFLOWS) assert.equal(render(p, kit(p), {}), kit(p), p);
  assert.deepEqual(valuesIn(filled({})), DEFAULTS);
  assert.deepEqual(valuesIn(filled(VALUES)), VALUES);
});

test('every job of a workflow gets its runner, and no workflow names a reviewer (FAC-100)', () => {
  const files = filled(VALUES);
  const runsOn = (text) => text.split('\n').filter((l) => /^\s*runs-on:/.test(l)).map((l) => l.trim());
  assert.deepEqual([...new Set(runsOn(files[MAIN]))], ['runs-on: ["self-hosted","macOS","main"]']);
  assert.deepEqual([...new Set(runsOn(files[GATE]))], ['runs-on: ["ubuntu-24.04"]']);
  assert.deepEqual([...new Set(runsOn(files[TRUSTED]))], ['runs-on: ["self-hosted","linux","trusted"]']);
  assert.equal(runsOn(files[TRUSTED]).length, runsOn(kit(TRUSTED)).length);
  for (const p of WORKFLOWS) assert.doesNotMatch(files[p], /GATE_REVIEWER/, p);
});

test('a text not in the kit\'s form holds no value: the old kit\'s variables, two runners in one file; of a reviewer line, only an old kit\'s entire is read (#155, FAC-100)', () => {
  assert.deepEqual(valuesOf(GATE, "    runs-on: ${{ fromJSON(vars.GATE_PR_RUNNER || '\"ubuntu-latest\"') }}\n"), {});
  assert.deepEqual(valuesOf(MAIN, '  a:\n    runs-on: ["x"]\n  b:\n    runs-on: ["y"]\n'), {});
  assert.deepEqual(valuesOf(MAIN, '    runs-on: "ubuntu-latest"\n'), {});
  assert.deepEqual(valuesOf(MAIN, '    runs-on: ubuntu-latest\n'), {});
  assert.deepEqual(valuesOf(TRUSTED, "env:\n  GATE_REVIEWER: 'entire'\n"), { reviewer: 'entire' });
  assert.deepEqual(valuesOf(TRUSTED, "env:\n  GATE_REVIEWER: 'entire'\n  GATE_REVIEWER: 'entire'\n"), {});
  assert.deepEqual(valuesOf(TRUSTED, "env:\n  GATE_REVIEWER: 'claude'\n"), {});
  assert.deepEqual(valuesOf(TRUSTED, 'env:\n  GATE_REVIEWER: ${{ vars.GATE_REVIEWER }}\n'), {});
});

test('a value of the wrong form is refused (#210)', () => {
  const bad = [
    ['--runner', 'ubuntu-latest'],
    ['--runner', '[]'],
    ['--runner', '[1]'],
    ['--runner', '{"group":"x"}'],
    ['--pr-runner', '["a b"]'],
    ['--trusted-runner', '""'],
    ['--reviewer', 'claude'],
    ['--runner'],
    ['--runer', '"ubuntu-latest"'],
  ];
  for (const argv of bad) assert.ok(parseOptions(argv).problem, argv.join(' '));
  assert.deepEqual(opts(['--runner', '"ubuntu-latest"']), { runner: ['ubuntu-latest'] });
});

test('a self-hosted runner that is, holds, is held by or shares a label with another job\'s is refused (#210)', () => {
  const refused = [
    [['--runner', '["self-hosted","macOS"]', '--trusted-runner', '["self-hosted","macOS"]'], /the trusted runner .* main's runner/],
    [['--pr-runner', '["self-hosted","macOS","a"]', '--trusted-runner', '["a","macOS","self-hosted"]'], /the trusted runner .* the candidate's runner/],
    [['--runner', '["self-hosted","macOS","ci-box"]', '--trusted-runner', '["self-hosted","linux","ci-box"]'], /the trusted runner/],
    [['--pr-runner', '["ci-box"]', '--trusted-runner', '["self-hosted","linux","ci-box"]'], /the trusted runner/],
    [['--trusted-runner', '"my-runner"', '--runner', '"my-runner"'], /the trusted runner/],
    [['--pr-runner', '["self-hosted","macOS"]', '--trusted-runner', '["self-hosted","macOS","trusted"]'], /the trusted runner/],
    [['--runner', '["self-hosted","macOS","main"]', '--trusted-runner', '["self-hosted","macOS"]'], /the trusted runner/],
    [['--runner', '["self-hosted","main"]', '--trusted-runner', '"self-hosted"'], /the trusted runner/],
    [['--runner', '"macos-mini"', '--trusted-runner', '"macos-mini"'], /the trusted runner/],
    [['--runner', '["self-hosted","macOS","main"]', '--pr-runner', '["self-hosted","macOS","main"]'], /the candidate's runner .* main's runner/],
    [['--runner', '["self-hosted","macOS"]', '--pr-runner', '["self-hosted","macOS","pr"]'], /the candidate's runner/],
    [['--runner', '["self-hosted","macOS","main"]', '--pr-runner', '["self-hosted","macOS"]'], /the candidate's runner/],
    [['--runner', '["self-hosted","macOS","ci-box","a"]', '--pr-runner', '["self-hosted","linux","ci-box","b"]'], /the candidate's runner/],
    // An InstaBox snapshot label is not one of its size labels, so it stays self-hosted (FAC-125).
    [['--runner', '"instabox-medium-snapshot-acme-warm"', '--pr-runner', '"instabox-medium-snapshot-acme-warm"'], /the candidate's runner .* main's runner/],
  ];
  for (const [argv, words] of refused) {
    const problems = runnerProblems(opts(argv));
    assert.ok(problems.length, argv.join(' '));
    assert.match(problems.join('; '), words, argv.join(' '));
  }
});

test('GitHub-hosted and InstaBox size runners may be the same for all three, a self-hosted one may share only the OS and architecture, and an old kit\'s entire lifts the rule (#210, #155, FAC-125)', () => {
  const allowed = [
    [],
    ['--runner', '"ubuntu-latest"', '--pr-runner', '"ubuntu-latest"', '--trusted-runner', '"ubuntu-latest"'],
    ['--runner', '"instabox-medium"', '--pr-runner', '"instabox-medium"', '--trusted-runner', '"instabox-medium"'],
    ['--runner', '["self-hosted","macOS","ARM64","a"]', '--pr-runner', '["self-hosted","macOS","ARM64","b"]', '--trusted-runner', '["self-hosted","macOS","ARM64","t"]'],
    ['--runner', '["self-hosted","macOS","a"]', '--trusted-runner', '"ubuntu-latest"'],
  ];
  for (const argv of allowed) assert.deepEqual(runnerProblems(opts(argv)), [], argv.join(' '));
  const shared = ['--runner', '["self-hosted","macOS"]', '--pr-runner', '["self-hosted","macOS"]', '--trusted-runner', '["self-hosted","macOS"]'];
  assert.equal(runnerProblems(opts(shared)).length, 3);
  assert.deepEqual(runnerProblems({ ...opts(shared), reviewer: 'entire' }), []);
});

test('the command line bin/onboard uses: check exits 2 with the problem, render fills a kit file in place', () => {
  const cli = join(factory, 'bin/lib/gate-settings.mjs');
  assert.equal(run(factory, 'node', [cli, 'check', '--runner', '"ubuntu-latest"']).code, 0);
  let r = run(factory, 'node', [cli, 'check', '--runner', '["self-hosted","x"]', '--trusted-runner', '["self-hosted","x"]']);
  assert.equal(r.code, 2);
  assert.match(r.out, /the trusted runner is self-hosted and shares a machine with main's runner/);
  r = run(factory, 'node', [cli, 'check', '--reviewer', 'stub']);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument --reviewer/);
  const dir = mkdtempSync(join(tmpdir(), 'gate-settings-'));
  try {
    const path = join(dir, '.github/workflows/gate-trusted.yml');
    run(dir, 'mkdir', ['-p', join(dir, '.github/workflows')]);
    writeFileSync(path, kit(TRUSTED));
    r = run(dir, 'node', [cli, 'render', TRUSTED, '--human', 'someone', '--trusted-runner', '["self-hosted","t"]']);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path, 'utf8'), render(TRUSTED, kit(TRUSTED), { trustedRunner: ['self-hosted', 't'] }));
    writeFileSync(join(dir, '.github/CODEOWNERS'), kit('.github/CODEOWNERS'));
    assert.equal(run(dir, 'node', [cli, 'render', '.github/CODEOWNERS', '--human', 'someone']).code, 0);
    assert.match(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8'), /@someone/);
    assert.doesNotMatch(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8'), /@OWNER/);
    assert.equal(run(dir, 'node', [cli, 'render', 'README.md', '--human', 'someone']).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const mergeMethod of ['squash', 'merge']) {
  test(`renders only ${mergeMethod} in a kit ruleset and reads it back`, () => {
    const path = '.gate/ruleset.json';
    const text = render(path, kit(path), { mergeMethod });
    assert.deepEqual(JSON.parse(text).rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods, [mergeMethod]);
    assert.deepEqual(valuesOf(path, text), { mergeMethod });
  });
}
