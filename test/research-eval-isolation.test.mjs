// The research eval's runner (#92, review of the build, B1): no session can read a key, or another session's log. Each session
// has a run folder of its own under the runs folder and an empty work folder; it may read only its task's folders; the runner
// refuses folders that hold the keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { factory } from './helpers.mjs';
import { PROBE_CALLS, evalWorld } from './research-eval-world.mjs';

const TAGS = ['re-knip-reader-A-1', 're-knip-reader-B-1', 're-round4-review-B-1', 're-round4-review-A-1'];
const loadTasks = async () => (await import('../probes/research-eval/keys.mjs')).loadTasks();

test('each session has a run folder of its own under the runs folder and an empty work folder of its own', () => evalWorld((w) => {
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 0, r.out + r.err);
  const calls = w.calls();
  assert.equal(calls.length, 4);
  const runFolders = calls.map((c) => c.addDirs[0]);
  assert.equal(new Set(runFolders).size, 4);
  for (const f of runFolders) {
    assert.equal(dirname(f), w.runs, 'one level under the runs folder, where bin/seat counts sessions');
    assert.ok(!f.endsWith('issue-1'), 'not the folder the caller named');
  }
  assert.equal(new Set(calls.map((c) => c.cwd)).size, 4);
  for (const c of calls) {
    assert.equal(dirname(c.cwd), realpathSync(w.work));
    assert.deepEqual(c.seen[c.cwd], [], 'the work folder starts empty');
  }
}));

test('no folder a session may read holds another session\'s log, a task key or the eval itself', () => evalWorld((w) => {
  assert.equal(w.eval(['--set', 'probe', '--go']).code, 0);
  const calls = w.calls();
  calls.forEach((c, i) => {
    for (const [dir, files] of Object.entries(c.seen)) {
      for (const f of files) {
        const own = f.match(/^run-(.+)\.(jsonl|err|pid|seat|child|lock)$/);
        if (own) assert.equal(own[1], TAGS[i], `${dir} holds ${f}`);
        assert.ok(!/research-eval|tasks\/|\.json$/.test(f), `${dir} holds ${f}`);
      }
    }
  });
}));

test('a session may read its task\'s folders and its own run folder, and nothing wider', () => evalWorld(async (w) => {
  assert.equal(w.eval(['--set', 'probe', '--go']).code, 0);
  const tasks = await loadTasks();
  w.calls().forEach((c, i) => {
    const task = tasks.find((t) => t.id === PROBE_CALLS[i]);
    assert.deepEqual(c.addDirs.slice(1), task.readable.map((r) => join(w.runs, r)));
  });
}));

test('both arms deny the Read of the eval\'s own folder in the checkout', () => evalWorld((w) => {
  assert.equal(w.eval(['--set', 'probe', '--go']).code, 0);
  for (const c of w.calls()) assert.ok(c.denied.includes(`Read(/${realpathSync(factory)}/probes/research-eval/**)`), c.denied.join(' '));
}));

test('the runner refuses a --run or --work that holds the checkout, is inside it, holds a session\'s log or holds a task key', () => evalWorld((w) => {
  const bare = (args) => {
    const r = w.eval(['--set', 'probe', ...args]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.deepEqual(w.calls(), []);
    return r.err;
  };
  const withFile = (name, file) => {
    const dir = join(w.root, name);
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), '{}\n');
    return dir;
  };
  // eval() puts its own --run and --work first, so these come later and win.
  assert.match(bare(['--work', dirname(factory)]), /checkout/);
  assert.match(bare(['--run', join(factory, 'probes')]), /checkout/);
  assert.match(bare(['--run', withFile('old', 'run-re-x-A-1.jsonl')]), /log/);
  assert.match(bare(['--work', withFile('keys', 'probes/research-eval/tasks/knip-reader.json')]), /key/);
}));

test('a run folder left by an earlier session of the same tag is refused, not reused', () => evalWorld((w) => {
  const old = join(w.runs, 're-probe-knip-reader-A-1');
  mkdirSync(old);
  writeFileSync(join(old, 'run-re-knip-reader-A-1.jsonl'), '{"old":true}\n');
  const r = w.eval(['--set', 'probe', '--go']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /re-probe-knip-reader-A-1/);
  assert.deepEqual(w.calls(), []);
}));
