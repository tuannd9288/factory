// #209: the weekly digest's launchd job, its window, and a post that never reaches a public repository. A fake gh; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, quiet } from './helpers.mjs';
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
    mkdirSync(join(dir, 'seed'));
    git(join(dir, 'seed'), 'init', '-q', '-b', 'main');
    commit(join(dir, 'seed'), { 'README.md': '# factory\n' }, 'start');
    git(dir, 'clone', '-q', '--bare', join(dir, 'seed'), join(dir, 'origin.git'));
    git(dir, 'clone', '-q', join(dir, 'origin.git'), join(dir, 'root'));
    git(dir, 'clone', '-q', join(dir, 'origin.git'), join(dir, 'other'));
    const env = { ...process.env, ...quiet, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, Q: dir, VIS: 'PRIVATE', FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'), FACTORY_PROFILE_DIRS: '' };
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

// #366: two nodes share only origin; each has its own checkout and state.
test('only one node posts a digest for a period, and the next period can run', () => {
  withMachine([], ({ dir, run, calls }) => {
    const args = ['--repo', 'o/app', '--post', 'o/better-factory', '--since', '2026-10-26', '--until', '2026-11-01'];
    const first = run(args);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const before = calls();
    const second = run(args, { FACTORY_ROOT: join(dir, 'other'), FACTORY_STATE: join(dir, 'other-state') });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /another node holds/);
    const after = calls().slice(before.length).split('\n').filter(Boolean);
    assert.deepEqual(after.filter((l) => !l.startsWith('repo view')), [], 'the losing node does no digest work beyond reading the target\'s visibility');
    const ref = 'refs/heads/claim/digest/2026-10-26_2026-11-01';
    const sha = git(join(dir, 'origin.git'), 'rev-parse', ref);
    assert.equal(git(join(dir, 'origin.git'), 'show', '-s', '--format=%P', sha), git(join(dir, 'origin.git'), 'rev-parse', 'main'));
    assert.equal(git(join(dir, 'origin.git'), 'rev-parse', `${sha}^{tree}`), git(join(dir, 'origin.git'), 'rev-parse', 'main^{tree}'));
    const next = run([...args.slice(0, 4), '--since', '2026-11-02', '--until', '2026-11-08'], { FACTORY_ROOT: join(dir, 'other') });
    assert.equal(next.status, 0, next.stdout + next.stderr);
    assert.equal((calls().match(/issue create/g) ?? []).length, 2);
    // Land the other node's claim after this node reads origin but before its push.
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(join(dir, 'gitbin'));
    writeFileSync(join(dir, 'race'), '');
    const racedArgs = [...args.slice(0, 4), '--since', '2026-11-09', '--until', '2026-11-15'];
    writeFileSync(join(dir, 'gitbin/git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, unlinkSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('push') && existsSync(${JSON.stringify(join(dir, 'race'))})) {
  unlinkSync(${JSON.stringify(join(dir, 'race'))});
  const other = spawnSync(${JSON.stringify(join(factory, 'bin/factory-ledger'))}, ${JSON.stringify(racedArgs)}, {
    env: { ...process.env, FACTORY_ROOT: ${JSON.stringify(join(dir, 'other'))}, FACTORY_STATE: ${JSON.stringify(join(dir, 'other-state'))} }, encoding: 'utf8'
  });
  if (other.status !== 0) { process.stderr.write(other.stderr); process.exit(1); }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    chmodSync(join(dir, 'gitbin/git'), 0o755);
    const raced = run(racedArgs, { PATH: `${join(dir, 'gitbin')}:${join(dir, 'bin')}:${process.env.PATH}` });
    assert.equal(raced.status, 0, raced.stdout + raced.stderr);
    assert.match(raced.stdout, /another node holds/);
    assert.equal((calls().match(/issue create/g) ?? []).length, 3, 'the refused push never posts a second digest');
  });
});
