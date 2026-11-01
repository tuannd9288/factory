// bin/lib/names.mjs (#286): the animals of Ubuntu's release code names, and the first one not taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANIMALS, firstFree } from '../bin/lib/names.mjs';

test('the list is the 45 animals of the released code names, in alphabetical order, each a plain name', () => {
  assert.equal(ANIMALS.length, 45);
  assert.deepEqual([...ANIMALS], [...ANIMALS].sort());
  assert.equal(new Set(ANIMALS).size, 45);
  assert.ok(ANIMALS.every((a) => /^[a-z]+$/.test(a)));
  assert.ok(!ANIMALS.includes('trex'));
});

test('parseTeam splits <repo>-<team> at the last dash, the team in the grammar, and takes nothing else (#311)', async () => {
  const { parseTeam } = await import('../bin/lib/names.mjs');
  assert.deepEqual(parseTeam('zalo-lead'), { repo: 'zalo', team: 'lead' });
  assert.deepEqual(parseTeam('factory-probe-b2'), { repo: 'factory-probe', team: 'b2' });
  assert.deepEqual(parseTeam('a.b_c-x'), { repo: 'a.b_c', team: 'x' });
  for (const bad of ['probe', 'probe-Alpha', '-alpha', 'probe-', 'probe-1a', 'seat-1', 'a b-c', 'a/b-c', '..-x', 'a--x', '', undefined, null, 'x-'.concat('y'.repeat(33))]) assert.equal(parseTeam(bad), null, String(bad));
});

test('firstFree gives the first name in list order that is not taken', () => {
  assert.equal(firstFree(new Set()), 'aardvark');
  assert.equal(firstFree(new Set(['aardvark', 'badger'])), 'beaver');
  assert.equal(firstFree(['aardvark']), 'badger');
});

test('with every animal taken, firstFree numbers the list again; no two live names are equal', () => {
  const taken = new Set(ANIMALS);
  const next = firstFree(taken);
  assert.equal(next, 'aardvark2');
  assert.equal(firstFree(new Set([...taken, next])), 'badger2');
});
