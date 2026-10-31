// `factory lead <repo>` (#166): the pstack Lead's start as a subcommand of bin/factory. On the factory host it runs this clone's
// packs/pstack/bin/lead; on the MacBook it runs the same command there over ssh, as `top` does. Fake ssh on PATH; nothing live runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './factory-world.mjs';

const SSH = (s) => s.calls().split('\n').filter((l) => l.startsWith('ssh '));

test('on the factory host, lead runs the clone\'s packs/pstack/bin/lead with the same arguments, and makes no ssh call', () => {
  const s = sandbox();
  try {
    s.onHost();
    // The clone holds no such folder, so the launcher's own refusal shows that it ran, and with which repository.
    const r = s.fac('lead', 'no-such-repo', '--dry-run');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /bin\/lead: .*\/no-such-repo is not a folder of its own/);
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});

test('on the MacBook, lead makes exactly one ssh call, with a terminal, to the same command on the host', () => {
  const s = sandbox();
  try {
    s.w('ssh-factory.json', '[]');
    s.fac('lead', 'factory-probe', '--new');
    assert.deepEqual(SSH(s), ["ssh -o ConnectTimeout=10 -t factory@tuans-mac-mini zsh -lc '~/WORKSPACES/bin/factory lead factory-probe --new'"]);
  } finally {
    s.done();
  }
});

test('lead takes a plain repository name and --new or --dry-run once each: the usage, exit 2, and no ssh call', () => {
  const s = sandbox();
  try {
    for (const args of [['../x'], ['factory-probe', '--continue'], [], ['factory-probe', '--new', '--new'], ['-x'], ['a;id'], ['factory-probe', 'extra']]) {
      const r = s.fac('lead', ...args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.out, /bin\/factory lead <repo> \[--new\] \[--dry-run\]/);
    }
    assert.deepEqual(SSH(s), []);
  } finally {
    s.done();
  }
});
