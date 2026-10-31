// bin/seat (#286): every session gets the first animal no live run and no Lead holds; a resume keeps its session's earlier name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { until, world } from './seat-world.mjs';

const nameOf = (w, tag) => readFileSync(join(w.run, `run-${tag}.name`), 'utf8').trim();

test('a new start writes run-<tag>.name, and the record carries the name', () => world(async (w) => {
  const r = w.start('worker', ['--tag', 'one']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(nameOf(w, 'one'), 'aardvark');
  await until(() => w.records().length === 1, 'the record');
  assert.equal(w.records()[0].name, 'aardvark');
}));

test('a live run holds its name, so the next start takes the next one; a run that ended gives its name back', () => world(async (w) => {
  const release = join(w.root, 'release');
  assert.equal(w.start('worker', ['--tag', 'a'], { FAKE_MODE: 'hang', FAKE_RELEASE: release }).code, 0);
  assert.equal(w.start('reviewer', ['--tag', 'b'], { FAKE_MODE: 'hang', FAKE_RELEASE: release }).code, 0);
  assert.deepEqual([nameOf(w, 'a'), nameOf(w, 'b')], ['aardvark', 'badger']);
  writeFileSync(release, '');
  await until(() => w.records().length === 2, 'both records');
  await until(() => !existsSync(join(w.run, 'run-a.child')) && !existsSync(join(w.run, 'run-b.child')), 'both gone');
  assert.equal(w.start('worker', ['--tag', 'c']).code, 0);
  assert.equal(nameOf(w, 'c'), 'aardvark');
}));

test('a Lead holds its name for as long as its name file exists', () => world(async (w) => {
  mkdirSync(join(w.runs, 'demo-lead'));
  writeFileSync(join(w.runs, 'demo-lead/name'), 'aardvark\n');
  assert.equal(w.start('worker', ['--tag', 'one']).code, 0);
  assert.equal(nameOf(w, 'one'), 'badger');
}));

test('a resume keeps the name of its session\'s earlier record; a record without a name gets a new one', () => world(async (w) => {
  const old = (session, extra) => `${JSON.stringify({ session, role: 'worker', seat: 1, tag: 't', run: w.run, start: '2026-10-31T00:00:00Z', end: '2026-10-31T00:01:00Z', ...extra })}\n`;
  writeFileSync(join(w.state, 'sessions.jsonl'), old('s-named', { name: 'dingo' }) + old('s-bare', {}));
  assert.equal(w.start('worker', ['--tag', 'x', '--resume', 's-named', '--seat', '1']).code, 0);
  assert.equal(nameOf(w, 'x'), 'dingo');
  assert.equal(w.start('worker', ['--tag', 'y', '--resume', 's-bare', '--seat', '1']).code, 0);
  assert.equal(nameOf(w, 'y'), 'aardvark');
}));
