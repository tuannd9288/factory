// #26, fixes 1 for PR #32: an exact-title lookup that does not go through GitHub's search index, every pre-loop
// failure in queue-run.failed, a digest that does not read a missing state folder as zero, and the CLI wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from '../bin/lib/ledger.mjs';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'Weekly digest 2026-10-17 → 2026-10-24';

function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'fixes-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A gh for an empty period. `issue list` answers like GitHub: through --search or --label it reads the search
 * index, which here has not caught up and returns nothing; without them it returns list.json. */
function fakeGh(dir, list) {
  writeFileSync(
    join(dir, 'gh'),
    '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "api --paginate"*) echo "[[]]" ;;\n  "api repos/o/app/actions/secrets") echo \'{"secrets":[]}\' ;;\n  "issue list"*--search*|"issue list"*--label*) echo "[]" ;;\n  "issue list"*) cat "$Q/list.json" ;;\n  "issue create"*) echo https://github.com/o/factory/issues/99 ;;\n  "issue edit"*) echo https://github.com/o/factory/issues/7 ;;\n  "label create"*) ;;\n  *) exit 1 ;;\nesac\n',
  );
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'list.json'), JSON.stringify(list));
  writeFileSync(join(dir, 'calls'), '');
  mkdirSync(join(dir, 'root'), { recursive: true });
}

const ledgerCli = (dir, args, env = {}) =>
  spawnSync(join(factory, 'bin/factory-ledger'), ['--repo', 'o/app', '--since', '2026-10-17', '--until', '2026-10-24', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, Q: dir, FACTORY_ROOT: join(dir, 'root'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_STATE: join(dir, 'state'), FACTORY_PROFILE_DIRS: '', ...env },
  });

test('--post finds the issue by listing, never through the search index, which lags behind a new issue', () => {
  withDir((dir) => {
    fakeGh(dir, [{ number: 7, title: TITLE }]);
    const out = ledgerCli(dir, ['--post', 'o/factory']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    const list = calls.split('\n').find((l) => l.startsWith('issue list'));
    assert.doesNotMatch(list, /--search|--label/);
    assert.match(list, /--state all .*--limit 1000 .*--json number,title/);
    assert.match(calls, /issue edit 7 /);
    assert.doesNotMatch(calls, /issue create/);
  });
});

test('--post fails closed when the list may be truncated at 1000 issues', () => {
  withDir((dir) => {
    fakeGh(dir, Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, title: `other ${i}` })));
    const out = ledgerCli(dir, ['--post', 'o/factory']);
    assert.notEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stderr, /1000/);
    assert.doesNotMatch(readFileSync(join(dir, 'calls'), 'utf8'), /issue (edit|create)/);
  });
});

test('the edit path puts the digest label back, and leaves a closed issue closed', () => {
  withDir((dir) => {
    fakeGh(dir, [{ number: 7, title: TITLE, state: 'CLOSED' }]);
    const out = ledgerCli(dir, ['--post', 'o/factory']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    assert.match(calls, /issue edit 7 .*--add-label digest/);
    assert.doesNotMatch(calls, /reopen/);
  });
});

test('every failure before the repository loop leaves queue-run.failed, even a launchd plist typo, and makes the folder', () => {
  withDir((dir) => {
    const state = join(dir, 'not', 'yet', 'state');
    const out = spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repos', 'o/app'], { encoding: 'utf8', env: { ...process.env, FACTORY_STATE: state } });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(readFileSync(join(state, 'queue-run.failed'), 'utf8'), /^20\d\d-\d\d-\d\dT\S+ unknown argument --repos/);
    assert.match(out.stderr, /unknown argument --repos/);
  });
});

test('a failure with no way to write the report still reports on stderr', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'file'), 'in the way');
    const out = spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repos', 'o/app'], { encoding: 'utf8', env: { ...process.env, FACTORY_STATE: join(dir, 'file', 'state') } });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stderr, /unknown argument --repos/);
  });
});

test('the CLI passes the queue state into the digest it prints', () => {
  withDir((dir) => {
    fakeGh(dir, []);
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state', 'queue-run.failed'), '2026-10-24T01:00:00.000Z gh: not logged in\n');
    const out = ledgerCli(dir, ['--digest']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /queue-run\.failed: 2026-10-24T01:00:00\.000Z gh: not logged in/);
  });
});

test('an empty .ok file is no record, and every .ok file found is listed beside the ledger\'s repositories without one', () => {
  withDir((state) => {
    writeFileSync(join(state, 'queue-o-app.ok'), '\n');
    writeFileSync(join(state, 'queue-p-other.ok'), '2026-10-23T23:00:00.000Z\n');
    const text = ledger.digest([], { since: 'a', until: 'b', queue: ledger.queueState(state, ['o/app', 'o/new']) });
    assert.match(text, /queue-p-other\.ok: 2026-10-23T23:00:00\.000Z/);
    assert.match(text, /o\/app: no clean sweep recorded/);
    assert.match(text, /o\/new: no clean sweep recorded/);
    assert.doesNotMatch(text, /queue-o-app\.ok: *\n/);
    assert.ok(!existsSync(join(state, 'none')));
  });
});

test('with the state folder missing, the digest says only that it could not check, with no per-repository lines', () => {
  withDir((dir) => {
    const text = ledger.digest([], { since: 'a', until: 'b', queue: ledger.queueState(join(dir, 'none'), ['o/app', 'o/new']) });
    assert.match(text, /Cannot check the queue/);
    assert.doesNotMatch(text, /no clean sweep recorded/);
    assert.doesNotMatch(text, /Last clean sweep/);
  });
});
