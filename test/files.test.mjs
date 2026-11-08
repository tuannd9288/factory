// bin/lib/files.mjs (FAC-85, fix 8): the write through a temporary file and a rename, the private folder, and the JSON object read that
// is absent only when there is no file. setJsonKey is checked through markOnboarded (packs/pstack/test/lead-start.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDir, readJsonObject, writeAtomic } from '../bin/lib/files.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'files-'));

test('writeAtomic replaces the file whole with the mode asked, and leaves no temporary file, after a write or a failed one', () => {
  const dir = folder();
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'old\n');
    chmodSync(file, 0o644);
    writeAtomic(file, 'new\n', { mode: 0o600 });
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['state.json']);
    // A temporary file an earlier run of this pid left behind is made afresh, not refused.
    writeFileSync(join(dir, `.state.json.${process.pid}.tmp`), 'leftover');
    writeAtomic(file, 'newer\n');
    assert.equal(readFileSync(file, 'utf8'), 'newer\n');
    assert.deepEqual(readdirSync(dir), ['state.json']);
    // A rename onto a folder fails: the error is thrown and the temporary file goes with it.
    mkdirSync(join(dir, 'taken'));
    assert.throws(() => writeAtomic(join(dir, 'taken'), 'x'));
    assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'taken']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('privateDir sets mode 700, and with refuseLink refuses a symlink before making anything', () => {
  const dir = folder();
  try {
    const store = join(dir, 'store');
    mkdirSync(store, { mode: 0o755 });
    privateDir(store);
    assert.equal(statSync(store).mode & 0o777, 0o700);
    const elsewhere = join(dir, 'elsewhere');
    const link = join(dir, 'link');
    symlinkSync(elsewhere, link);
    assert.throws(() => privateDir(link, { refuseLink: true }), /is a symlink/);
    assert.equal(existsSync(elsewhere), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonObject is absent only when there is no file: a file it cannot read, or that holds no JSON object, throws', () => {
  const dir = folder();
  try {
    assert.equal(readJsonObject(join(dir, 'none.json')), undefined);
    assert.throws(() => readJsonObject(dir), { code: 'EISDIR' });
    for (const text of ['{not json', '[1]', 'null', '3']) {
      writeFileSync(join(dir, 'bad.json'), text);
      assert.throws(() => readJsonObject(join(dir, 'bad.json')), { code: 'ENOTOBJECT' }, text);
    }
    writeFileSync(join(dir, 'good.json'), '{"a":1}');
    assert.deepEqual(readJsonObject(join(dir, 'good.json')), { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
