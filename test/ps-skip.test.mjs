// test/ps-skip.mjs (#183): a test skips only with the sandbox marker and a ps that fails with EPERM. The ps is a fake result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PS_SKIP_REASON, psSkip } from './ps-skip.mjs';

const fails = (props) => () => {
  throw Object.assign(new Error('ps failed'), props);
};
const works = () => Buffer.from('Mon Jan  1 00:00:00 2001\n');

test('with the marker and a ps that fails with EPERM, the skip has its exact reason', () => {
  assert.equal(PS_SKIP_REASON, 'ps is refused in the factory\'s sandbox (#183)');
  assert.equal(psSkip({ env: { FACTORY_SANDBOX: '1' }, ps: fails({ code: 'EPERM' }) }), PS_SKIP_REASON);
  assert.equal(psSkip({ env: { FACTORY_SANDBOX: '1' }, ps: fails({ status: 1, stderr: Buffer.from('ps: Operation not permitted\n') }) }), PS_SKIP_REASON);
});

test('without the marker, a ps that fails with EPERM is no skip', () => {
  assert.equal(psSkip({ env: {}, ps: fails({ code: 'EPERM' }) }), false);
  assert.equal(psSkip({ env: { FACTORY_SANDBOX: '0' }, ps: fails({ code: 'EPERM' }) }), false);
});

test('with the marker and a ps that works, or fails some other way, nothing skips', () => {
  assert.equal(psSkip({ env: { FACTORY_SANDBOX: '1' }, ps: works }), false);
  assert.equal(psSkip({ env: { FACTORY_SANDBOX: '1' }, ps: fails({ code: 'ENOENT' }) }), false);
});

test('ps is asked about the test\'s own pid', () => {
  const asked = [];
  psSkip({ env: { FACTORY_SANDBOX: '1' }, ps: (pid) => asked.push(pid) });
  assert.deepEqual(asked, [process.pid]);
});
