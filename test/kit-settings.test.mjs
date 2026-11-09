// #335: the gate's settings across bin/onboard and bin/kit-update, from throwaway repositories (test/world.mjs): onboard
// fills them into the workflows and its evidence names them, an update carries them from the base or takes an option's,
// and a base on the kit before #335, whose workflows read repository variables, holds none, so its update must name them.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';
import { world } from './world.mjs';

const TRUSTED = '.github/workflows/gate-trusted.yml';
const MAIN = '.github/workflows/main.yml';
const kitText = (path) => readFileSync(join(factory, 'kit', path), 'utf8');
/** gate-trusted.yml as the kit had it before #335: every job on GATE_TRUSTED_RUNNER. */
const OLD_TRUSTED = kitText(TRUSTED).replaceAll('runs-on: ["ubuntu-latest"]', "runs-on: ${{ fromJSON(vars.GATE_TRUSTED_RUNNER || '\"ubuntu-latest\"') }}");

describe('bin/onboard and the gate\'s settings', () => {
  test('fills them into the workflows, and its evidence passes and names them', () => {
    const w = world({ onboardArgs: null });
    try {
      const out = w.onboard(['--runner', '["self-hosted","macOS","main"]', '--trusted-runner', '["self-hosted","linux","trusted"]']);
      assert.equal(out.code, 0, out.out);
      const rev = 'factory/kit';
      assert.doesNotMatch(w.show(rev, TRUSTED), /GATE_REVIEWER/);
      assert.match(w.show(rev, TRUSTED), /runs-on: \["self-hosted","linux","trusted"\]/);
      assert.doesNotMatch(w.show(rev, TRUSTED), /ubuntu-latest/);
      assert.match(w.show(rev, MAIN), /runs-on: \["self-hosted","macOS","main"\]/);
      assert.match(w.show(rev, '.github/workflows/gate.yml'), /runs-on: \["ubuntu-latest"\]/);
      // --no-pr opens no pull request, so its evidence is run here, as bin/onboard runs it for one.
      const repo = join(w.dir, 'root/app');
      const evidence = run(w.dir, join(w.fac, 'bin/kit-evidence'), ['--factory', w.fac, '--commit', 'HEAD', '--repo', repo, '--base', 'main', '--head', rev, '--slug', 'tuannd9288/app', '--id', 'unchecked'], w.env);
      assert.equal(evidence.code, 0, evidence.out);
      assert.match(evidence.out, /^kit-evidence: PASS$/m);
      assert.match(evidence.out, /^ {2}main's runner \(\.github\/workflows\/main\.yml\): \["self-hosted","macOS","main"\]$/m);
      assert.match(evidence.out, /^ {2}the trusted runner \(\.github\/workflows\/gate-trusted\.yml\): \["self-hosted","linux","trusted"\]$/m);
    } finally {
      w.cleanup();
    }
  });

  test('its evidence fails runners that break the rule, as a later commit on the branch could set them', () => {
    const w = world({ onboardArgs: null });
    try {
      assert.equal(w.onboard([]).code, 0);
      const repo = join(w.dir, 'root/app');
      const evidence = () => run(w.dir, join(w.fac, 'bin/kit-evidence'), ['--factory', w.fac, '--commit', 'HEAD', '--repo', repo, '--base', 'main', '--head', 'HEAD', '--slug', 'tuannd9288/app', '--id', 'unchecked'], w.env);
      assert.equal(evidence().code, 0, evidence().out);
      for (const path of [MAIN, TRUSTED]) writeFileSync(join(repo, path), readFileSync(join(repo, path), 'utf8').replaceAll('runs-on: ["ubuntu-latest"]', 'runs-on: ["self-hosted","x"]'));
      assert.equal(run(repo, 'git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'Share one self-hosted runner'], w.env).code, 0);
      const out = evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}runners: the trusted runner is self-hosted and shares a machine with main's runner \(kit\/\.gate\/enforced-rules\.md\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('refuses a value of the wrong form, or runners that break the rule, before anything is cloned', () => {
    const w = world({ onboardArgs: null });
    try {
      for (const args of [['--reviewer', 'claude'], ['--runner', 'ubuntu-latest'], ['--runner', '["self-hosted","x"]', '--pr-runner', '["self-hosted","x"]'], ['--reviewer']]) {
        const out = w.onboard(args);
        assert.equal(out.code, 2, `${args.join(' ')}\n${out.out}`);
        assert.match(out.out, /nothing done/);
        assert.equal(existsSync(join(w.dir, 'root/app')), false, args.join(' '));
      }
    } finally {
      w.cleanup();
    }
  });
});

describe('bin/kit-update and the gate\'s settings', () => {
  const runner = '["self-hosted","linux","trusted"]';

  test('carries the base\'s settings through a change of the kit\'s workflow, and an option changes one', () => {
    const w = world({ onboardArgs: ['--trusted-runner', runner] });
    try {
      w.facCommit({ [`kit/${TRUSTED}`]: `# A new first line.\n${kitText(TRUSTED)}` });
      let out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 0, out.out);
      const rev = `factory/kit-${w.sha7()}`;
      assert.match(w.show(rev, TRUSTED), /^# A new first line\.$/m);
      assert.match(w.show(rev, TRUSTED), /runs-on: \["self-hosted","linux","trusted"\]/);
      assert.match(out.out, /^ {2}the trusted runner \(\.github\/workflows\/gate-trusted\.yml\): \["self-hosted","linux","trusted"\], the base's$/m);
      assert.match(out.out, /^ {2}main's runner \(\.github\/workflows\/main\.yml\): \["ubuntu-latest"\], the base's$/m);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      // The same update with --runner: an option takes the base's place.
      w.facCommit({ [`kit/${TRUSTED}`]: `# Another first line.\n${kitText(TRUSTED)}` });
      out = w.update(['app', '--no-pr', '--runner', '["self-hosted","macOS","main"]']);
      assert.equal(out.code, 0, out.out);
      assert.match(w.show(`factory/kit-${w.sha7()}`, MAIN), /runs-on: \["self-hosted","macOS","main"\]/);
      assert.match(out.out, /^ {2}main's runner \(\.github\/workflows\/main\.yml\): \["self-hosted","macOS","main"\], given$/m);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      // The evidence, which the pull request's body carries, marks the change for the Human.
      assert.match(out.out, /^ {2}main's runner \(\.github\/workflows\/main\.yml\): \["self-hosted","macOS","main"\], CHANGED from \["ubuntu-latest"\]$/m);
      assert.match(out.out, /^ {2}the trusted runner \(\.github\/workflows\/gate-trusted\.yml\): \["self-hosted","linux","trusted"\]$/m);
    } finally {
      w.cleanup();
    }
  });

  test('a base on the kit before #335 holds no setting: its update names each the base reads from a variable, or stops', () => {
    const w = world({ kit: { [`kit/${TRUSTED}`]: OLD_TRUSTED } });
    try {
      assert.match(w.show('main', TRUSTED), /vars\.GATE_TRUSTED_RUNNER/);
      w.facCommit({ [`kit/${TRUSTED}`]: kitText(TRUSTED) });
      let out = w.update(['app', '--no-pr']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /GATE_TRUSTED_RUNNER, .* name it with --trusted-runner/);
      assert.match(out.out, /nothing done/);
      out = w.update(['app', '--no-pr', '--trusted-runner', '"ubuntu-latest"']);
      assert.equal(out.code, 0, out.out);
      const rev = `factory/kit-${w.sha7()}`;
      assert.doesNotMatch(w.show(rev, TRUSTED), /vars\./);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, /^ {2}the trusted runner \(\.github\/workflows\/gate-trusted\.yml\): \["ubuntu-latest"\], CHANGED: the base held none in the kit's form/m);
      assert.match(out.out, /^ {2}main's runner \(\.github\/workflows\/main\.yml\): \["ubuntu-latest"\]$/m);
    } finally {
      w.cleanup();
    }
  });

  test('settings that break the runner rule stop the update with nothing done', () => {
    const w = world();
    try {
      w.facCommit({ [`kit/${TRUSTED}`]: `# A new first line.\n${kitText(TRUSTED)}` });
      const out = w.update(['app', '--no-pr', '--runner', '["self-hosted","x"]', '--trusted-runner', '["self-hosted","x"]']);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /runners: the trusted runner is self-hosted and shares a machine with main's runner/);
      assert.match(out.out, /nothing done/);
    } finally {
      w.cleanup();
    }
  });
});
