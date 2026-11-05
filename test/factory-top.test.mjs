// `factory top` (#174): the read-only view as a subcommand of bin/factory. On the factory host it runs the view; on the MacBook it
// runs the same command there over ssh, as `login` reaches `factory store`. Fake ssh and gh on PATH; nothing live runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './factory-world.mjs';

const EMPTY = JSON.stringify({ now: 1, sessions: [], repos: [], accounts: [], load: [0], cores: 1, github: { ok: true, at: 1, repos: {} }, queue: { failed: [] }, events: [], today: { merged: 0, cost: [], waitedMs: 0 } });

const SSH = (s) => s.calls().split('\n').filter((l) => l.startsWith('ssh '));

test('on the factory host, top --once prints one frame and exits 0', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.fac('top', '--once');
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /^Mac mini {2}load /);
    assert.match(r.stdout, /\[1 All\]/);
    assert.ok(!r.stdout.includes('keys:'), '--once prints no keys line');
    assert.ok(!r.stdout.includes('\x1b'), 'off a terminal it prints plain text');
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});

test('on the MacBook, top --once reads a snapshot over ssh and renders locally, with no -t', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', EMPTY);
    s.fac('top', '--once');
    assert.equal(SSH(s).length, 1);
    assert.match(SSH(s)[0], /ssh -o ConnectTimeout=10 .*node --input-type=module.*snapshot/);
    assert.doesNotMatch(SSH(s)[0], / -t /);
  } finally {
    s.done();
  }
});

test('on the MacBook, top alone requires a local terminal; --width N renders locally', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', EMPTY);
    s.fac('top');
    s.fac('top', '--once', '--width', '90');
    assert.equal(SSH(s).length, 1);
    assert.match(SSH(s)[0], /snapshot/);
    assert.doesNotMatch(SSH(s)[0], / -t /);
  } finally {
    s.done();
  }
});

test('top takes --once and --width N (digits) and nothing else: the usage, exit 2, and no ssh call', () => {
  const s = sandbox();
  try {
    for (const args of [['--width', '9x'], ['--rm'], ['--width'], ['--once', 'extra'], ['--width', '90;id'], ['--full', '--full'], ['--once', '--once']]) {
      const r = s.fac('top', ...args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.out, /bin\/factory top \[--once\] \[--width N\] \[--full\]/);
    }
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});

test('--line and --brief run on the host over ssh with no -t, with their own option passed through (#365)', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', EMPTY);
    s.fac('top', '--line');
    s.fac('top', '--line', '--width', '60');
    s.fac('top', '--brief', '--after', '12');
    assert.deepEqual(SSH(s), [
      "ssh -o ConnectTimeout=10 factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory top --line'",
      "ssh -o ConnectTimeout=10 factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory top --line --width 60'",
      "ssh -o ConnectTimeout=10 factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory top --brief --after 12'",
    ]);
  } finally {
    s.done();
  }
});

test('--line and --brief take only their own option (digits): the usage, exit 2, and no ssh call (#365)', () => {
  const s = sandbox();
  try {
    for (const args of [['--line', '--after', '1'], ['--brief', '--width', '9'], ['--line', '--once'], ['--brief', '--after', '1x'], ['--line', '--width'], ['--line', '--line'], ['--line', '--brief'], ['--brief', '--after', '1;id']]) {
      const r = s.fac('top', ...args);
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});

test('--full goes through ssh to the host, and on the host it prints the full columns header', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', EMPTY);
    s.fac('top', '--once', '--full');
    assert.equal(SSH(s).length, 1);
    assert.match(SSH(s)[0], /snapshot/);
  } finally {
    s.done();
  }
});

test('on the factory host, top --once --full prints the full columns', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.fac('top', '--once', '--full');
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /^NAME .*HARNESS .*CWD BRANCH$/m);
  } finally {
    s.done();
  }
});
