// `factory top` (#174): the read-only view as a subcommand of bin/factory. On the factory host it runs the view; on the MacBook it
// runs the same command there over ssh, as `login` reaches `factory store`. Fake ssh and gh on PATH; nothing live runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './factory-world.mjs';

const SSH = (s) => s.calls().split('\n').filter((l) => l.startsWith('ssh '));

test('on the factory host, top --once prints one frame and exits 0', () => {
  const s = sandbox();
  try {
    s.onHost();
    const r = s.fac('top', '--once');
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /^factory top {2}load /);
    assert.match(r.stdout, /\[1 All\]/);
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});

test('on the MacBook, top --once runs the same command on the host over ssh, with no -t', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', '[]');
    s.fac('top', '--once');
    assert.deepEqual(SSH(s), ["ssh -o ConnectTimeout=10 factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory top --once'"]);
  } finally {
    s.done();
  }
});

test('on the MacBook, top alone asks ssh for a terminal (-t); --width N goes through', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', '[]');
    s.fac('top');
    s.fac('top', '--once', '--width', '90');
    assert.deepEqual(SSH(s), [
      "ssh -o ConnectTimeout=10 -t factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory top'",
      "ssh -o ConnectTimeout=10 factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory top --once --width 90'",
    ]);
  } finally {
    s.done();
  }
});

test('top takes --once and --width N (digits) and nothing else: the usage, exit 2, and no ssh call', () => {
  const s = sandbox();
  try {
    for (const args of [['--width', '9x'], ['--rm'], ['--width'], ['--once', 'extra'], ['--width', '90;id']]) {
      const r = s.fac('top', ...args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.out, /bin\/factory top \[--once\] \[--width N\]/);
    }
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});
