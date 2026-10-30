// bin/claude-canary (#24, #203 area 6b): Claude Code updates itself on the stable channel into <versions>/<version>; the
// launcher decides which one runs. The canary runs the newest version through bin/seat, behind a shim `claude` first on
// PATH, and moves the launcher only when the session passes the checks of probes/pack-contract.md. Everything here is
// offline: a temp versions folder of fake files, a temp launcher, a temp state folder, a clone with a local origin, and a
// fake bin/seat that writes the stream a session would (test/canary-world.mjs). The checks themselves: canary-checks.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, git } from './helpers.mjs';
import { FAKE_SEAT } from './canary-world.mjs';

const read = (path) => readFileSync(path, 'utf8');
const launcherText = (versions, v) => `#!/bin/sh\nexec '${join(versions, v)}' "$@"\n`;
const MARKER = 'Secrets live only in the environment named reviewer, never in the repository.';

/** A machine: versions (fake claude files), a launcher (an installer symlink to `current`, or a script of ours when
 * `script` is set), state, a clone of o/app with a local origin, and a fake bin/seat whose session the test chooses with
 * setSeat({ over, refuse, hang }). */
function withMachine({ versions: names, current, script = false, probed, rejected, over = {} }, body) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-'));
  try {
    const [versions, state, runs, root] = ['versions', 'state', 'runs', 'root'].map((n) => join(dir, n));
    const launcher = join(dir, 'bin', 'claude');
    for (const d of [versions, state, root, join(dir, 'bin')]) mkdirSync(d);
    for (const v of names) writeFileSync(join(versions, v), `claude ${v}\n`);
    if (current && script) writeFileSync(launcher, launcherText(versions, current));
    else if (current) symlinkSync(join(versions, current), launcher);
    if (probed) writeFileSync(join(state, 'claude-probed'), `${probed}\n`);
    if (rejected) writeFileSync(join(state, 'claude-rejected'), `${rejected}\n`);

    const seed = join(dir, 'seed');
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'AGENTS.md'), `${['# app', '', ...Array.from({ length: 24 }, (_, i) => (i === 12 ? MARKER : `| row ${i} |`)), '## end'].join('\n')}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'start');
    git(dir, 'clone', '-q', '--bare', seed, join(dir, 'origin.git'));
    const clone = join(root, 'app');
    git(dir, 'clone', '-q', join(dir, 'origin.git'), clone);

    const seat = join(dir, 'fake-seat.mjs');
    writeFileSync(seat, FAKE_SEAT);
    chmodSync(seat, 0o755);
    const config = join(dir, 'seat-config.json');
    const calls = join(dir, 'seat-calls');
    const setSeat = (c = {}) => writeFileSync(config, JSON.stringify({ calls, world: join(factory, 'test/canary-world.mjs'), over: {}, ...c }));
    setSeat({ over });
    const run = (args = ['--seat', seat], env = {}) => {
      const { FACTORY_NO_ALERTS, ...outer } = process.env;
      const r = spawnSync(join(factory, 'bin/claude-canary'), ['run', '--repo', 'o/app', ...args], {
        encoding: 'utf8',
        env: { ...outer, FACTORY_STATE: state, CLAUDE_VERSIONS: versions, CLAUDE_LAUNCHER: launcher, FACTORY_RUNS: runs, FACTORY_ROOT: root, FAKE_SEAT_CONFIG: config, ...env },
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const seatCalls = () => (existsSync(calls) ? read(calls).trim().split('\n').map((l) => JSON.parse(l)) : []);
    body({ dir, versions, state, runs, clone, launcher, run, setSeat, seatCalls });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const worktrees = (clone) => git(clone, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));

test('first run from the installer\'s symlink, the session passes: the launcher becomes our script, the version is recorded, older ones go', () => {
  withMachine({ versions: ['2.1.300', '2.1.309'], current: '2.1.309' }, ({ versions, state, launcher, run, seatCalls }) => {
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.equal(read(launcher), launcherText(versions, '2.1.309'));
    assert.ok(!lstatSync(launcher).isSymbolicLink());
    assert.equal(lstatSync(launcher).mode & 0o777, 0o755);
    assert.equal(read(join(state, 'claude-probed')), '2.1.309\n');
    assert.ok(!existsSync(join(state, 'claude-canary.failed')) && !existsSync(join(state, 'claude-rejected')));
    assert.deepEqual(readdirSync(versions), ['2.1.309'], 'versions older than the previous current are removed');
    assert.deepEqual(readdirSync(join(launcher, '..')), ['claude'], 'no temp file is left beside the launcher');
    assert.equal(seatCalls().length, 1);
  });
});

test('the candidate runs through bin/seat, as a worker, behind a shim written whole and first on PATH', () => {
  withMachine({ versions: ['2.1.309'], current: '2.1.309' }, ({ dir, versions, state, runs, run, seatCalls }) => {
    assert.equal(run().code, 0);
    const [call] = seatCalls();
    const runDir = join(runs, 'canary', '2.1.309');
    assert.deepEqual(call.args, ['worker', join(runDir, 'brief.md'), '--run', runDir, '--work', join(runDir, 'worktree'), '--tag', 'canary-2.1.309', '--max-turns', '12']);
    const shimDir = join(state, 'canary-bin');
    assert.equal(call.path.split(':')[0], shimDir, 'the shim comes before every other claude');
    assert.equal(call.shim, join(shimDir, 'claude'), 'claude resolves to the shim');
    assert.equal(read(join(shimDir, 'claude')), launcherText(versions, '2.1.309'), 'the shim runs the candidate, not the launcher');
    assert.equal(lstatSync(join(shimDir, 'claude')).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(shimDir), ['claude'], 'written by rename: no temp file is left');
    assert.equal(call.alerts, '1', 'FACTORY_NO_ALERTS=1');
    assert.ok(call.path.endsWith(process.env.PATH), 'the rest of PATH follows');
    assert.ok(existsSync(join(dir, 'versions')));
  });
});

test('the brief the seat runs is the repository\'s probes/canary-brief.md with the worktree and the marker\'s start put in', () => {
  withMachine({ versions: ['2.1.309'], current: '2.1.309' }, ({ runs, run, seatCalls }) => {
    assert.equal(run().code, 0);
    const [{ brief }] = seatCalls();
    const template = read(join(factory, 'probes/canary-brief.md'));
    assert.ok(!/\{\{/.test(brief), 'a placeholder is left');
    assert.ok(brief.includes(join(runs, 'canary', '2.1.309', 'worktree')));
    assert.ok(brief.includes(`begins with "${MARKER.slice(0, 20)}"`));
    assert.ok(template.includes('{{WORKTREE}}') && template.includes('{{MARKER_START}}'));
  });
});

test('one run for each version: its folder and a worktree at origin/main, removed with the verdict', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', over: { version: '2.1.10' } }, ({ clone, runs, run, seatCalls }) => {
    assert.equal(run().code, 0);
    assert.equal(seatCalls().length, 1);
    assert.deepEqual(readdirSync(join(runs, 'canary')), ['2.1.10']);
    assert.ok(existsSync(join(runs, 'canary/2.1.10/run-canary-2.1.10.jsonl')), 'the log stays');
    assert.equal(worktrees(clone).length, 1, 'the worktree is removed once the version is judged');
  });
});

test('a run that could not judge keeps its folder and worktree, and the retry reuses both and makes no second', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ clone, runs, run, setSeat, seatCalls }) => {
    setSeat({ refuse: true });
    assert.equal(run().code, 2);
    const wt = join(runs, 'canary/2.1.10/worktree');
    assert.equal(worktrees(clone).length, 2);
    writeFileSync(join(wt, 'keep.txt'), 'x\n');
    setSeat({ over: { version: '2.1.10' } });
    assert.equal(run().code, 0);
    const [first, second] = seatCalls();
    assert.equal(first.args[first.args.indexOf('--work') + 1], wt);
    assert.equal(second.args[second.args.indexOf('--work') + 1], wt);
    assert.equal(second.kept, true, 'the retry ran in the first worktree');
    assert.deepEqual(readdirSync(join(runs, 'canary')), ['2.1.10']);
  });
});

test('first run, a check fails: the symlink stays, the version is rejected, the failed checks are written', () => {
  withMachine({ versions: ['2.1.309'], current: '2.1.309', over: { env: 'approval' } }, ({ versions, state, launcher, run }) => {
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.ok(lstatSync(launcher).isSymbolicLink());
    assert.equal(readlinkSync(launcher), join(versions, '2.1.309'));
    assert.equal(read(join(state, 'claude-rejected')), '2.1.309\n');
    assert.ok(!existsSync(join(state, 'claude-probed')));
    const failed = read(join(state, 'claude-canary.failed')).trimEnd().split('\n');
    assert.match(failed[0], /^20\d\d-\d\d-\d\dT[\d:.]+Z claude 2\.1\.309 failed the canary run; the launcher stays on 2\.1\.309$/);
    assert.equal(failed.length, 2);
    assert.match(failed[1], /^FAIL a Read of \.env is refused by a deny rule/);
  });
});

test('a version other than the candidate fails first and alone, as when bin/seat stops resolving claude through PATH', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', over: { version: '2.1.9', mode: 'acceptEdits' } }, ({ versions, state, launcher, run }) => {
    const before = read(launcher);
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.equal(read(launcher), before);
    assert.equal(read(join(state, 'claude-rejected')), '2.1.10\n');
    const failed = read(join(state, 'claude-canary.failed')).trimEnd().split('\n');
    assert.match(failed[0], /Z claude 2\.1\.10 failed the canary run; the launcher stays on 2\.1\.9$/);
    assert.equal(failed.length, 2, 'the mode is not judged once the version is wrong');
    assert.match(failed[1], /^FAIL the init's claude_code_version is the candidate/);
    assert.deepEqual(readdirSync(versions).sort(), ['2.1.10', '2.1.9'], 'nothing is pruned on a failure');
  });
});

test('a rejected version is not run again, but a newer one is', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9', over: { mode: 'acceptEdits', version: '2.1.10' } }, ({ versions, state, run, setSeat, seatCalls }) => {
    assert.equal(run().code, 1);
    assert.equal(seatCalls().length, 1);
    const again = run();
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /nothing to do/i);
    assert.equal(seatCalls().length, 1, 'the rejected version was run again');
    assert.ok(existsSync(join(state, 'claude-canary.failed')), 'the failure stays until a run passes');
    writeFileSync(join(versions, '2.1.11'), 'claude\n');
    setSeat({ over: { version: '2.1.11' } });
    assert.equal(run().code, 0);
    assert.equal(seatCalls().length, 2);
    assert.equal(read(join(state, 'claude-probed')), '2.1.11\n');
    assert.ok(!existsSync(join(state, 'claude-canary.failed')));
  });
});

test('a version newer than the candidate is kept when it is rejected-skipped, not pruned', () => {
  withMachine({ versions: ['2.1.5', '2.1.9', '2.1.10', '2.1.11'], current: '2.1.9', script: true, probed: '2.1.9', rejected: '2.1.11', over: { version: '2.1.10' } }, ({ versions, state, launcher, run }) => {
    assert.equal(run().code, 0);
    assert.equal(read(launcher), launcherText(versions, '2.1.10'), 'the rejected 2.1.11 is skipped');
    assert.deepEqual(readdirSync(versions).sort(), ['2.1.10', '2.1.11', '2.1.9'], 'anything newer is kept');
    assert.ok(!existsSync(join(state, 'claude-rejected')));
  });
});

test('a run that could not judge exits 2, says why and rejects nothing: no seat free, a rate limit, a session that never started', () => {
  const cases = [
    [{ refuse: true }, /no seat free/],
    [{ over: { rate: 'rejected', subtype: 'error_during_execution', structured: null } }, /rate limit/],
    [{ over: { init: false } }, /did not start/],
  ];
  for (const [seat, why] of cases) {
    withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ state, launcher, run, setSeat }) => {
      setSeat(seat);
      const before = read(launcher);
      const r = run();
      assert.equal(r.code, 2, r.out);
      assert.equal(read(launcher), before);
      assert.ok(!existsSync(join(state, 'claude-rejected')));
      assert.match(read(join(state, 'claude-canary.failed')), why);
      assert.match(read(join(state, 'claude-canary.failed')), /claude 2\.1\.10/);
    });
  }
});

test('a run that outlasts its time is sent SIGTERM at the pid in run-<tag>.pid and exits 2, rejecting nothing', async () => {
  const sleeping = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let pid;
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ state, runs, run, setSeat }) => {
    setSeat({ hang: true });
    const r = run(undefined, { CLAUDE_CANARY_WAIT_MS: '1500' });
    assert.equal(r.code, 2, r.out);
    assert.ok(!existsSync(join(state, 'claude-rejected')));
    assert.match(read(join(state, 'claude-canary.failed')), /claude 2\.1\.10: .*did not end/);
    pid = Number(read(join(runs, 'canary/2.1.10/run-canary-2.1.10.pid')));
  });
  for (let i = 0; i < 50 && sleeping(pid); i += 1) await new Promise((res) => setTimeout(res, 100));
  assert.equal(sleeping(pid), false, 'the session was not sent SIGTERM');
});

test('a seat that does not run, or a clone with no origin/main, exits 2 and rejects nothing', () => {
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ state, run, seatCalls }) => {
    const r = run(['--seat', '/no/such/seat']);
    assert.equal(r.code, 2, r.out);
    assert.match(read(join(state, 'claude-canary.failed')), /claude 2\.1\.10: .*could not run/);
    assert.ok(!existsSync(join(state, 'claude-rejected')));
    assert.equal(seatCalls().length, 0);
  });
  withMachine({ versions: ['2.1.9', '2.1.10'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ dir, state, run, seatCalls }) => {
    rmSync(join(dir, 'root/app'), { recursive: true, force: true });
    assert.equal(run().code, 2);
    assert.match(read(join(state, 'claude-canary.failed')), /claude 2\.1\.10: .*worktree/);
    assert.equal(seatCalls().length, 0);
  });
});

test('nothing new: the candidate is the current version and already probed, so nothing runs and it exits 0', () => {
  withMachine({ versions: ['2.1.9'], current: '2.1.9', script: true, probed: '2.1.9' }, ({ state, run, seatCalls }) => {
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing to do/i);
    assert.equal(seatCalls().length, 0);
    assert.ok(!existsSync(join(state, 'claude-canary.failed')));
  });
});

test('a launcher that is neither our script nor the installer\'s symlink is an error written to the failed file; no run starts', () => {
  withMachine({ versions: ['2.1.9'] }, ({ dir, state, launcher, run, seatCalls }) => {
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
    assert.equal(seatCalls().length, 0);
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
