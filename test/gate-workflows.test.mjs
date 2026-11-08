// #133: what GitHub and bash read in the kit's workflows and in .gate/bin/verify-timeout: the
// timeout that comes from .gate/config.sh, the runner a candidate's code gets and the runner of gate-trusted's jobs. Nothing
// here reads the wording of a rule.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const yaml = (file) => JSON.parse(spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0]))', join(factory, 'kit/.github/workflows', file)], { encoding: 'utf8' }).stdout);
const gate = yaml('gate.yml');
const trusted = yaml('gate-trusted.yml');
const TIMEOUT = join(factory, 'kit/.gate/bin/verify-timeout');

describe('the runners, which bin/onboard fills in (item 10, #154, #335)', () => {
  const main = yaml('main.yml');
  test('every job of the kit\'s workflows runs on GitHub-hosted Ubuntu, a literal list, until bin/onboard fills it in', () => {
    for (const [file, workflow] of [['main.yml', main], ['gate.yml', gate], ['gate-trusted.yml', trusted]]) {
      for (const [id, job] of Object.entries(workflow.jobs)) assert.deepEqual(job['runs-on'], ['ubuntu-latest'], `${file} ${id}`);
    }
    assert.doesNotMatch(JSON.stringify(gate), /self-hosted/);
  });

  test('no kit workflow reads a repository variable, which changes without a pull request (#335)', () => {
    for (const file of ['main.yml', 'gate.yml', 'gate-trusted.yml']) assert.doesNotMatch(readFileSync(join(factory, 'kit/.github/workflows', file), 'utf8'), /\bvars\./, file);
  });

});

describe('.gate/bin/verify-timeout (item 9)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-timeout-'));
  const kit = (config) => {
    rmSync(join(dir, '.gate'), { recursive: true, force: true });
    mkdirSync(join(dir, '.gate/bin'), { recursive: true });
    cpSync(TIMEOUT, join(dir, '.gate/bin/verify-timeout'));
    chmodSync(join(dir, '.gate/bin/verify-timeout'), 0o755);
    writeFileSync(join(dir, '.gate/config.sh'), config);
    return (...args) => run(dir, join(dir, '.gate/bin/verify-timeout'), args);
  };

  test('prints the minutes .gate/config.sh gives, 30 when it gives none, and the seconds with --seconds', () => {
    assert.equal(kit('GATE_CHECKS=""\n')().out.trim(), '30');
    assert.equal(kit('GATE_VERIFY_TIMEOUT=45\n')().out.trim(), '45');
    assert.equal(kit('GATE_VERIFY_TIMEOUT=45\n')('--seconds').out.trim(), '2700');
    assert.equal(kit('GATE_VERIFY_TIMEOUT=60\n')().out.trim(), '60');
    assert.equal(kit('')('--max').out.trim(), '60');
  });

  test('a value that is not a whole number of minutes from 1 to 60 is exit 2 and prints no number', () => {
    for (const bad of ['0', '61', '-5', 'abc', '4.5', '"1 2"', '09']) {
      const r = kit(`GATE_VERIFY_TIMEOUT=${bad}\n`)();
      assert.equal(r.code, 2, `${bad}: ${r.out}`);
      assert.doesNotMatch(r.out, /^\d+$/m, bad);
    }
    assert.equal(kit('GATE_VERIFY_TIMEOUT=abc\n')('--seconds').code, 2);
  });

  test('a config that cannot be read is exit 2', () => {
    const r = kit('this is not shell (\n')();
    assert.equal(r.code, 2, r.out);
  });
});

describe('gate.yml\'s cfg step in main\'s checkout (item 9)', () => {
  // GitHub runs the candidate's gate.yml against main's checkout, so a kit update from a kit older than #133 runs this step
  // where main has no .gate/bin/verify-timeout (factory-onboard-scratch#5).
  const cfg = gate.jobs.verify.steps.find((s) => s.id === 'cfg');
  const dir = mkdtempSync(join(tmpdir(), 'gate-cfg-'));
  const step = (files) => {
    rmSync(join(dir, '.gate'), { recursive: true, force: true });
    mkdirSync(join(dir, '.gate/bin'), { recursive: true });
    for (const [path, [body, mode]] of Object.entries(files)) {
      writeFileSync(join(dir, path), body);
      chmodSync(join(dir, path), mode);
    }
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync('bash', ['-e', '-c', cfg.run], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: output } });
    return { code: r.status, output: readFileSync(output, 'utf8') };
  };
  const timeout = (mode = 0o755) => [readFileSync(TIMEOUT, 'utf8'), mode];

  test('a main whose kit has no verify-timeout gets 30 minutes, the limit its own gate.yml gave', () => {
    assert.deepEqual(step({ '.gate/config.sh': ['GATE_CHECKS=""\n', 0o644] }), { code: 0, output: 'minutes=30\n' });
  });

  test('a main with verify-timeout gets its value, and the step fails when it cannot read or run it', () => {
    assert.deepEqual(step({ '.gate/config.sh': ['GATE_VERIFY_TIMEOUT=45\n', 0o644], '.gate/bin/verify-timeout': timeout() }), { code: 0, output: 'minutes=45\n' });
    for (const config of ['GATE_VERIFY_TIMEOUT=abc\n', 'this is not shell (\n']) {
      const r = step({ '.gate/config.sh': [config, 0o644], '.gate/bin/verify-timeout': timeout() });
      assert.notEqual(r.code, 0, config);
      assert.equal(r.output, '', config);
    }
    const r = step({ '.gate/config.sh': ['GATE_VERIFY_TIMEOUT=45\n', 0o644], '.gate/bin/verify-timeout': timeout(0o644) });
    assert.notEqual(r.code, 0, 'a verify-timeout that is there but cannot run');
    assert.equal(r.output, '');
  });
});

describe('the ceilings that follow the timeout (item 9)', () => {
  const max = Number(run(factory, TIMEOUT, ['--max']).out.trim());
  const jobs = { ...gate.jobs, ...trusted.jobs };

  test('the verify step takes its timeout from the config through a step output, under a job ceiling that holds the largest value and setup', () => {
    assert.equal(max, 60);
    const steps = gate.jobs.verify.steps;
    const cfg = steps.findIndex((s) => s.id === 'cfg');
    const verify = steps.findIndex((s) => /verify-trusted/.test(String(s.run)));
    assert.ok(cfg >= 0 && verify > cfg, 'cfg runs before the step that runs verify-trusted');
    assert.match(String(steps[cfg].run), /verify-timeout/);
    assert.equal(steps[cfg]['working-directory'], 'trusted');
    assert.equal(steps[verify]['timeout-minutes'], '${{ fromJSON(steps.cfg.outputs.minutes) }}');
    assert.ok(gate.jobs.verify['timeout-minutes'] >= max + 30);
  });

});

describe('the repository\'s own Node and pnpm (#155)', () => {
  // gate.yml reads them from the candidate, which runs on them anyway; main.yml from main. One step, in both.
  const main = yaml('main.yml');
  const tools = (wf) => wf.jobs.verify.steps.find((s) => s.id === 'tools');
  const dir = mkdtempSync(join(tmpdir(), 'gate-tools-'));
  const read = (files) => {
    for (const f of ['.node-version', 'package.json']) rmSync(join(dir, f), { force: true });
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync('bash', ['-e', '-c', tools(gate).run], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: output } });
    return { code: r.status, output: readFileSync(output, 'utf8') };
  };

  test('both workflows set up the Node and pnpm one step reads, before any step runs the kit', () => {
    for (const [wf, cwd] of [[gate, 'candidate'], [main, undefined]]) {
      const steps = wf.jobs.verify.steps;
      const at = steps.findIndex((s) => s.id === 'tools');
      const node = steps.findIndex((s) => String(s.uses).startsWith('actions/setup-node@'));
      const pnpm = steps.findIndex((s) => String(s.uses).startsWith('pnpm/action-setup@'));
      const kit = steps.findIndex((s) => /\.gate\/bin/.test(String(s.run)));
      assert.ok(at >= 0 && node > at && pnpm > node && kit > pnpm, `${wf.name}: tools ${at}, node ${node}, pnpm ${pnpm}, kit ${kit}`);
      assert.equal(steps[at].run, tools(gate).run, wf.name);
      assert.equal(steps[at].shell, 'bash', wf.name);
      assert.equal(steps[at]['working-directory'], cwd, wf.name);
      assert.equal(steps[node].with['node-version'], '${{ steps.tools.outputs.node }}', wf.name);
      assert.match(steps[pnpm].uses, /^pnpm\/action-setup@[0-9a-f]{40}$/, wf.name);
      assert.equal(steps[pnpm].if, "steps.tools.outputs.pnpm != ''", wf.name);
      assert.deepEqual(steps[pnpm].with, { version: '${{ steps.tools.outputs.pnpm }}' }, wf.name);
    }
  });

  test('Node is 24 without .node-version, else the plain version it holds; anything else fails the step and sets nothing', () => {
    assert.deepEqual(read({}), { code: 0, output: 'node=24\npnpm=\n' });
    assert.deepEqual(read({ '.node-version': '26.3.0\n' }), { code: 0, output: 'node=26.3.0\npnpm=\n' });
    assert.deepEqual(read({ '.node-version': 'v22\n' }), { code: 0, output: 'node=22\npnpm=\n' });
    for (const bad of ['lts/*\n', '', '26.3.0\npnpm=1\n', 'latest\n', '26.3.0.1\n']) assert.deepEqual(read({ '.node-version': bad }), { code: 1, output: '' }, JSON.stringify(bad));
  });

  test('pnpm is the plain version package.json\'s packageManager names, without its hash; none for another manager or none named', () => {
    const pkg = (pm) => ({ 'package.json': `{\n  "name": "app",\n  "packageManager": "${pm}",\n  "private": true\n}\n` });
    assert.deepEqual(read(pkg('pnpm@11.1.2')), { code: 0, output: 'node=24\npnpm=11.1.2\n' });
    assert.deepEqual(read(pkg('pnpm@11.1.2+sha512.0123abcdef')), { code: 0, output: 'node=24\npnpm=11.1.2\n' });
    assert.deepEqual(read({ 'package.json': '{"packageManager":"pnpm@10.4.1"}' }), { code: 0, output: 'node=24\npnpm=10.4.1\n' });
    assert.deepEqual(read(pkg('yarn@4.1.0')), { code: 0, output: 'node=24\npnpm=\n' });
    assert.deepEqual(read({ 'package.json': '{ "name": "app" }\n' }), { code: 0, output: 'node=24\npnpm=\n' });
    for (const bad of ['pnpm@latest', 'pnpm@^11.1', 'pnpm@11.1.2\\nnode=1']) assert.deepEqual(read(pkg(bad)), { code: 1, output: '' }, bad);
  });
});
