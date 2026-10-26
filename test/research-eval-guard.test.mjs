// The research eval's runner (#92, Colly's message 4): before any session starts, with or without --go, the runner refuses a set in
// which a task's readable folder is, or contains, a run folder, a work folder, a key, issue-92's reports or the runs folder itself,
// so that what a session may read can never reach an answer. Its exit code is 7. The paths are compared after symlinks are resolved,
// so each row makes the knip-reader task's readable folder a link to the folder that must not be readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { evalWorld } from './research-eval-world.mjs';

const READABLE = 'issue-70/sources/knip';
const ROWS = [
  ['the runs folder itself, which holds every run folder', (w) => w.runs],
  ['issue-92, which holds the reports', (w) => join(w.runs, 'issue-92')],
  ['a folder inside issue-92', (w) => join(w.runs, 'issue-92/review')],
  ['a run folder of the plan', (w) => join(w.runs, 're-probe-knip-reader-A-1')],
  ['a key folder of the runs folder\'s own checkout', (w) => join(w.runs, 'issue-92/w92/probes/research-eval/tasks')],
  ['the factory checkout, which holds the keys', () => factory],
  ['the keys of this checkout', () => join(factory, 'probes/research-eval/tasks')],
];

for (const [name, target] of ROWS) {
  test(`a task whose readable folder is, or holds, ${name}: refused with exit 7, with and without --go, before a session starts`, () => evalWorld((w) => {
    mkdirSync(target(w), { recursive: true });
    mkdirSync(join(w.runs, 'issue-70/sources'), { recursive: true });
    symlinkSync(target(w), join(w.runs, READABLE));
    for (const args of [[], ['--go']]) {
      const r = w.eval(['--set', 'probe', ...args]);
      assert.equal(r.code, 7, r.out + r.err);
      assert.match(r.err, /knip-reader/);
      assert.ok(r.err.includes(READABLE), r.err);
      assert.deepEqual(w.calls(), []);
      assert.deepEqual(readdirSync(w.work), [], 'no work folder was made');
    }
  }));
}

test('the ten real tasks pass the guard, for the probe and for the full set', () => evalWorld((w) => {
  for (const set of ['probe', 'full']) {
    const r = w.eval(['--set', set]);
    assert.equal(r.code, 0, r.out + r.err);
  }
}));
