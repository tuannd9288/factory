// Support for the bin/factory-sublayers tests (#82): a fake gh on PATH, answering from files, never a real gh.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// `label list` and `issue list` print $SL/labels.json and $SL/issues.json as they are.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const sl = process.env.SL;
const a = process.argv.slice(2);
const kind = a[0] + ' ' + a[1];
if (kind === 'label list') { process.stdout.write(fs.readFileSync(sl + '/labels.json', 'utf8')); process.exit(0); }
if (kind === 'issue list') { process.stdout.write(fs.readFileSync(sl + '/issues.json', 'utf8')); process.exit(0); }
process.stderr.write('fake gh: ' + a.join(' ') + '\n');
process.exit(1);
`;

/** `labels` and `issues` are the JSON texts gh prints, or a function from the 17 right labels to the labels to print. */
export async function fake({ labels, issues }) {
  const { SUBLAYERS } = await import('../bin/lib/sublayers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sublayers-'));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  const right = SUBLAYERS.map((s) => ({ name: s.label, description: s.description }));
  const text = (v, fallback) => (typeof v === 'string' ? v : JSON.stringify(v ?? fallback));
  writeFileSync(join(dir, 'labels.json'), typeof labels === 'function' ? JSON.stringify(labels(right)) : text(labels, right));
  writeFileSync(join(dir, 'issues.json'), text(issues, []));
  return (...args) => {
    const r = spawnSync(join(root, 'bin/factory-sublayers'), args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SL: dir },
    });
    return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
}

export const issue = (number, ...names) => ({ number, title: `Issue ${number}`, labels: names.map((name) => ({ name })) });
