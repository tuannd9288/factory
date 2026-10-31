// #209, round 2: a failed weekly --post leaves $FACTORY_STATE/digest.failed, which bin/lib/alerts.mjs tells the Human;
// a successful post clears it, as a clean queue sweep clears its own. A fake gh; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { lines } from '../bin/lib/alerts.mjs';

const FAKE_GH = '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "repo view"*) echo "{\\"visibility\\":\\"$VIS\\"}" ;;\n  "api --paginate"*) echo "[[]]" ;;\n  "api repos/o/app/actions/secrets") echo \'{"secrets":[]}\' ;;\n  "issue list"*) echo "[]" ;;\n  "issue create"*) [ -n "$FAIL_CREATE" ] && { echo "HTTP 502" >&2; exit 1; }; echo https://github.com/o/better-factory/issues/99 ;;\n  "label create"*) ;;\n  *) exit 1 ;;\nesac\n';

function withMachine(body) {
  const dir = mkdtempSync(join(tmpdir(), 'failed-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'calls'), '');
    mkdirSync(join(dir, 'root'));
    const state = join(dir, 'state');
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, Q: dir, VIS: 'PRIVATE', FAIL_CREATE: '', FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: state, FACTORY_RUNS: join(dir, 'runs'), FACTORY_PROFILE_DIRS: '' };
    const run = (args, more = {}) => spawnSync(join(factory, 'bin/factory-ledger'), ['--repo', 'o/app', '--since', '2026-10-17', '--until', '2026-10-24', ...args], { encoding: 'utf8', env: { ...env, ...more } });
    body({ run, report: join(state, 'digest.failed'), state });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a refused post to a public repository leaves digest.failed with the time and the cause, and alerts lists it', () => {
  withMachine(({ run, report, state }) => {
    const r = run(['--post', 'o/factory'], { VIS: 'PUBLIC' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(readFileSync(report, 'utf8'), /^20\d\d-\d\d-\d\dT\S+ .*o\/factory is PUBLIC/);
    assert.equal(readFileSync(report, 'utf8').trim().split('\n').length, 1);
    const { lines: told } = lines(state);
    assert.equal(told.length, 1);
    assert.match(told[0], /^factory: digest\.failed \(.*\): 20\d\d-.*PUBLIC/);
  });
});

test('a failing gh issue create leaves digest.failed, and a later successful post clears it', () => {
  withMachine(({ run, report }) => {
    const bad = run(['--post', 'o/better-factory'], { FAIL_CREATE: '1' });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(readFileSync(report, 'utf8'), /^20\d\d-\d\d-\d\dT\S+ .*HTTP 502/);
    const good = run(['--post', 'o/better-factory']);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.ok(!existsSync(report), 'a post that went through clears it');
  });
});

test('a run without --post writes no digest.failed, whether it works or fails', () => {
  withMachine(({ run, report, state }) => {
    assert.equal(run([]).status, 0);
    assert.equal(run(['--bogus']).status, 1);
    assert.ok(!existsSync(report));
    assert.ok(!existsSync(state), 'nor the state folder');
  });
});
