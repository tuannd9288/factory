// #48: the merge queue's launchd job. bin/factory-queue plist prints it from this clone and the shell that runs it;
// bin/factory-queue check runs one sweep in the environment the job will have, against a fake gh. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { factory } from './helpers.mjs';

// The fake gh of queue-visible.test.mjs: who is logged in, and a repository with no pull request waiting.
const GH = (login) => `#!/bin/sh\ncase "$*" in\n  "api user"*) echo ${login} ;;\n  *graphql*) echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}' ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n`;

function withMachine(login, body) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-launchd-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), GH(login));
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const home = join(dir, 'home');
    mkdirSync(home);
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: home, FACTORY_STATE: join(dir, 'state') };
    const queue = (...args) => spawnSync(join(factory, 'bin/factory-queue'), args, { encoding: 'utf8', env });
    body({ dir, home, queue });
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
    assert.equal(job.Label, 'com.tuanhub.factory.queue');
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
