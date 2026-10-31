// #177: bin/install-factory makes ~/.local/bin/factory a symlink to this clone's bin/factory, and replaces nothing else. Each
// test runs it in a fixture home; nothing here touches the real ~/.local/bin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory, run } from './helpers.mjs';

const target = join(factory, 'bin/factory');

function home(f) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-install-'));
  try {
    return f(dir, (...args) => run(factory, 'bash', [join(factory, 'bin/install-factory'), ...args], { HOME: dir }), join(dir, '.local/bin/factory'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('makes ~/.local/bin/factory a symlink to the clone\'s bin/factory, and can be run again', () => home((dir, install, link) => {
  const r = install();
  assert.equal(r.code, 0, r.out);
  assert.equal(readlinkSync(link), target);
  const again = install();
  assert.equal(again.code, 0, again.out);
  assert.equal(readlinkSync(link), target);
  assert.ok(existsSync(link), 'the link reaches bin/factory');
}));

test('keeps the folder\'s other files, and an existing ~/.local/bin', () => home((dir, install, link) => {
  mkdirSync(join(dir, '.local/bin'), { recursive: true });
  writeFileSync(join(dir, '.local/bin/other'), 'x');
  assert.equal(install().code, 0);
  assert.equal(readFileSync(join(dir, '.local/bin/other'), 'utf8'), 'x');
  assert.equal(readlinkSync(link), target);
}));

test('refuses to replace a file, a folder, or a link that points anywhere else', () => home((dir, install, link) => {
  mkdirSync(join(dir, '.local/bin'), { recursive: true });
  writeFileSync(link, 'my own factory');
  let r = install();
  assert.notEqual(r.code, 0);
  assert.match(r.out, new RegExp(link.replace(/[.]/g, '\\.')));
  assert.equal(readFileSync(link, 'utf8'), 'my own factory');
  rmSync(link);
  mkdirSync(link);
  assert.notEqual(install().code, 0);
  assert.ok(lstatSync(link).isDirectory());
  rmSync(link, { recursive: true });
  symlinkSync('/somewhere/else/factory', link);
  r = install();
  assert.notEqual(r.code, 0);
  assert.equal(readlinkSync(link), '/somewhere/else/factory');
  rmSync(link);
  symlinkSync(join(dir, 'missing'), link);
  assert.notEqual(install().code, 0, 'a dangling link is not ours either');
  assert.equal(readlinkSync(link), join(dir, 'missing'));
}));

test('takes no argument', () => home((dir, install, link) => {
  assert.notEqual(install('--force').code, 0);
  assert.ok(!existsSync(join(dir, '.local')));
}));
