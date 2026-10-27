// The stub reviewer must not flag its own source: a kit update that touches stub-reviewer.mjs adds lines to the diff the
// stub reads, and a marker written literally in them would block the update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commit, factory, git, quiet, run } from './helpers.mjs';

const MARKERS = [['GATE', 'STUB', 'FINDING'], ['GATE', 'STUB', 'RAISE'], ['GATE', 'STUB', 'VERDICT']].map((p) => p.join('-'));
const STUB = 'kit/.gate/bin/lib/stub-reviewer.mjs';

test('a change that adds the whole stub-reviewer.mjs gets no finding and no raise from the stub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-self-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    const base = commit(dir, { 'README.md': '# app\n' }, 'start');
    const head = commit(dir, { '.gate/bin/lib/stub-reviewer.mjs': readFileSync(join(factory, STUB), 'utf8') }, 'add the stub');
    for (const job of ['review', 'verdict']) {
      const out = run(dir, process.execPath, [join(factory, STUB), job, base, head], quiet);
      assert.equal(out.code, 0, out.out);
      const result = JSON.parse(out.out);
      assert.deepEqual(result.blocking, [], `${job}: the stub flagged its own source`);
      assert.equal(result.raise, undefined, `${job}: the stub raised on its own source`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no file under kit/ holds a stub marker literally, so none can block a kit update', () => {
  const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
  const holding = files(join(factory, 'kit')).filter((f) => MARKERS.some((m) => readFileSync(f, 'utf8').includes(m)));
  assert.deepEqual(holding.map((f) => f.slice(factory.length + 1)), []);
});
