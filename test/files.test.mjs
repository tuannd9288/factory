// bin/lib/files.mjs (FAC-85, fix 8): the write through a temporary file and a rename, the private folder, and the JSON object read that
// is absent only when there is no file. setJsonKey is checked through markOnboarded (packs/pstack/test/lead-start.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, threadId } from 'node:worker_threads';
import { privateDir, readJsonObject, writeAtomic } from '../bin/lib/files.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'files-'));
/** The temporary file writeAtomic uses for `name` in this process and thread. */
const tmpOf = (dir, name) => join(dir, `.${name}.${process.pid}.${threadId}.tmp`);

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
    writeFileSync(tmpOf(dir, 'state.json'), 'leftover');
    writeAtomic(file, 'newer\n');
    assert.equal(readFileSync(file, 'utf8'), 'newer\n');
    assert.deepEqual(readdirSync(dir), ['state.json']);
    // A symlink planted at the temporary path is removed, never written through.
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'kept'), 'kept\n');
    symlinkSync(join(outside, 'kept'), tmpOf(dir, 'state.json'));
    writeAtomic(file, 'newest\n');
    assert.equal(readFileSync(join(outside, 'kept'), 'utf8'), 'kept\n');
    assert.equal(readFileSync(file, 'utf8'), 'newest\n');
    rmSync(outside, { recursive: true });
    // The mode asked is the mode the file gets, whatever the umask.
    const umask = process.umask(0o077);
    try {
      writeAtomic(file, 'open\n', { mode: 0o644 });
    } finally {
      process.umask(umask);
    }
    assert.equal(statSync(file).mode & 0o777, 0o644);
    // A rename onto a folder fails: the error is thrown and the temporary file goes with it.
    mkdirSync(join(dir, 'taken'));
    assert.throws(() => writeAtomic(join(dir, 'taken'), 'x'));
    assert.deepEqual(readdirSync(dir).sort(), ['state.json', 'taken']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two threads of one process writing one file each write it whole, and neither throws', async () => {
  // Worker threads share a pid, and the daemon runs each pass in one (bin/lib/daemon.mjs).
  const dir = folder();
  try {
    const file = join(dir, 'shared.json');
    const code = `const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { writeAtomic } = await import(workerData.url);
  let errors = 0;
  for (let i = 0; i < 1000; i++) {
    try { writeAtomic(workerData.file, workerData.text); } catch { errors += 1; }
  }
  parentPort.postMessage(errors);
})();`;
    const url = new URL('../bin/lib/files.mjs', import.meta.url).href;
    const run = (text) => new Promise((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData: { url, file, text } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    assert.deepEqual(await Promise.all([run('a\n'), run('b\n')]), [0, 0]);
    assert.match(readFileSync(file, 'utf8'), /^[ab]\n$/);
    assert.deepEqual(readdirSync(dir), ['shared.json']);
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
