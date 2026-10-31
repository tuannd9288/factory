// The probe driver scripts: nothing here opens a pull request or runs a probe.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from '../helpers.mjs';
import { issue, team } from '../../kit/.gate/bin/lib/prbody.mjs';

const probes = join(factory, 'probes');
const read = (name) => (existsSync(join(probes, name)) ? readFileSync(join(probes, name), 'utf8') : '');

test('the driver scripts parse', () => {
  for (const name of ['drive.sh', 'probes.sh', 'run.sh', 'dry.sh', 'wait.sh', 'tree.sh']) {
    const text = read(name);
    assert.ok(text, `probes/${name} is missing`);
    assert.equal(spawnSync('bash', ['-n', join(probes, name)]).status, 0, `probes/${name} does not parse`);
  }
});

// #134 item 3: on the kit since #133 a pull request names its team (verify reads Team:) and its issue (tier reads Issue:).
// A probe works on no issue, so it takes no claim; the kit's own parser reads the body probe_open sends.
test('probe_open sends a body with "Team: probe" and "Issue: none", as the kit reads them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-open-'));
  try {
    const out = join(dir, 'body');
    const script = `PROBE_REPO=o/scratch PROBE_HOME=${JSON.stringify(dir)}; source ${JSON.stringify(join(probes, 'drive.sh'))}
git() { :; }; gh() { printf '%s' "\${@: -1}" >${JSON.stringify(out)}; }; probe_open probe/c1 'A title' 'What the change does.'`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(out, 'utf8');
    assert.deepEqual(team(body), { ok: true, value: 'probe' });
    assert.deepEqual(issue(body), { ok: true, kind: 'none' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #96: the acceptance probe A1, counted apart from the 40. Its builder opens the issue it closes; a dry run must not.
describe('p_A1', () => {
  let dir;
  const probesSh = join(probes, 'probes.sh');
  // Builds A1 in a throwaway git repository, with a gh that records its arguments and prints the URL of issue 77.
  const build = (env = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'a1-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), `#!/bin/sh\necho "$*" >>"${dir}/gh-calls"\nif [ "$1 $2" = "issue create" ]; then echo https://github.com/o/scratch/issues/77; exit 0; fi\nexit 1\n`);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    mkdirSync(join(dir, 'w'));
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 't'], ['config', 'user.email', 't@x']]) spawnSync('git', args, { cwd: join(dir, 'w') });
    const script = `REPO=o/scratch; source ${JSON.stringify(probesSh)}; probe_commit() { git add -A && git commit -q -m "$1"; }; T=""; B=""; p_A1 || exit 9; printf '%s' "$B" >"${dir}/body"; printf '%s' "$T" >"${dir}/title"`;
    return spawnSync('bash', ['-c', script], { cwd: join(dir, 'w'), encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ...env } });
  };
  const calls = () => (existsSync(join(dir, 'gh-calls')) ? readFileSync(join(dir, 'gh-calls'), 'utf8') : '');

  test('opens the issue it closes with gh issue create, reads its number from the URL, and writes Closes #<n> in the body', () => {
    const r = build();
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(), /^issue create --repo o\/scratch --title .*--body /);
    assert.equal(calls().match(/^issue create /gm).length, 1, calls());
    assert.match(readFileSync(join(dir, 'body'), 'utf8'), /\n\nCloses #77$/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a dry run (PROBE_DRY) opens no issue, and dry.sh sets it', () => {
    const r = build({ PROBE_DRY: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(), '');
    assert.match(readFileSync(join(dir, 'body'), 'utf8'), /Closes #\d+$/);
    rmSync(dir, { recursive: true, force: true });
    assert.match(read('dry.sh'), /^(export )?PROBE_DRY=1/m);
  });

  test('the change passes its own test and matches its body, but breaks an acceptance item only the issue states', () => {
    const r = build({ PROBE_DRY: '1' });
    assert.equal(r.status, 0, r.stderr);
    const w = join(dir, 'w');
    // helpers.run drops NODE_TEST_CONTEXT, which would make a nested `node --test` exit 0 whatever happens.
    const own = run(w, process.execPath, ['--test', 'test/initials.test.js']);
    assert.equal(own.code, 0, own.out);
    const probe = "import('./src/initials.js').then((m) => { console.log(m.initials('Nguyễn Văn Tuấn')); try { m.initials(''); console.log('returned'); } catch { console.log('threw'); } })";
    const initials = spawnSync(process.execPath, ['-e', probe], { cwd: w, encoding: 'utf8' });
    assert.equal(initials.stdout, 'NVT\nthrew\n');
    assert.doesNotMatch(readFileSync(join(dir, 'body'), 'utf8'), /rỗng|trống|empty|blank/i, 'the body must not state the item the code breaks');
    // Without the source the test fails as a test, not as a load error (red-check).
    rmSync(join(w, 'src'), { recursive: true });
    const without = run(w, process.execPath, ['--test', 'test/initials.test.js']);
    assert.notEqual(without.code, 0, without.out);
    assert.match(without.out, /fail 1/);
    rmSync(dir, { recursive: true, force: true });
  });
});
