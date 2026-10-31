// packs/pstack/bin/transcript-copy.mjs (#185): the Lead's Stop and SessionEnd hook copies the transcript its input names, and only
// that, out of the profile. It always exits 0.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../bin/transcript-copy.mjs', import.meta.url));

/** A profile with one transcript, and a way to run the hook on an input. */
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'transcript-copy-'));
  const config = join(root, 'profile');
  const dest = join(root, 'copies/transcripts');
  const folder = join(config, 'projects/-repo');
  mkdirSync(folder, { recursive: true });
  const source = join(folder, 'abc.jsonl');
  writeFileSync(source, '{"line":1}\n');
  const hook = (input, { configDir = config } = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, dest], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir } });
    return { code: r.status, err: r.stderr };
  };
  try {
    return body({ root, config, dest, source, hook });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('transcript-copy', () => {
  test('copies the named transcript to <dest>/<basename> by rename, at mode 600 in a 700 folder, with the source mtime', () => fixture(({ dest, source, hook }) => {
    utimesSync(source, 1700000000, 1700000000);
    const r = hook({ transcript_path: source, hook_event_name: 'Stop' });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '');
    assert.equal(readFileSync(join(dest, 'abc.jsonl'), 'utf8'), '{"line":1}\n');
    assert.deepEqual(readdirSync(dest), ['abc.jsonl'], 'no temporary name is left');
    assert.equal(statSync(dest).mode & 0o777, 0o700);
    assert.equal(statSync(join(dest, 'abc.jsonl')).mode & 0o777, 0o600);
    assert.equal(Math.round(statSync(join(dest, 'abc.jsonl')).mtimeMs), 1700000000000);
  }));

  test('a changed source is copied again; an unchanged one is not', () => fixture(({ dest, source, hook }) => {
    hook({ transcript_path: source });
    const copy = join(dest, 'abc.jsonl');
    const first = statSync(copy).ino;
    hook({ transcript_path: source });
    assert.equal(statSync(copy).ino, first, 'the same copy stays: a rename would give a new inode');
    writeFileSync(source, '{"line":1}\n{"line":2}\n');
    hook({ transcript_path: source });
    assert.notEqual(statSync(copy).ino, first, 'the copy is replaced by rename');
    assert.equal(readFileSync(copy, 'utf8'), '{"line":1}\n{"line":2}\n');
  }));

  test('refuses a path outside projects/, a symlink, a relative path and a folder, with exit 0 and no copy', () => fixture(({ root, config, dest, source, hook }) => {
    const outside = join(root, 'secret.jsonl');
    writeFileSync(outside, 'secret');
    writeFileSync(join(config, 'oauth'), 'secret');
    symlinkSync(outside, join(config, 'projects/-repo/link.jsonl'));
    symlinkSync(outside, join(root, 'dirlink'));
    for (const path of [outside, join(config, 'oauth'), join(config, 'projects/-repo/link.jsonl'), join(root, 'dirlink'), 'projects/-repo/abc.jsonl', join(config, 'projects/-repo'), join(config, 'projects/-repo/missing.jsonl'), 42, null]) {
      const r = hook({ transcript_path: path });
      assert.equal(r.code, 0, String(path));
      assert.match(r.err, /^transcript-copy: /, String(path));
    }
    assert.ok(!existsSync(dest) || readdirSync(dest).length === 0);
    // A file in another profile's projects/ is outside this one's.
    const other = join(root, 'other/projects/p');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.jsonl'), 'x');
    assert.match(hook({ transcript_path: join(other, 'x.jsonl') }).err, /not under/);
    assert.ok(!existsSync(dest) || readdirSync(dest).length === 0);
    assert.ok(existsSync(source));
  }));

  test('a path that reaches projects/ through a symlinked folder, but ends outside, is refused', () => fixture(({ root, config, dest, hook }) => {
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, 'elsewhere/x.jsonl'), 'x');
    symlinkSync(join(root, 'elsewhere'), join(config, 'projects/hop'));
    assert.match(hook({ transcript_path: join(config, 'projects/hop/x.jsonl') }).err, /not under/);
    assert.ok(!existsSync(dest));
  }));

  test('exits 0 on every failure: bad JSON, no input, no path, no dest, no config dir', () => fixture(({ source, hook }) => {
    for (const input of ['not json', '', '{}', '[]', 'null']) {
      const r = hook(input);
      assert.equal(r.code, 0, input);
      assert.match(r.err, /^transcript-copy: /, input);
    }
    assert.match(hook({ transcript_path: source }, { configDir: 'relative' }).err, /CLAUDE_CONFIG_DIR/);
    const noDest = spawnSync(process.execPath, [SCRIPT], { input: '{}', encoding: 'utf8' });
    assert.equal(noDest.status, 0);
    assert.match(noDest.stderr, /usage/);
  }));

  test('a destination it cannot make is a message and exit 0', () => fixture(({ root, source, config }) => {
    writeFileSync(join(root, 'file'), 'x');
    const r = spawnSync(process.execPath, [SCRIPT, join(root, 'file/sub')], { input: JSON.stringify({ transcript_path: source }), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config } });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /^transcript-copy: /);
    assert.equal(lstatSync(source).isFile(), true);
  }));
});
