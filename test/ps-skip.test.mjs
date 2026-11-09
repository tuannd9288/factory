// test/ps-skip.mjs (#183): a test skips only on a ps that fails with EPERM, and never where CI is set. The ps is a fake result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PS_SKIP_REASON, psSkip } from './ps-skip.mjs';

const fails = (props) => () => {
  throw Object.assign(new Error('ps failed'), props);
};
const works = () => Buffer.from('Mon Jan  1 00:00:00 2001\n');

test('a ps that fails with EPERM skips, with its exact reason', () => {
  assert.equal(PS_SKIP_REASON, 'ps is refused in the factory\'s sandbox (#183)');
  assert.equal(psSkip({ env: {}, ps: fails({ code: 'EPERM' }) }), PS_SKIP_REASON);
  assert.equal(psSkip({ env: {}, ps: fails({ status: 1, stderr: Buffer.from('ps: Operation not permitted\n') }) }), PS_SKIP_REASON);
});

test('where CI is set, a ps that fails with EPERM is no skip', () => {
  assert.equal(psSkip({ env: { CI: 'true' }, ps: fails({ code: 'EPERM' }) }), false);
});

test('a ps that works, or fails some other way, skips nothing', () => {
  assert.equal(psSkip({ env: {}, ps: works }), false);
  assert.equal(psSkip({ env: {}, ps: fails({ code: 'ENOENT' }) }), false);
});

test('ps is asked about the test\'s own pid', () => {
  const asked = [];
  psSkip({ env: {}, ps: (pid) => asked.push(pid) });
  assert.deepEqual(asked, [process.pid]);
});
