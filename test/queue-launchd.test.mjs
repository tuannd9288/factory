// #48: the merge queue's launchd job. bin/factory-queue plist prints it from this clone and the shell that runs it;
// bin/factory-queue check runs one sweep in the environment the job will have, against a fake gh. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOST_ENV, factory } from './helpers.mjs';

// The fake gh of queue-visible.test.mjs: who is logged in, and a repository with no pull request waiting.
const GH = (login) => `#!/bin/sh\ncase "$*" in\n  "api user"*) echo ${login} ;;\n  *graphql*) echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}' ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n`;

function withMachine(login, body, over = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-launchd-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), typeof login === 'function' ? login(dir) : GH(login));
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const home = join(dir, 'home');
    mkdirSync(home);
    // The factory host's job, unless `over` says otherwise (#366: off it, the sweep needs the node's own agents token).
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: home, FACTORY_STATE: join(dir, 'state'), ...HOST_ENV, ...over(dir) };
    const queue = (...args) => spawnSync(join(factory, 'bin/factory-queue'), args, { encoding: 'utf8', env });
    body({ dir, home, queue, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The plist as launchd reads it, through Python's plistlib, which ships with python3 on macOS and on Linux. */
function parse(text, dir) {
  writeFileSync(join(dir, 'job.plist'), text);
  const r = spawnSync('python3', ['-I', '-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', join(dir, 'job.plist')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('plist prints a launchd job that sweeps the named repositories every minute from this clone, and writes nothing', () => {
  withMachine('agent-bot', ({ dir, home, queue }) => {
    const r = queue('plist', '--repo', 'o/app', '--repo', 'o/lib');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const job = parse(r.stdout, dir);
    assert.equal(job.Label, 'io.github.tuannd9288.factory.queue');
    assert.deepEqual(job.ProgramArguments, [join(factory, 'bin/factory-queue'), 'sweep', '--repo', 'o/app', '--repo', 'o/lib']);
    assert.ok(existsSync(job.ProgramArguments[0]));
    assert.equal(job.WorkingDirectory, factory);
    assert.equal(job.StartInterval, 60);
    assert.equal(job.RunAtLoad, true);
    assert.equal(job.StandardOutPath, join(home, 'Library/Logs/factory/queue.log'));
    assert.equal(job.StandardErrorPath, job.StandardOutPath);
    const path = job.EnvironmentVariables.PATH.split(':');
    assert.equal(path[0], join(dir, 'bin'), 'the gh the shell found comes first');
    assert.ok(path.includes(dirname(process.execPath)), 'the node the shell runs is on it');
    assert.equal(job.EnvironmentVariables.FACTORY_STATE, join(dir, 'state'), 'a state folder the shell names is kept');
    assert.deepEqual(readdirSync(home), [], 'plist made a folder');
    assert.ok(!existsSync(join(dir, 'state')), 'plist wrote state');
  });
});

test('check runs one sweep in the job\'s environment and says the job is ready when gh is the agents\' account', () => {
  withMachine('agent-bot', ({ dir, home, queue }) => {
    const r = queue('check', '--repo', 'o/app');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: gh login agent-bot$/m);
    assert.match(r.stdout, new RegExp(`^check: node v\\d+\\.\\d+\\.\\d+$`, 'm'));
    assert.match(r.stdout, new RegExp(`^check: state folder ${join(dir, 'state')}$`, 'm'));
    assert.match(r.stdout, new RegExp(`^check: log ${join(home, 'Library/Logs/factory/queue.log')}$`, 'm'));
    assert.match(r.stdout, /^check: one sweep exited 0$/m);
    assert.match(r.stdout, /^check: ready; the Human loads the job$/m);
    assert.match(readFileSync(join(dir, 'state/queue-o-app.ok'), 'utf8'), /^20\d\d-/);
    assert.ok(existsSync(join(home, 'Library/Logs/factory')), 'launchd does not make the log folder, so check does');
  });
});

test('check says the job is not ready when gh is the Human\'s login, and why', () => {
  withMachine('tuannd9288', ({ queue }) => {
    const r = queue('check', '--repo', 'o/app');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: gh login tuannd9288$/m);
    assert.match(r.stdout, /^check: one sweep exited 2$/m);
    assert.match(r.stdout, /^check: not ready: gh is the Human's login; the job must run as the agents' account$/m);
  });
});

// Found by #49's review. A plist or check that fails writes no queue state; a --repo needs its value; the job finds the
// node the shell finds; and check is ready only on a sweep it saw run.
import { realpathSync, symlinkSync } from 'node:fs';

const GH_FAILS = (stderr, graphql = 'echo \'{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\'') =>
  `#!/bin/sh\ncase "$*" in\n  "api user"*) ${stderr ? `echo "${stderr}" >&2; exit 1` : 'echo agent-bot'} ;;\n  *graphql*) ${graphql} ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n`;

test('plist with no gh on PATH says so and writes no queue state', () => {
  withMachine('agent-bot', ({ dir }) => {
    // Only what bin/factory-queue itself needs: bash for its shebang, dirname, and node.
    mkdirSync(join(dir, 'tools'));
    for (const [name, target] of [['bash', '/bin/bash'], ['dirname', '/usr/bin/dirname'], ['node', process.execPath]]) symlinkSync(target, join(dir, 'tools', name));
    const env = { ...process.env, PATH: join(dir, 'tools'), HOME: join(dir, 'home'), FACTORY_STATE: join(dir, 'state') };
    const r = spawnSync(join(factory, 'bin/factory-queue'), ['plist', '--repo', 'o/app'], { encoding: 'utf8', env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /gh is not on PATH/);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(join(dir, 'state')), 'a failed plist wrote queue-run.failed');
  });
});

test('a --repo with no owner/name after it is refused, and no job is printed', () => {
  withMachine('agent-bot', ({ queue }) => {
    for (const args of [['plist', '--repo'], ['plist', '--repo', 'o/app', '--repo'], ['check', '--repo', 'app']]) {
      const r = queue(...args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--repo needs owner\/name/);
      assert.equal(r.stdout, '');
    }
  });
});

test('the job finds the node this shell finds, and plist refuses when the gh folder holds another node', () => {
  withMachine('agent-bot', ({ dir, queue }) => {
    const first = (path, name) => path.split(':').find((d) => existsSync(join(d, name)));
    const shellNode = first(process.env.PATH, 'node');
    let r = queue('plist', '--repo', 'o/app');
    assert.equal(r.status, 0, r.stderr);
    const path = parse(r.stdout, dir).EnvironmentVariables.PATH;
    assert.equal(realpathSync(join(first(path, 'node'), 'node')), realpathSync(join(shellNode, 'node')));
    assert.equal(first(path, 'gh'), join(dir, 'bin'));
    // The shell finds this node first and the gh after it, in a folder that also holds another node.
    mkdirSync(join(dir, 'node-only'));
    symlinkSync(process.execPath, join(dir, 'node-only/node'));
    mkdirSync(join(dir, 'gh-and-node'));
    writeFileSync(join(dir, 'gh-and-node/gh'), GH('agent-bot'));
    writeFileSync(join(dir, 'gh-and-node/node'), '#!/bin/sh\necho v0.0.0\n');
    for (const name of ['gh', 'node']) chmodSync(join(dir, 'gh-and-node', name), 0o755);
    const env = { ...process.env, PATH: `${join(dir, 'node-only')}:${join(dir, 'gh-and-node')}:/usr/bin:/bin`, HOME: join(dir, 'home'), FACTORY_STATE: join(dir, 'state') };
    r = spawnSync(join(factory, 'bin/factory-queue'), ['plist', '--repo', 'o/app'], { encoding: 'utf8', env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /holds another node/);
  });
});

test('check is not ready when gh is not logged in, or when the sweep fails', () => {
  withMachine('agent-bot', ({ dir, queue }) => {
    writeFileSync(join(dir, 'bin/gh'), GH_FAILS('gh: not logged in'));
    let r = queue('check', '--repo', 'o/app');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: gh login none: gh: not logged in$/m);
    assert.match(r.stdout, /^check: not ready: gh is not logged in$/m);
    writeFileSync(join(dir, 'bin/gh'), GH_FAILS('', 'echo "graphql down" >&2; exit 1'));
    r = queue('check', '--repo', 'o/app');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: one sweep exited 1$/m);
    assert.match(r.stdout, /^check: not ready: the sweep failed$/m);
  });
});

test('check is not ready while another sweep holds the lock, for its own sweep did nothing', async () => {
  const { takeLock } = await import('../bin/lib/lock.mjs');
  withMachine('agent-bot', ({ dir, queue }) => {
    mkdirSync(join(dir, 'state'));
    const held = takeLock(join(dir, 'state/queue.lock'));
    try {
      const r = queue('check', '--repo', 'o/app');
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /^check: not ready: another sweep holds the lock, so this one did nothing; run check again once it ends$/m);
    } finally {
      held.release();
    }
  });
});

// #24: the job as a LaunchDaemon in /Library/LaunchDaemons, run as the agents' own macOS account. A sweep exits after
// each run, so the job starts every minute and is never kept alive, which would restart it at once, in a loop.
import { userInfo } from 'node:os';

test('plist --daemon prints the job as the account that printed it, with its HOME, every minute, never kept alive', () => {
  withMachine('agent-bot', ({ dir, home, queue }) => {
    const r = queue('plist', '--daemon', '--repo', 'o/app');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const job = parse(r.stdout, dir);
    assert.equal(job.UserName, userInfo().username);
    assert.equal(job.EnvironmentVariables.HOME, home);
    assert.deepEqual(job.ProgramArguments, [join(factory, 'bin/factory-queue'), 'sweep', '--repo', 'o/app']);
    assert.equal(job.StartInterval, 60);
    assert.equal(job.RunAtLoad, true);
    assert.equal(job.KeepAlive, undefined);
    assert.equal(job.StandardOutPath, join(home, 'Library/Logs/factory/queue.log'));
    assert.deepEqual(readdirSync(home), [], 'plist made a folder');
  });
});

// #366: the job off the factory host, on a node whose gh is the login of the person whose machine it is. The fake gh answers as the agents only
// with their token in GH_TOKEN, and as that person otherwise.
const NODE_GH = `#!/bin/sh\ncase "$*" in\n  "api user"*) if [ "$GH_TOKEN" = made-up-agents-token ]; then echo agent-bot; else echo tuannd9288; fi ;;\n  *graphql*) echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}' ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n`;
const offHost = (dir) => ({ FACTORY_HOST_USER: 'nobody-here', AGENT_PROFILES: join(dir, 'profiles'), FACTORY_AGENT: 'fake-agent', XDG_DATA_HOME: join(dir, 'xdg'), FACTORY_CHECKOUT: '' });
const storeToken = (dir) => {
  mkdirSync(join(dir, 'profiles/tokens'), { recursive: true });
  writeFileSync(join(dir, 'profiles/tokens/fake-agent'), 'made-up-agents-token\n');
};

test('off the factory host the job follows the node\'s installed copy and holds no token; check runs its sweep as the agents, or is not ready without their token (#366)', () => {
  withMachine(() => NODE_GH, ({ dir, queue }) => {
    let r = queue('check', '--repo', 'o/app');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: not ready: this node holds no GitHub token for the agents/m);
    assert.doesNotMatch(r.stdout, /one sweep exited/, 'no sweep runs without the token');
    storeToken(dir);
    const printed = queue('plist', '--repo', 'o/app');
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(parse(printed.stdout, dir).EnvironmentVariables.FACTORY_CHECKOUT, join(dir, 'xdg/factory/checkout'));
    assert.ok(!printed.stdout.includes('made-up-agents-token'), 'the job holds no token');
    r = queue('check', '--repo', 'o/app');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^check: gh login agent-bot$/m);
    assert.match(r.stdout, /^check: one sweep exited 0$/m);
    assert.ok(!r.stdout.includes('made-up-agents-token'), 'nor does what check prints');
  }, offHost);
  withMachine('agent-bot', ({ dir, queue }) => {
    assert.equal(parse(queue('plist', '--repo', 'o/app').stdout, dir).EnvironmentVariables.FACTORY_CHECKOUT, undefined, 'on the host the job is as it was');
  });
});

test('plist without --daemon has no UserName, and --daemon belongs to plist alone', () => {
  withMachine('agent-bot', ({ dir, queue }) => {
    const r = queue('plist', '--repo', 'o/app');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parse(r.stdout, dir).UserName, undefined);
    for (const command of ['sweep', 'check']) {
      const s = queue(command, '--daemon', '--repo', 'o/app');
      assert.equal(s.status, 2, `${command}: ${s.stdout}${s.stderr}`);
      assert.match(s.stderr, /--daemon is for plist alone/);
    }
  });
});
