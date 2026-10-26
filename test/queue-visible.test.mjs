// #26: a queue failure before the repository loop, the digest's queue section, and a digest posted once per period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from '../bin/lib/ledger.mjs';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');

function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'visible-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a queue run that fails before its repository loop leaves queue-run.failed with the time and the cause', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\ncase "$*" in\n  "api user"*) echo "${Q_LOGIN:-agent-bot}" ;;\n  *) exit 1 ;;\nesac\n');
    chmodSync(join(dir, 'gh'), 0o755);
    const state = join(dir, 'state');
    const sweep = (env = {}) => spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FACTORY_STATE: state, ...env } });
    const report = join(state, 'queue-run.failed');
    let out = sweep({ Q_LOGIN: 'tuannd9288' });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(readFileSync(report, 'utf8'), /^20\d\d-\d\d-\d\dT.* runs as the agents' account, not the Human's \(tuannd9288\)/);
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho "gh: not logged in" >&2\nexit 1\n');
    out = sweep();
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(readFileSync(report, 'utf8'), /^20\d\d-.*not logged in/);
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\ncase "$*" in\n  "api user"*) echo agent-bot ;;\n  *graphql*) echo \'{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\' ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n');
    out = sweep();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.ok(!existsSync(report), 'a run that got to its loop clears it');
    assert.match(readFileSync(join(state, 'queue-o-app.ok'), 'utf8'), /^20\d\d-\d\d-\d\dT/);
  });
});

test('the digest lists every .failed file with its time and cause, and each repository\'s last good sweep', () => {
  withDir((state) => {
    writeFileSync(join(state, 'queue-run.failed'), '2026-10-24T01:00:00.000Z gh: not logged in\n');
    writeFileSync(join(state, 'queue-o-app.failed'), '2026-10-24T02:00:00.000Z o/app: HTTP 502\n');
    writeFileSync(join(state, 'queue-o-app.ok'), '2026-10-23T23:00:00.000Z\n');
    const q = ledger.queueState(state, ['o/app', 'o/new']);
    const text = ledger.digest([], { since: '2026-10-17', until: '2026-10-24', queue: q });
    assert.match(text, /queue-run\.failed: 2026-10-24T01:00:00\.000Z gh: not logged in/);
    assert.match(text, /queue-o-app\.failed: 2026-10-24T02:00:00\.000Z o\/app: HTTP 502/);
    assert.match(text, /queue-o-app\.ok: 2026-10-23T23:00:00\.000Z/);
    assert.match(text, /o\/new: no clean sweep recorded/);
    const clean = ledger.digest([], { since: 'a', until: 'b', queue: ledger.queueState(join(state, 'none'), ['o/new']) });
    assert.match(clean, /Cannot check the queue.*none/);
    assert.doesNotMatch(clean, /No \.failed files/);
    mkdirSync(join(state, 'empty'));
    assert.match(ledger.digest([], { since: 'a', until: 'b', queue: ledger.queueState(join(state, 'empty'), []) }), /No \.failed files/);
  });
});

/** A gh that answers factory-ledger's calls for an empty period and logs every call; `issue list` prints list.json. */
function ledgerRun(dir, list) {
  writeFileSync(
    join(dir, 'gh'),
    '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "api --paginate"*) echo "[[]]" ;;\n  "api repos/o/app/actions/secrets") echo \'{"secrets":[]}\' ;;\n  "issue list"*) cat "$Q/list.json" ;;\n  "issue create"*) echo https://github.com/o/factory/issues/99 ;;\n  "issue edit"*) echo https://github.com/o/factory/issues/7 ;;\n  "label create"*) ;;\n  *) exit 1 ;;\nesac\n',
  );
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'list.json'), JSON.stringify(list));
  writeFileSync(join(dir, 'calls'), '');
  mkdirSync(join(dir, 'root'), { recursive: true });
  const out = spawnSync(join(factory, 'bin/factory-ledger'), ['--repo', 'o/app', '--since', '2026-10-17', '--until', '2026-10-24', '--post', 'o/factory'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: join(dir, 'state'), FACTORY_RUNS: join(dir, 'runs'), FACTORY_PROFILE_DIRS: '' },
  });
  return { out, calls: readFileSync(join(dir, 'calls'), 'utf8') };
}

const TITLE = 'Weekly digest 2026-10-17 → 2026-10-24';
// The title the digests posted before #98 carry (#1).
const OLD_TITLE = (since, until) => `Bản tin xưởng ${since} → ${until}`;

test('--post creates the digest when no issue has its title, ignoring fuzzy near matches', () => {
  withDir((dir) => {
    const { out, calls } = ledgerRun(dir, [{ number: 3, title: 'Weekly digest 2026-10-10 → 2026-10-17' }, { number: 4, title: `${TITLE} (copy)` }]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(calls, /issue create/);
    assert.doesNotMatch(calls, /issue edit/);
  });
});

test('a second --post for one period updates the issue it finds, open or closed, by the exact title', () => {
  withDir((dir) => {
    const { out, calls } = ledgerRun(dir, [{ number: 3, title: 'Weekly digest 2026-10-10 → 2026-10-17', state: 'OPEN' }, { number: 7, title: TITLE, state: 'CLOSED' }]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(calls, /issue list .*--state all/);
    assert.match(calls, /issue edit 7 --repo o\/factory --add-label digest --body-file \S+/);
    assert.doesNotMatch(calls, /issue create/);
    assert.match(out.stdout, /issues\/7/);
  });
});

test('a digest posted under the old title for the same period is found and updated, not posted twice', () => {
  withDir((dir) => {
    const { out, calls } = ledgerRun(dir, [{ number: 3, title: OLD_TITLE('2026-10-10', '2026-10-17') }, { number: 5, title: OLD_TITLE('2026-10-17', '2026-10-24'), state: 'CLOSED' }]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(calls, /issue edit 5 --repo o\/factory --add-label digest --body-file \S+/);
    assert.doesNotMatch(calls, /issue create/);
  });
});

test('an old-title digest of another period does not stop a new one being created', () => {
  withDir((dir) => {
    const { out, calls } = ledgerRun(dir, [{ number: 3, title: OLD_TITLE('2026-10-10', '2026-10-17') }]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(calls, /issue create .*--title Weekly digest 2026-10-17 → 2026-10-24/);
  });
});

test('one issue under the old title and one under the new, for one period: update none, name both', () => {
  withDir((dir) => {
    const { out, calls } = ledgerRun(dir, [{ number: 5, title: OLD_TITLE('2026-10-17', '2026-10-24') }, { number: 7, title: TITLE }]);
    assert.notEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stderr, /#5.*#7/);
    assert.doesNotMatch(calls, /issue (edit|create)/);
  });
});

test('two issues with the digest\'s title: update none, exit non-zero, name both', () => {
  withDir((dir) => {
    const { out, calls } = ledgerRun(dir, [{ number: 7, title: TITLE }, { number: 9, title: TITLE }]);
    assert.notEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stderr, /#7.*#9/);
    assert.doesNotMatch(calls, /issue (edit|create)/);
  });
});
