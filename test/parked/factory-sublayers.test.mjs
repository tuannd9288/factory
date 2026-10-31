// #82: bin/factory-sublayers, against a fake gh on PATH. It never runs a real gh.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// gh: `label list` and `issue list` answer from $SL/labels.json and $SL/issues.json; $SL_FAIL names the command that
// fails. Every call is appended to $SL/calls.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const sl = process.env.SL;
const a = process.argv.slice(2);
fs.appendFileSync(sl + '/calls', a.join(' ') + '\n');
const kind = a[0] + ' ' + a[1];
if (process.env.SL_FAIL === kind) { process.stderr.write('fake gh: HTTP 502\n'); process.exit(1); }
if (kind === 'label list') { process.stdout.write(fs.readFileSync(sl + '/labels.json', 'utf8')); process.exit(0); }
if (kind === 'issue list') { process.stdout.write(fs.readFileSync(sl + '/issues.json', 'utf8')); process.exit(0); }
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

async function setup({ labels, issues, fail }) {
  const { SUBLAYERS } = await import('../../bin/lib/sublayers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sublayers-'));
  const bin = join(dir, 'bin');
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, FAKE_GH);
  chmodSync(ghPath, 0o755);
  const all = SUBLAYERS.map((s) => ({ name: s.label, description: s.description }));
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels ? labels(all) : all));
  writeFileSync(join(dir, 'issues.json'), JSON.stringify(issues ?? []));
  return { dir, run: (...args) => {
    const r = spawnSync(join(root, 'bin/factory-sublayers'), args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SL: dir, SL_FAIL: fail ?? '' },
    });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  } };
}

const issue = (number, ...names) => ({ number, title: `Issue ${number}`, labels: names.map((name) => ({ name })) });

describe('bin/factory-sublayers', () => {
  test('a clean run exits 0 and says what it checked', async () => {
    const { run, dir } = await setup({ issues: [issue(1, 'task', 'sublayer-1a'), issue(2, 'sublayer-4b')] });
    const r = run();
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /^factory-sublayers: 17 labels and 2 open issues are in order$/m);
    const calls = (await import('node:fs')).readFileSync(join(dir, 'calls'), 'utf8');
    assert.match(calls, /^label list -R tuannd9288\/factory --limit 200 --json name,description$/m);
    assert.match(calls, /^issue list -R tuannd9288\/factory --state open --limit 500 --json number,title,labels$/m);
  });

  test('--repo names the repository', async () => {
    const { run, dir } = await setup({});
    run('--repo', 'o/app');
    const calls = (await import('node:fs')).readFileSync(join(dir, 'calls'), 'utf8');
    assert.match(calls, /^label list -R o\/app /m);
    assert.match(calls, /^issue list -R o\/app /m);
  });

  test('a missing label is reported, exit 1', async () => {
    const { run } = await setup({ labels: (all) => all.filter((l) => l.name !== 'sublayer-1e') });
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.out, /^missing label: sublayer-1e \(1e Surfaces\)$/m);
  });

  test('a wrong description is reported, exit 1', async () => {
    const { run } = await setup({ labels: (all) => all.map((l) => (l.name === 'sublayer-1b' ? { ...l, description: 'records' } : l)) });
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.out, /^wrong description: sublayer-1b has "records", want "1b System of record"$/m);
  });

  test('an open issue with no sublayer label is reported, exit 1', async () => {
    const { run } = await setup({ issues: [issue(7, 'task')] });
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.out, /^issue #7 \(Issue 7\): no sublayer label$/m);
  });

  test('an open issue with two sublayer labels is reported, exit 1', async () => {
    const { run } = await setup({ issues: [issue(8, 'sublayer-1a', 'sublayer-3c')] });
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.out, /^issue #8 \(Issue 8\): 2 sublayer labels \(sublayer-1a, sublayer-3c\)$/m);
  });

  test('a gh failure exits 2 and is never reported as nothing to report', async () => {
    for (const fail of ['label list', 'issue list']) {
      const { run } = await setup({ fail });
      const r = run();
      assert.equal(r.status, 2, fail);
      assert.match(r.err, new RegExp(`^factory-sublayers: gh ${fail} failed`, 'm'));
      assert.match(r.err, /HTTP 502/);
      assert.doesNotMatch(r.out, /in order/);
    }
  });
});
