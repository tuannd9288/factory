// #257: the queue's sweep moves the factory's own checkout to main, and only when nothing runs from it. A bare origin and a clone
// in a temporary folder; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, git } from './helpers.mjs';

const lib = () => import('../bin/lib/checkout.mjs');
const seatLib = () => import('../bin/lib/seat.mjs');

/** An origin, a clone of it that is the checkout, and a second clone that makes commits on origin. */
async function world(body) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-')));
  try {
    const origin = join(dir, 'origin.git');
    const seed = join(dir, 'seed');
    const checkout = join(dir, 'checkout');
    const state = join(dir, 'state');
    const runs = join(dir, 'runs');
    for (const d of [state, runs]) mkdirSync(d);
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, seed);
    writeFileSync(join(seed, 'a.txt'), 'one\n');
    writeFileSync(join(seed, '.gitignore'), 'gen.txt\n*.gen\nnotes\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'one');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(dir, 'clone', '-q', origin, checkout);
    let n = 1;
    const w = {
      dir, origin, seed, checkout, state, runs,
      advance(name = 'b.txt', text = 'two\n', force = false) {
        n += 1;
        mkdirSync(join(seed, name, '..'), { recursive: true });
        writeFileSync(join(seed, name), text);
        git(seed, 'add', ...(force ? ['-f'] : []), name);
        git(seed, 'commit', '-q', '-m', `c${n}`);
        git(seed, 'push', '-q', 'origin', 'HEAD:main');
        return git(seed, 'rev-parse', 'HEAD');
      },
      head: () => git(checkout, 'rev-parse', 'HEAD'),
      failed: () => (existsSync(join(state, 'queue-checkout.failed')) ? readFileSync(join(state, 'queue-checkout.failed'), 'utf8') : null),
      follow: async (extra = {}) => (await lib()).followMain({ root: checkout, state, live: () => 0, ...extra }),
    };
    return await body(w);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('updates a clean main checkout that is behind', () => world(async (w) => {
  const tip = w.advance();
  const r = await w.follow();
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.equal(w.head(), tip);
  assert.equal(w.failed(), null);
}));

test('a checkout already at main is left alone and says current', () => world(async (w) => {
  const before = w.head();
  assert.equal((await w.follow()).status, 'current');
  assert.equal(w.head(), before);
}));

test('refuses local changes, a branch that is not main, a failed fetch and a diverged main, and moves nothing', () => world(async (w) => {
  w.advance();
  const before = w.head();
  const cases = [
    ['local changes', /local changes/, () => writeFileSync(join(w.checkout, 'a.txt'), 'edited\n'), () => git(w.checkout, 'checkout', '-q', '--', 'a.txt')],
    ['an untracked file', /local changes/, () => writeFileSync(join(w.checkout, 'new.txt'), 'x\n'), () => rmSync(join(w.checkout, 'new.txt'))],
    ['another branch', /not main/, () => git(w.checkout, 'switch', '-q', '-c', 'other'), () => git(w.checkout, 'switch', '-q', 'main')],
    ['a failed fetch', /fetch failed/, () => git(w.checkout, 'remote', 'set-url', 'origin', join(w.dir, 'nowhere.git')), () => git(w.checkout, 'remote', 'set-url', 'origin', w.origin)],
    ['a diverged main', /diverged/, () => { writeFileSync(join(w.checkout, 'mine.txt'), 'm\n'); git(w.checkout, 'add', '.'); git(w.checkout, 'commit', '-q', '-m', 'mine'); },
      () => git(w.checkout, 'reset', '-q', '--hard', before)],
  ];
  for (const [name, reason, spoil, mend] of cases) {
    spoil();
    const head = w.head();
    const r = await w.follow();
    assert.equal(r.status, 'refused', `${name}: ${JSON.stringify(r)}`);
    assert.equal(w.head(), head, `${name}: HEAD moved`);
    assert.match(w.failed() ?? '', reason, name);
    mend();
    rmSync(join(w.state, 'queue-checkout.failed'), { force: true });
  }
  assert.equal(w.head(), before);
}));

test('a refusal leaves queue-checkout.failed with the time and the reason, and a later success removes it', () => world(async (w) => {
  const tip = w.advance();
  writeFileSync(join(w.checkout, 'a.txt'), 'edited\n');
  await w.follow({ now: Date.parse('2026-10-31T10:00:00Z') });
  assert.match(w.failed(), /^2026-10-31T10:00:00\.000Z local changes/);
  git(w.checkout, 'checkout', '-q', '--', 'a.txt');
  assert.equal((await w.follow()).status, 'updated');
  assert.equal(w.head(), tip);
  assert.equal(w.failed(), null);
}));

test('defers while a run is live, says nothing, and updates on the sweep after it ends', () => world(async (w) => {
  const before = w.head();
  const tip = w.advance();
  for (const live of [1, Infinity]) {
    const r = await w.follow({ live: () => live });
    assert.equal(r.status, 'deferred', String(live));
    assert.equal(w.head(), before);
    assert.equal(w.failed(), null, 'a deferral is no refusal');
  }
  assert.equal((await w.follow()).status, 'updated');
  assert.equal(w.head(), tip);
  assert.ok(!existsSync(join(w.state, 'queue-checkout.since')), 'the deferral clock is cleared');
}));

test('a deferral past two hours leaves queue-checkout.failed that names the commits and the hours', () => world(async (w) => {
  w.advance();
  w.advance('c.txt');
  const t0 = Date.parse('2026-10-31T10:00:00Z');
  await w.follow({ live: () => 1, now: t0 });
  assert.equal(w.failed(), null);
  await w.follow({ live: () => 1, now: t0 + 119 * 60_000 });
  assert.equal(w.failed(), null);
  await w.follow({ live: () => 1, now: t0 + 125 * 60_000 });
  assert.match(w.failed(), /2 commits behind for 2 h: runs are live/);
}));

test('a start that registered first is counted, so the update defers; a start holding the lock makes it wait', () => world(async (w) => {
  const { liveRuns } = await seatLib();
  const { withStartLock } = await lib();
  const before = w.head();
  w.advance();
  mkdirSync(join(w.runs, 'issue-1'));
  writeFileSync(join(w.runs, 'issue-1', 'run-a.claim.pid'), `${process.pid}\n`);
  assert.equal(liveRuns(w.runs), 1, 'a claim counts');
  assert.equal((await w.follow({ live: () => liveRuns(w.runs) })).status, 'deferred');
  rmSync(join(w.runs, 'issue-1', 'run-a.claim.pid'));
  const { followMain } = await lib();
  const out = withStartLock(w.state, w.checkout, () => followMain({ root: w.checkout, state: w.state, live: () => 0 }), { wait: 50, loaded: before });
  assert.equal(out.value.status, 'busy');
  assert.equal(w.head(), before, 'nothing moved under a start');
  assert.equal((await w.follow()).status, 'updated');
}));

test('a start that waits for the lock gives up after its wait, and a lock a crash left is displaced', async () => {
  const { withStartLock } = await lib();
  const dir = mkdtempSync(join(tmpdir(), 'checkout-lock-'));
  try {
    const held = join(dir, 'checkout.lock');
    mkdirSync(held);
    assert.throws(() => withStartLock(dir, dir, () => 1, { wait: 60 }), /update of the checkout is in progress/);
    const old = new Date(Date.now() - 600_000);
    utimesSync(held, old, old);
    assert.equal(withStartLock(dir, dir, () => 7, { wait: 60 }).value, 7);
    assert.ok(!existsSync(held), 'released');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a start that loaded an older commit than the checkout holds now does not run, and releases the lock', () => world(async (w) => {
  const { withStartLock } = await lib();
  let ran = false;
  const r = withStartLock(w.state, w.checkout, () => { ran = true; }, { loaded: '0'.repeat(40) });
  assert.equal(r.moved, true);
  assert.equal(ran, false);
  assert.ok(!existsSync(join(w.state, 'checkout.lock')));
  const same = withStartLock(w.state, w.checkout, () => 'ran', { loaded: w.head() });
  assert.equal(same.value, 'ran');
}));

test('bin/seat started on an older commit starts again on the current one, once, and runs the session once', async () => {
  const { world: seatWorld } = await import('./seat-world.mjs');
  await seatWorld(async (w) => {
    const r = w.start('worker', [], { FACTORY_LOADED_HEAD: '0'.repeat(40) });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.err, /the checkout moved to [0-9a-f]{7}; started again on it/);
    const { until } = await import('./seat-world.mjs');
    await until(() => w.records().length === 1, 'the one record');
    assert.equal(w.records().length, 1);
  });
});

test('moves an ignored file in the way into the archive and deletes nothing', () => world(async (w) => {
  writeFileSync(join(w.checkout, 'gen.txt'), 'mine, ignored\n');
  const tip = w.advance('gen.txt', 'theirs\n', true);
  const r = await w.follow();
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.equal(w.head(), tip);
  assert.equal(readFileSync(join(w.checkout, 'gen.txt'), 'utf8'), 'theirs\n');
  const [folder] = readdirSync(join(w.state, 'archive'));
  assert.match(folder, new RegExp(`^${tip.slice(0, 7)}-`));
  assert.equal(readFileSync(join(w.state, 'archive', folder, 'gen.txt'), 'utf8'), 'mine, ignored\n');
}));

test('liveRuns counts a marker of seat 0 and not against a seat\'s cap; markRun writes and removes it', async () => {
  const { liveRuns, liveCount } = await seatLib();
  const { markRun } = await lib();
  const runs = mkdtempSync(join(tmpdir(), 'checkout-runs-'));
  try {
    assert.equal(liveRuns(runs), 0);
    const unmark = markRun(runs, 'canary');
    assert.equal(liveRuns(runs), 1);
    assert.equal(liveCount(runs, 1), 0);
    assert.equal(liveCount(runs, 2), 0);
    assert.equal(readFileSync(join(runs, 'daemon-canary', 'run-canary.seat'), 'utf8').trim(), '0');
    unmark();
    assert.equal(liveRuns(runs), 0);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

test('liveRuns counts a live session of either seat and not a dead pid', async () => {
  const { liveRuns } = await seatLib();
  const runs = mkdtempSync(join(tmpdir(), 'checkout-runs-'));
  try {
    mkdirSync(join(runs, 'issue-1'));
    for (const [n, seat] of [['a', 1], ['b', 2]]) {
      writeFileSync(join(runs, 'issue-1', `run-${n}.pid`), `${process.pid}\n`);
      writeFileSync(join(runs, 'issue-1', `run-${n}.seat`), `${seat}\n`);
    }
    writeFileSync(join(runs, 'issue-1', 'run-dead.pid'), '1\n');
    assert.equal(liveRuns(runs), 2);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

// The installed plists are the Human's to reinstall with sudo. The queue compares what the new code renders with them.
test('a rendered plist that differs from the installed one leaves queue-plist.failed and the wanted plist; once equal, both go', async () => {
  const { checkPlists } = await lib();
  const dir = mkdtempSync(join(tmpdir(), 'checkout-plist-'));
  try {
    const plists = join(dir, 'LaunchDaemons');
    const state = join(dir, 'state');
    mkdirSync(plists);
    mkdirSync(state);
    const label = 'io.github.tuannd9288.factory.queue';
    writeFileSync(join(plists, `${label}.plist`), 'old\n');
    const render = () => 'new\n';
    const r = checkPlists({ root: dir, state, plistDir: plists, render, now: Date.parse('2026-10-31T10:00:00Z') });
    assert.deepEqual(r.differ, [label]);
    assert.match(readFileSync(join(state, 'queue-plist.failed'), 'utf8'), new RegExp(`^2026-10-31T10:00:00\\.000Z ${label}`));
    assert.equal(readFileSync(join(state, 'plist-wanted', `${label}.plist`), 'utf8'), 'new\n');
    assert.equal(readFileSync(join(plists, `${label}.plist`), 'utf8'), 'old\n', 'the installed plist is only read');
    writeFileSync(join(plists, `${label}.plist`), 'new\n');
    assert.deepEqual(checkPlists({ root: dir, state, plistDir: plists, render }).differ, []);
    assert.ok(!existsSync(join(state, 'queue-plist.failed')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plist that is not installed is skipped; a wanted plist that changed moves the older one to the archive', async () => {
  const { checkPlists } = await lib();
  const dir = mkdtempSync(join(tmpdir(), 'checkout-plist-'));
  try {
    const plists = join(dir, 'p');
    const state = join(dir, 'state');
    mkdirSync(plists);
    mkdirSync(state);
    assert.deepEqual(checkPlists({ root: dir, state, plistDir: plists, render: () => 'x' }).differ, []);
    writeFileSync(join(plists, 'io.github.tuannd9288.factory.digest.plist'), 'old\n');
    checkPlists({ root: dir, state, plistDir: plists, render: () => 'v1\n' });
    checkPlists({ root: dir, state, plistDir: plists, render: () => 'v2\n' });
    const wanted = join(state, 'plist-wanted', 'io.github.tuannd9288.factory.digest.plist');
    assert.equal(readFileSync(wanted, 'utf8'), 'v2\n');
    const archived = readdirSync(join(state, 'archive')).flatMap((f) => readdirSync(join(state, 'archive', f)).map((n) => readFileSync(join(state, 'archive', f, n), 'utf8')));
    assert.deepEqual(archived, ['v1\n']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repositories of an installed plist are handed to the generator', async () => {
  const { reposOf } = await lib();
  const text = '<array>\n    <string>/x/bin/claude-canary</string>\n    <string>run</string>\n    <string>--repo</string>\n    <string>o/app</string>\n    <string>--repo</string>\n    <string>o/lib</string>\n  </array>';
  assert.deepEqual(reposOf(text), ['o/app', 'o/lib']);
  assert.deepEqual(reposOf('<string>x</string>'), []);
});

// The whole path through the real command: a sweep of a checkout that is behind moves it; a refusal fails nothing else.
const GH = '#!/bin/sh\ncase "$*" in\n  "api user"*) echo agent-bot ;;\n  *) exit 1 ;;\nesac\n';
function sweepIn(w, extra = {}) {
  const bin = join(w.dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const home = join(w.dir, 'home');
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FACTORY_STATE: w.state, FACTORY_RUNS: w.runs, FACTORY_ROOT: join(w.dir, 'root'),
    FACTORY_CHECKOUT: w.checkout, FACTORY_PLIST_DIR: join(w.dir, 'no-plists'), ...extra,
  };
  mkdirSync(env.FACTORY_ROOT, { recursive: true });
  return spawnSync(join(factory, 'bin/factory-queue'), ['sweep'], { encoding: 'utf8', env });
}

test('a queue sweep moves a checkout that is behind to main, and a refusal does not fail the sweep', () => world(async (w) => {
  const tip = w.advance();
  let r = sweepIn(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(w.head(), tip);
  writeFileSync(join(w.checkout, 'a.txt'), 'edited\n');
  w.advance('c.txt');
  r = sweepIn(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(w.failed(), /local changes/);
  assert.equal(w.head(), tip);
}));

test('a sweep updates nothing where the checkout is not named: not ~/WORKSPACES and no FACTORY_CHECKOUT', () => world(async (w) => {
  const before = w.head();
  w.advance();
  const r = sweepIn(w, { FACTORY_CHECKOUT: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(w.head(), before);
}));

// Round 2 (#257): the start registers under the lock and only then; git never overwrites an ignored file; a failed render alerts.
const archived = (w) => (existsSync(join(w.state, 'archive')) ? readdirSync(join(w.state, 'archive'), { recursive: true }) : []);

test('an ignored file that a merge lands after the fetch brings in is kept, then archived by the next sweep', () => world(async (w) => {
  writeFileSync(join(w.checkout, 'gen.txt'), 'MINE\n');
  const tip = w.advance('b.txt', 'two\n');
  const r = await w.follow({ live: () => { w.advance('gen.txt', 'theirs\n', true); return 0; } });
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.equal(w.head(), tip, 'it moved to the tip its archive scan used');
  assert.equal(readFileSync(join(w.checkout, 'gen.txt'), 'utf8'), 'MINE\n');
  const next = await w.follow();
  assert.equal(next.status, 'updated', JSON.stringify(next));
  assert.equal(readFileSync(join(w.checkout, 'gen.txt'), 'utf8'), 'theirs\n');
  assert.ok(archived(w).some((n) => n.endsWith('gen.txt')));
  const [folder] = readdirSync(join(w.state, 'archive')).filter((f) => existsSync(join(w.state, 'archive', f, 'gen.txt')));
  assert.equal(readFileSync(join(w.state, 'archive', folder, 'gen.txt'), 'utf8'), 'MINE\n');
}));

test('an ignored file on the parent path of an incoming file is kept: the merge refuses and says so', () => world(async (w) => {
  writeFileSync(join(w.checkout, 'notes'), 'MINE\n');
  const before = w.head();
  w.advance('notes/x.txt', 'theirs\n', true);
  const r = await w.follow();
  assert.equal(r.status, 'refused', JSON.stringify(r));
  assert.match(w.failed(), /pull failed/);
  assert.equal(w.head(), before);
  assert.equal(readFileSync(join(w.checkout, 'notes'), 'utf8'), 'MINE\n');
}));

test('an ignored file with a non-ASCII name is archived, not overwritten', () => world(async (w) => {
  writeFileSync(join(w.checkout, 'é.gen'), 'MINE\n');
  w.advance('é.gen', 'theirs\n', true);
  const r = await w.follow();
  assert.equal(r.status, 'updated', JSON.stringify(r));
  assert.equal(readFileSync(join(w.checkout, 'é.gen'), 'utf8'), 'theirs\n');
  const [folder] = readdirSync(join(w.state, 'archive'));
  assert.equal(readFileSync(join(w.state, 'archive', folder, 'é.gen'), 'utf8'), 'MINE\n');
}));

test('a path with glob characters is matched literally when the scan asks git whether it is tracked', () => world(async (w) => {
  w.advance('ab.gen', 'tracked\n', true); // a tracked file that the glob a*.gen would match
  assert.equal((await w.follow()).status, 'updated');
  writeFileSync(join(w.checkout, 'a*.gen'), 'MINE\n');
  w.advance('a*.gen', 'theirs\n', true);
  const r = await w.follow();
  assert.equal(r.status, 'updated', JSON.stringify(r));
  const [folder] = readdirSync(join(w.state, 'archive'));
  assert.equal(readFileSync(join(w.state, 'archive', folder, 'a*.gen'), 'utf8'), 'MINE\n');
}));

test('a failed render keeps queue-plist.failed and names the plist and the first line; a first failed render writes it', async () => {
  const { checkPlists } = await lib();
  const dir = mkdtempSync(join(tmpdir(), 'checkout-plist-'));
  try {
    const plists = join(dir, 'p');
    const state = join(dir, 's');
    mkdirSync(plists);
    mkdirSync(state);
    const label = 'io.github.tuannd9288.factory.queue';
    writeFileSync(join(plists, `${label}.plist`), 'old\n');
    const broken = () => { throw new Error('plist: unknown argument --daemon\nsecond line'); };
    const first = checkPlists({ root: dir, state, plistDir: plists, render: broken });
    assert.match(readFileSync(join(state, 'queue-plist.failed'), 'utf8'), new RegExp(`could not render ${label}: plist: unknown argument --daemon\n$`));
    assert.deepEqual(first.differ, []);
    checkPlists({ root: dir, state, plistDir: plists, render: () => 'new\n' });
    assert.match(readFileSync(join(state, 'queue-plist.failed'), 'utf8'), new RegExp(`^\\S+ ${label}: the installed plist differs`));
    checkPlists({ root: dir, state, plistDir: plists, render: broken });
    assert.match(readFileSync(join(state, 'queue-plist.failed'), 'utf8'), /could not render/, 'the earlier alert is not cleared by a failure');
    writeFileSync(join(plists, `${label}.plist`), 'new\n');
    checkPlists({ root: dir, state, plistDir: plists, render: () => 'new\n' });
    assert.ok(!existsSync(join(state, 'queue-plist.failed')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The start side. A named pipe where bin/seat reads a seat's log holds it inside chooseSeat, right after the claim is written.
test('a start writes its claim while it holds checkout.lock, and releases the lock once the seat is chosen', async () => {
  const { world: seatWorld, until, SEAT_JS } = await import('./seat-world.mjs');
  await seatWorld(async (w) => {
    const other = join(w.runs, 'issue-2');
    mkdirSync(other);
    const fifo = join(other, 'run-p.jsonl');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    writeFileSync(join(other, 'run-p.seat'), '2\n');
    const child = spawn(process.execPath, [SEAT_JS, ...w.args('worker')], { env: w.env(), cwd: w.root, stdio: 'ignore' });
    const ended = new Promise((resolve) => child.on('close', resolve));
    try {
      await until(() => existsSync(join(w.run, 'run-worker.claim.pid')), 'the claim');
      assert.ok(existsSync(join(w.state, 'checkout.lock')), 'the claim was written without checkout.lock');
      closeSync(openSync(fifo, 'w'));
      assert.equal(await ended, 0);
      assert.ok(!existsSync(join(w.state, 'checkout.lock')), 'the lock was not released');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('the plugin install runs with no checkout.lock held and with the start\'s claim written', async () => {
  const { world: seatWorld, PSTACK_SETTINGS } = await import('./seat-world.mjs');
  await seatWorld(async (w) => {
    w.settings(PSTACK_SETTINGS);
    const r = w.start('worker');
    assert.equal(r.code, 0, r.out + r.err);
    const calls = w.pluginCalls();
    assert.ok(calls.length > 0, 'no plugin call was made');
    for (const c of calls) {
      assert.equal(c.lock, false, `checkout.lock was held during ${c.argv.join(' ')}`);
      assert.equal(c.claimed, true, `no claim during ${c.argv.join(' ')}`);
    }
  });
});

test('a start that finds checkout.lock held refuses as busy and leaves no pid, claim or seat file', async () => {
  const { world: seatWorld } = await import('./seat-world.mjs');
  await seatWorld(async (w) => {
    mkdirSync(join(w.state, 'checkout.lock'));
    const r = w.start('worker', [], { FACTORY_CHECKOUT_LOCK_WAIT_MS: '100' });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /checkout/);
    assert.deepEqual(readdirSync(w.run).filter((n) => /^run-worker\./.test(n)), []);
    assert.deepEqual(w.records(), []);
  });
});

test('the refusal after the wait names the holder when the lock records one', async () => {
  const { world: seatWorld } = await import('./seat-world.mjs');
  await seatWorld(async (w) => {
    mkdirSync(join(w.state, 'checkout.lock'));
    writeFileSync(join(w.state, 'checkout.lock', 'holder'), '4242 the update of the checkout\n');
    const r = w.start('worker', [], { FACTORY_CHECKOUT_LOCK_WAIT_MS: '100' });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /held by the update of the checkout \(pid 4242\)/);
  });
});

test('a lock taken by the update or by a start records its holder', async () => {
  const { withStartLock } = await lib();
  const dir = mkdtempSync(join(tmpdir(), 'checkout-holder-'));
  try {
    let seen;
    withStartLock(dir, dir, () => { seen = readFileSync(join(dir, 'checkout.lock', 'holder'), 'utf8'); }, { wait: 50, label: 'a start of bin/seat' });
    assert.equal(seen, `${process.pid} a start of bin/seat\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
