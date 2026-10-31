// #209: the weekly digest's launchd job, its window, and a post that never reaches a public repository. A fake gh; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import * as ledger from '../bin/lib/ledger.mjs';

const FAKE_GH = '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "repo view"*) echo "{\\"visibility\\":\\"$VIS\\"}" ;;\n  "api --paginate"*) echo "[[]]" ;;\n  "api repos/o/app/actions/secrets") echo \'{"secrets":[]}\' ;;\n  "issue list"*) cat "$Q/list.json" ;;\n  "issue create"*) echo https://github.com/o/better-factory/issues/99 ;;\n  "issue edit"*) echo https://github.com/o/better-factory/issues/7 ;;\n  "label create"*) ;;\n  *) exit 1 ;;\nesac\n';

function withMachine(list, body) {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), FAKE_GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    writeFileSync(join(dir, 'list.json'), JSON.stringify(list));
    writeFileSync(join(dir, 'calls'), '');
    mkdirSync(join(dir, 'root'));
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, Q: dir, VIS: 'PRIVATE', FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'), FACTORY_PROFILE_DIRS: '' };
    const run = (args, more = {}) => spawnSync(join(factory, 'bin/factory-ledger'), args, { encoding: 'utf8', env: { ...env, ...more } });
    body({ dir, run, calls: () => readFileSync(join(dir, 'calls'), 'utf8') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The plist as launchd reads it, through Python's plistlib. */
function parse(text, dir) {
  writeFileSync(join(dir, 'job.plist'), text);
  const r = spawnSync('python3', ['-I', '-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', join(dir, 'job.plist')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('plist --daemon prints a weekly LaunchDaemon, run by the printing account, that posts last week to better-factory', () => {
  withMachine([], ({ dir, run }) => {
    const r = run(['plist', '--daemon', '--repo', 'tuannd9288/factory', '--repo', 'o/lib']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const job = parse(r.stdout, dir);
    assert.equal(job.Label, 'io.github.tuannd9288.factory.digest');
    assert.equal(job.UserName, userInfo().username);
    assert.deepEqual(job.StartCalendarInterval, { Weekday: 1, Hour: 9, Minute: 0 });
    assert.equal(job.StartInterval, undefined);
    assert.deepEqual(job.ProgramArguments, [join(factory, 'bin/factory-ledger'), '--post', 'tuannd9288/better-factory', '--last-week', '--repo', 'tuannd9288/factory', '--repo', 'o/lib']);
    assert.equal(job.WorkingDirectory, factory);
    assert.equal(job.StandardOutPath, join(dir, 'Library/Logs/factory/digest.log'));
    assert.equal(job.EnvironmentVariables.HOME, dir);
  });
});

test('--post refuses a repository that is not private, and posts nothing', () => {
  for (const vis of ['PUBLIC', 'INTERNAL']) {
    withMachine([], ({ run, calls }) => {
      const r = run(['--repo', 'o/app', '--since', '2026-10-17', '--until', '2026-10-24', '--post', 'o/factory'], { VIS: vis });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`o/factory.*${vis}`));
      assert.match(calls(), /repo view o\/factory --json visibility/);
      assert.doesNotMatch(calls(), /issue (create|edit)|label create/);
    });
  }
});

test('--last-week is the seven days that end the day before the run', () => {
  assert.deepEqual(ledger.lastWeek(new Date(2026, 10, 2, 9, 0)), { since: '2026-10-26', until: '2026-11-01' });
  assert.deepEqual(ledger.lastWeek(new Date(2026, 0, 5, 9, 0)), { since: '2025-12-29', until: '2026-01-04' });
});

test('--last-week takes no --since or --until', () => {
  withMachine([], ({ run }) => {
    const r = run(['--last-week', '--repo', 'o/app', '--since', '2026-10-17']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--last-week/);
  });
});

test('a run for last week edits the digest already filed for it, and files one when there is none', () => {
  const { since, until } = ledger.lastWeek(new Date());
  const title = `Weekly digest ${since} → ${until}`;
  withMachine([{ number: 7, title }], ({ run, calls }) => {
    const r = run(['--last-week', '--repo', 'o/app', '--post', 'o/better-factory']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(calls(), /issue edit 7 --repo o\/better-factory /);
    assert.doesNotMatch(calls(), /issue create/);
  });
  withMachine([], ({ run, calls }) => {
    const r = run(['--last-week', '--repo', 'o/app', '--post', 'o/better-factory']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(calls().includes(`--title ${title} `), calls());
  });
});
