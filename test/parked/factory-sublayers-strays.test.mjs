// #82 fix round 1, B1: only the 17 labels of the list count as a sublayer; any other sublayer-* label is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, issue } from './sublayers-gh.mjs';

test('an issue whose only sublayer-* label is not on the list has no sublayer label', async () => {
  const run = await fake({ issues: [issue(5, 'task', 'sublayer-9z')] });
  const r = run();
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /^issue #5 \(Issue 5\): no sublayer label$/m);
  assert.match(r.out, /^not on the list: sublayer-9z$/m);
  assert.doesNotMatch(r.out, /in order/);
});

test('a label on the list next to a stray one counts once, and the stray is reported', async () => {
  const run = await fake({ issues: [issue(6, 'sublayer-1a', 'sublayer-1f')] });
  const r = run();
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.out, /^issue #6/m);
  assert.match(r.out, /^not on the list: sublayer-1f$/m);
});

test('a stray sublayer-* label in the repository is reported, exit 1', async () => {
  const run = await fake({ labels: (right) => [...right, { name: 'sublayer-1f', description: '1f Old' }] });
  const r = run();
  assert.equal(r.status, 1);
  assert.equal(r.out, 'not on the list: sublayer-1f\n');
});

test('a stray on the repository and on two issues is reported once', async () => {
  const run = await fake({
    labels: (right) => [...right, { name: 'sublayer-1f', description: '' }],
    issues: [issue(1, 'sublayer-1a', 'sublayer-1f'), issue(2, 'sublayer-4b', 'sublayer-1f')],
  });
  const r = run();
  assert.equal(r.out.match(/not on the list: sublayer-1f/g).length, 1);
});
