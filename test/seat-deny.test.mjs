// bin/seat (#92): --deny <rule> adds a rule to the preset's --disallowedTools, so a run can switch off one tool (the research
// eval's arm B has no Agent tool) without a change to any preset's grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { until, world } from './seat-world.mjs';

const lib = () => import('../bin/lib/seat.mjs');
const denied = (args) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format'));

test('deny rules come after the preset\'s own, every one of which stays; the grants stay as they were', async () => {
  const { buildArgs } = await lib();
  const plain = buildArgs({ role: 'researcher', run: '/r', home: '/h', seat: 1, profiles: '/p' });
  const withDeny = buildArgs({ role: 'researcher', run: '/r', home: '/h', seat: 1, profiles: '/p', deny: ['Agent', 'Task'] });
  // The profiles rules are among the preset's own since INN-39 item 2 (bin/lib/deny-read.mjs), so a run's rules come last.
  assert.deepEqual(denied(withDeny), [...denied(plain), 'Agent', 'Task']);
  assert.deepEqual(withDeny.slice(0, withDeny.indexOf('--disallowedTools')), plain.slice(0, plain.indexOf('--disallowedTools')));
});

test('--deny is repeatable, and a value that starts with a dash is refused like --allow\'s', async () => {
  const { parseArgs } = await lib();
  // A folder must be its own real path (#192), so a real one stands for run and work.
  const dir = realpathSync(tmpdir());
  const o = parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir, '--deny', 'Agent', '--deny', 'Task']);
  assert.deepEqual(o.deny, ['Agent', 'Task']);
  assert.deepEqual(parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir]).deny, []);
  assert.throws(() => parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir, '--deny', '--model']), /--deny --model: a value that starts with a dash is refused/);
  assert.throws(() => parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir, '--deny']), /--deny needs a value/);
});

test('bin/seat passes --deny on to claude', () => world(async (w) => {
  const r = w.start('researcher', ['--deny', 'Agent', '--deny', 'Task']);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const rules = denied(w.saw().argv);
  assert.deepEqual(rules.slice(-2), ['Agent', 'Task'], 'after the preset\'s own rules');
}));

test('forcePush permits only the exact lease push of the current branch, from origin/main', async () => {
  const { pushAllowed } = await import('../bin/lib/force-push.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { git, commit, write } = await import('./helpers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'force-push-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, { 'README.md': 'base' });
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'switch', '-qc', 'own');
    const allowed = 'git push --force-with-lease origin own';
    assert.equal(pushAllowed(allowed, dir), true);
    assert.equal(pushAllowed(allowed, dir, false), true);
    for (const command of ['git push --force-with-lease origin main', 'git push --force origin own', 'git push -f origin own', 'git push -fn origin own', 'git push --for origin own', 'git pu"sh" --force origin own', 'git push origin +own', 'git push --mirror origin', 'git push --force-with-lease origin other', allowed + '; echo done', 'git push origin own'])
      assert.equal(pushAllowed(command, dir), false, command);
    for (const command of ['git push --force-with-lease origin main', 'git push --force origin own', 'git push -f origin own', 'git push -fn origin own', 'git push --for origin own', 'git pu"sh" --force origin own', 'git push origin +own', 'git push --mirror origin', 'git push --force-with-lease origin other'])
      assert.equal(pushAllowed(command, dir, false), false, command);
    const { spawnSync } = await import('node:child_process');
    const { factory } = await import('./helpers.mjs');
    for (const [command, expected] of [[allowed, 0], ['git push --force origin own', 2]]) {
      const hook = spawnSync(process.execPath, [join(factory, 'bin/lib/force-push.mjs'), 'seat'], { encoding: 'utf8', input: JSON.stringify({ cwd: dir, tool_input: { command } }) });
      assert.equal(hook.status, expected, hook.stderr);
    }
    write(dir, { '.gate/driver.json': '{"forcePush":"off"}' });
    assert.equal(pushAllowed(allowed, dir), true, 'candidate cannot turn off main’s switch');
    commit(dir, {});
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(dir, { '.gate/driver.json': '{"forcePush":"pstack"}' });
    assert.equal(pushAllowed(allowed, dir), false, 'candidate cannot turn on main’s switch');
    commit(dir, {});
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(pushAllowed(allowed, dir), true);
    git(dir, 'switch', '-q', 'main');
    assert.equal(pushAllowed('git push --force-with-lease origin main', dir), false);
    git(dir, 'switch', '-qc', 'claim/1');
    assert.equal(pushAllowed('git push --force-with-lease origin claim/1', dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
