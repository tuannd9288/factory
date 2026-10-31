// bin/claude-canary (#24): Claude Code updates itself on the stable channel into <versions>/<version>; the launcher
// decides which one runs. The canary runs the pack probe on the newest version and moves the launcher only when it
// passes. Everything here is offline: a temp versions folder of fake files, a temp launcher, a temp state folder, and
// a fake probe that exits 0, 1 or 2 and prints FAIL lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const read = (path) => readFileSync(path, 'utf8');
const launcherText = (versions, v) => `#!/bin/sh\nexec '${join(versions, v)}' "$@"\n`;

/** A machine: versions (fake claude files), a launcher (an installer symlink to `current`, or a script of ours when
 * `script` is set), state, and a fake probe whose exit code and output the test chooses. */
function withMachine({ versions: names, current, script = false, probed, rejected, exit = 0, output = '' }, body) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-'));
  try {
    const versions = join(dir, 'versions');
    const state = join(dir, 'state');
    const launcher = join(dir, 'bin', 'claude');
    mkdirSync(versions);
    mkdirSync(state);
    mkdirSync(join(dir, 'bin'));
    for (const v of names) writeFileSync(join(versions, v), `claude ${v}\n`);
    if (current && script) writeFileSync(join(dir, 'bin', 'claude'), launcherText(versions, current));
    else if (current) symlinkSync(join(versions, current), launcher);
    if (probed) writeFileSync(join(state, 'claude-probed'), `${probed}\n`);
    if (rejected) writeFileSync(join(state, 'claude-rejected'), `${rejected}\n`);
    const probe = join(dir, 'probe.sh');
    writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${dir}/probe-args'\necho "alerts=$FACTORY_NO_ALERTS" >> '${dir}/probe-env'\ncat '${dir}/probe-output'\nexit $(cat '${dir}/probe-exit')\n`);
    chmodSync(probe, 0o755);
    const setProbe = (code, text = '') => (writeFileSync(join(dir, 'probe-exit'), `${code}\n`), writeFileSync(join(dir, 'probe-output'), text));
    setProbe(exit, output);
    const run = (args = ['--probe', probe]) => {
      const { FACTORY_NO_ALERTS, ...outer } = process.env;
      const r = spawnSync(join(factory, 'bin/claude-canary'), ['run', '--repo', 'o/app', ...args], {
        encoding: 'utf8',
        env: { ...outer, FACTORY_STATE: state, CLAUDE_VERSIONS: versions, CLAUDE_LAUNCHER: launcher },
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const probeCalls = () => (existsSync(join(dir, 'probe-env')) ? read(join(dir, 'probe-env')).trim().split('\n').length : 0);
    body({ dir, versions, state, launcher, run, setProbe, probeCalls, probeArgs: () => (existsSync(join(dir, 'probe-args')) ? read(join(dir, 'probe-args')).trim().split('\n') : []), probeEnv: () => read(join(dir, 'probe-env')).trim() });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('first run from the installer\'s symlink, probe passes: the launcher becomes our script, the version is recorded, older ones go', () => {
  withMachine({ versions: ['2.1.300', '2.1.309'], current: '2.1.309' }, ({ versions, state, launcher, run, probeArgs, probeEnv }) => {
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.equal(read(launcher), launcherText(versions, '2.1.309'));
    assert.ok(!lstatSync(launcher).isSymbolicLink());
    assert.equal(lstatSync(launcher).mode & 0o777, 0o755);
    assert.equal(read(join(state, 'claude-probed')), '2.1.309\n');
    assert.ok(!existsSync(join(state, 'claude-canary.failed')) && !existsSync(join(state, 'claude-rejected')));
    assert.deepEqual(readdirSync(versions), ['2.1.309'], 'versions older than the previous current are removed');
    assert.deepEqual(readdirSync(join(launcher, '..')), ['claude'], 'no temp file is left beside the launcher');
    assert.deepEqual(probeArgs().slice(-2), ['--claude', `direnv exec . ${join(versions, '2.1.309')}`], 'the probe is told which claude to run');
    assert.equal(probeEnv(), 'alerts=1', 'the probe runs with FACTORY_NO_ALERTS=1');
  });
});

test('the default probe is the clone\'s pack probe for the repository, without the pull request session', () => {
  withMachine({ versions: ['2.1.309'], current: '2.1.309' }, ({ dir, versions, run }) => {
    // A fake node first on PATH shows the command line the canary built; it exits 0.
    mkdirSync(join(dir, 'fake'));
    // The wrapper runs canary.mjs with node too: that call goes to the real one.
    writeFileSync(join(dir, 'fake/node'), `#!/bin/sh\ncase "$1" in *canary.mjs) exec '${process.execPath}' "$@" ;; esac\nprintf '%s\\n' "$@" > '${dir}/node-args'\n`);
    chmodSync(join(dir, 'fake/node'), 0o755);
    const { FACTORY_NO_ALERTS, ...outer } = process.env;
    const r = spawnSync(join(factory, 'bin/claude-canary'), ['run', '--repo', 'o/app'], {
      encoding: 'utf8',
      env: { ...outer, PATH: `${join(dir, 'fake')}:${outer.PATH}`, FACTORY_STATE: join(dir, 'state'), CLAUDE_VERSIONS: versions, CLAUDE_LAUNCHER: join(dir, 'bin/claude') },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(read(join(dir, 'node-args')).trim().split('\n'), [join(factory, 'probes/pack-probe.mjs'), '--repo', 'o/app', '--no-pr', '--claude', `direnv exec . ${join(versions, '2.1.309')}`]);
  });
});

test('first run from the installer\'s symlink, probe fails: the symlink stays, the version is rejected, the failure is written', () => {
  const lines = [...Array.from({ length: 12 }, (_, i) => `FAIL item ${i}`), 'PASS fine one', 'INCONCLUSIVE last item'].join('\n');
  withMachine({ versions: ['2.1.309'], current: '2.1.309', exit: 1, output: `${lines}\n` }, ({ versions, state, launcher, run }) => {
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.ok(lstatSync(launcher).isSymbolicLink());
    assert.equal(readlinkSync(launcher), join(versions, '2.1.309'));
    assert.equal(read(join(state, 'claude-rejected')), '2.1.309\n');
    assert.ok(!existsSync(join(state, 'claude-probed')));
    const failed = read(join(state, 'claude-canary.failed')).trimEnd().split('\n');
    assert.match(failed[0], /^20\d\d-\d\d-\d\dT[\d:.]+Z claude 2\.1\.309 failed the probe; the launcher stays on 2\.1\.309$/);
    assert.equal(failed.length, 1 + 10, 'at most 10 probe lines');
    assert.ok(failed.slice(1).every((l) => /^(FAIL|INCONCLUSIVE)\b/.test(l)));
    assert.equal(failed[1], 'FAIL item 0');
  });
});

test('a new version that passes: the launcher swaps to it and the versions older than the previous current go, numerically', () => {
  withMachine({ versions: ['2.1.2', '2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', rejected: '2.1.8' }, ({ versions, state, launcher, run, probeArgs }) => {
    writeFileSync(join(state, 'claude-canary.failed'), 'stale\n');
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.equal(read(launcher), launcherText(versions, '2.1.10'), '2.1.10 is newer than 2.1.9');
    assert.equal(lstatSync(launcher).mode & 0o777, 0o755);
    assert.equal(read(join(state, 'claude-probed')), '2.1.10\n');
    assert.ok(!existsSync(join(state, 'claude-canary.failed')) && !existsSync(join(state, 'claude-rejected')));
    assert.deepEqual(readdirSync(versions).sort(), ['2.1.10', '2.1.9'], 'the candidate and the previous current stay');
    assert.ok(probeArgs().at(-1).endsWith(join(versions, '2.1.10')));
  });
});

test('a version newer than the candidate is kept when it is rejected-skipped, not pruned', () => {
  withMachine({ versions: ['2.1.5', '2.1.9', '2.1.10', '2.1.11'], current: '2.1.9', script: true, probed: '2.1.9', rejected: '2.1.11' }, ({ versions, state, launcher, run }) => {
    assert.equal(run().code, 0);
    assert.equal(read(launcher), launcherText(versions, '2.1.10'), 'the rejected 2.1.11 is skipped');
    assert.deepEqual(readdirSync(versions).sort(), ['2.1.10', '2.1.11', '2.1.9'], 'anything newer is kept');
    assert.ok(!existsSync(join(state, 'claude-rejected')));
  });
});

test('a new version that fails: the launcher stays, the version is rejected, the failure says where the launcher is', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', exit: 1, output: 'PASS a\nFAIL .env read refused by a deny rule: x\n' }, ({ versions, state, launcher, run }) => {
    const before = read(launcher);
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.equal(read(launcher), before);
    assert.equal(read(join(state, 'claude-rejected')), '2.1.10\n');
    assert.equal(read(join(state, 'claude-probed')), '2.1.9\n');
    const failed = read(join(state, 'claude-canary.failed')).trimEnd().split('\n');
    assert.match(failed[0], /Z claude 2\.1\.10 failed the probe; the launcher stays on 2\.1\.9$/);
    assert.deepEqual(failed.slice(1), ['FAIL .env read refused by a deny rule: x']);
    assert.deepEqual(readdirSync(versions).sort(), ['2.1.10', '2.1.9'], 'nothing is pruned on a failure');
  });
});

test('a rejected version is not probed again, but a newer one is', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', exit: 1, output: 'FAIL x\n' }, ({ versions, state, run, probeCalls, setProbe }) => {
    assert.equal(run().code, 1);
    assert.equal(probeCalls(), 1);
    const again = run();
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /nothing to do/i);
    assert.equal(probeCalls(), 1, 'the rejected version was probed again');
    assert.ok(existsSync(join(state, 'claude-canary.failed')), 'the failure stays until a probe passes');
    writeFileSync(join(versions, '2.1.11'), 'claude\n');
    setProbe(0);
    assert.equal(run().code, 0);
    assert.equal(probeCalls(), 2);
    assert.equal(read(join(state, 'claude-probed')), '2.1.11\n');
    assert.ok(!existsSync(join(state, 'claude-canary.failed')));
  });
});

test('a probe that could not run writes why, with its exit code, and rejects nothing', () => {
  for (const exit of [2, 127]) {
    withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', exit }, ({ state, launcher, run }) => {
      const before = read(launcher);
      const r = run();
      assert.notEqual(r.code, 0, r.out);
      assert.equal(read(launcher), before);
      assert.ok(!existsSync(join(state, 'claude-rejected')));
      assert.match(read(join(state, 'claude-canary.failed')), new RegExp(`claude 2\\.1\\.10: the probe could not run \\(exit ${exit}\\)`));
    });
  }
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ state, run }) => {
    run(['--probe', '/no/such/probe']);
    assert.match(read(join(state, 'claude-canary.failed')), /the probe could not run \(exit 127\)/);
    assert.ok(!existsSync(join(state, 'claude-rejected')));
  });
});

test('nothing new: the candidate is the current version and already probed, so nothing runs and it exits 0', () => {
  withMachine({ versions: ['2.1.9'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ state, run, probeCalls }) => {
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing to do/i);
    assert.equal(probeCalls(), 0);
    assert.ok(!existsSync(join(state, 'claude-canary.failed')));
  });
});

test('a launcher that is neither our script nor the installer\'s symlink is an error written to the failed file; no probe runs', () => {
  withMachine({ versions: ['2.1.9'] }, ({ dir, state, launcher, run, probeCalls }) => {
    writeFileSync(launcher, '#!/bin/sh\necho hand-made\n');
    let r = run();
    assert.notEqual(r.code, 0);
    assert.match(read(join(state, 'claude-canary.failed')), /claude: the launcher .*claude is neither/);
    rmSync(launcher);
    symlinkSync(join(dir, 'elsewhere'), launcher);
    r = run();
    assert.notEqual(r.code, 0);
    assert.match(read(join(state, 'claude-canary.failed')), /neither/);
    rmSync(launcher);
    r = run();
    assert.notEqual(r.code, 0, 'a missing launcher');
    assert.equal(probeCalls(), 0);
  });
});

// --- the launchd job ---

function plistOf(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-plist-'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const r = spawnSync(join(factory, 'bin/claude-canary'), args, { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: join(dir, 'home'), ...env } });
    writeFileSync(join(dir, 'job.plist'), r.stdout);
    const p = spawnSync('python3', ['-I', '-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', join(dir, 'job.plist')], { encoding: 'utf8' });
    return { code: r.status, err: r.stderr, text: r.stdout, home: join(dir, 'home'), job: p.status === 0 ? JSON.parse(p.stdout) : null, written: readdirSync(join(dir, 'home')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('plist --daemon prints the canary as a LaunchDaemon: every six hours, at load, never KeepAlive, its own log', () => {
  const r = plistOf(['plist', '--daemon', '--repo', 'o/app'], { CLAUDE_LAUNCHER: '/h/.local/bin/claude', FACTORY_STATE: '/h/state' });
  assert.equal(r.code, 0, r.err);
  const j = r.job;
  assert.equal(j.Label, 'io.github.tuannd9288.factory.claude-canary');
  assert.deepEqual(j.ProgramArguments, [join(factory, 'bin/claude-canary'), 'run', '--repo', 'o/app']);
  assert.equal(j.StartInterval, 21600);
  assert.equal(j.RunAtLoad, true);
  assert.ok(!('KeepAlive' in j));
  assert.equal(j.WorkingDirectory, factory);
  assert.equal(j.StandardOutPath, join(r.home, 'Library/Logs/factory/claude-canary.log'));
  assert.equal(j.StandardErrorPath, j.StandardOutPath);
  assert.ok(j.UserName, 'a LaunchDaemon names the account it runs as');
  assert.equal(j.EnvironmentVariables.HOME, r.home);
  assert.equal(j.EnvironmentVariables.CLAUDE_LAUNCHER, '/h/.local/bin/claude', 'the paths the canary reads from the environment are kept');
  assert.equal(j.EnvironmentVariables.FACTORY_STATE, '/h/state');
  assert.deepEqual(r.written, [], 'plist writes nothing');
});

test('plist needs exactly one --repo, and the queue\'s own job keeps its label, interval and log', () => {
  assert.notEqual(plistOf(['plist', '--daemon']).code, 0);
  assert.notEqual(plistOf(['plist', '--daemon', '--repo', 'o/a', '--repo', 'o/b']).code, 0);
  const q = plistOf(['plist', '--daemon', '--repo', 'o/app']);
  assert.equal(q.code, 0, q.err);
  const dir = mkdtempSync(join(tmpdir(), 'queue-plist-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const r = spawnSync(join(factory, 'bin/factory-queue'), ['plist', '--repo', 'o/app'], { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir } });
    assert.match(r.stdout, /<string>io\.github\.tuannd9288\.factory\.queue<\/string>/);
    assert.match(r.stdout, /<key>StartInterval<\/key>\n  <integer>60<\/integer>/);
    assert.ok(r.stdout.includes(`<string>${join(dir, 'Library/Logs/factory/queue.log')}</string>`));
    assert.doesNotMatch(r.stdout, /canary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
