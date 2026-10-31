// #211: clonesUnder, which the ledger and the merge queue share, skips a clone it cannot name and says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clonesUnder } from '../bin/lib/ledger.mjs';

function clone(root, folder, url) {
  const dir = join(root, folder);
  mkdirSync(join(dir, '.gate'), { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (url) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  writeFileSync(join(dir, '.gate/config.sh'), '');
}

test('clonesUnder skips a clone with no readable origin or no owner/name, reports each, and keeps the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-clones-'));
  try {
    clone(root, 'app', 'https://github.com/o/app/');
    clone(root, 'lib', 'git@github.com:o/lib.git');
    clone(root, 'stray', null);
    clone(root, 'odd', 'https://github.com/justone');
    const skipped = [];
    const found = clonesUnder(root, (folder, why) => skipped.push([folder, why]));
    assert.deepEqual([...found.keys()].sort(), ['o/app', 'o/lib']);
    assert.deepEqual(skipped.map(([folder]) => folder).sort(), [join(root, 'odd'), join(root, 'stray')]);
    assert.ok(skipped.every(([, why]) => typeof why === 'string' && why.length > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
