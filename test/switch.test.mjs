// #333: the merge switch of a repository, the two review parameters of the rules in force on its main. The pure reading
// (kit/.gate/bin/lib/switch.mjs, which the gate, the queue and bin/onboard-owner share) and its CLI. The queue following the
// switch is in test/switch-queue.test.mjs, the gate's tier branch in test/kit.test.mjs, bin/onboard-owner's in
// test/owner.test.mjs and the doctor's in test/doctor.test.mjs. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { PARAMETERS, pagesOf, positionOf } from '../kit/.gate/bin/lib/switch.mjs';

const rule = (count, owner) => ({ type: 'pull_request', parameters: { required_approving_review_count: count, require_code_owner_review: owner } });

test('each position is read from the two review parameters, the count first', () => {
  assert.equal(positionOf([rule(0, false)]), 'all');
  assert.equal(positionOf([rule(0, true)]), '1-2');
  assert.equal(positionOf([rule(1, false)]), 'none');
  assert.equal(positionOf([rule(1, true)]), 'none');
  assert.equal(positionOf([rule(2, false)]), 'none');
});

test('no pull_request rule in force reads as 1-2, the position of a switch nobody set', () => {
  assert.equal(positionOf([]), '1-2');
  assert.equal(positionOf([{ type: 'deletion' }, { type: 'non_fast_forward' }]), '1-2');
});

test('the bootstrap ruleset and the factory\'s own read as none; the kit\'s gate reads as 1-2', () => {
  const read = (path) => JSON.parse(readFileSync(join(factory, path), 'utf8')).rules;
  assert.equal(positionOf(read('bin/rulesets/bootstrap.json')), 'none');
  assert.equal(positionOf(read('.github/ruleset.json')), 'none');
  assert.equal(positionOf(read('kit/.gate/ruleset.json')), '1-2');
});

test('two pull_request rules apply together: the largest count, and any code-owner requirement', () => {
  assert.equal(positionOf([rule(0, false), rule(0, true)]), '1-2');
  assert.equal(positionOf([rule(0, false), rule(1, false)]), 'none');
  assert.equal(positionOf([rule(0, true), rule(0, false), { type: 'deletion' }]), '1-2');
  assert.equal(positionOf([rule(0, false), rule(0, false)]), 'all');
});

test('rules that cannot be read are an error, never a position', () => {
  for (const bad of [null, {}, 'x', [{ type: 'pull_request' }], [{ type: 'pull_request', parameters: {} }], [rule(0, 'yes')], [rule('0', false)], [rule(-1, false)], [rule(0, false), { type: 'pull_request', parameters: { require_code_owner_review: false } }]])
    assert.throws(() => positionOf(bad), Error, JSON.stringify(bad));
});

test('an error names the value it met, not only the field', () => {
  assert.throws(() => positionOf([rule('1', false)]), /required_approving_review_count "1"/);
  assert.throws(() => positionOf([rule(0, 'yes')]), /require_code_owner_review "yes"/);
  assert.throws(() => positionOf([{ type: 'pull_request', parameters: {} }]), /required_approving_review_count unset/);
  assert.throws(() => positionOf({ message: 'Not Found' }), /not a list: \{"message":"Not Found"\}/);
});

test('the pages of a paginated read are one list of rules', () => {
  assert.equal(positionOf(pagesOf([[rule(0, false)], [rule(1, true)]])), 'none');
  assert.equal(positionOf(pagesOf([[]])), '1-2');
  assert.equal(positionOf(pagesOf([rule(0, false)])), 'all');
  assert.equal(pagesOf('x'), 'x');
});

test('the parameters --merge sets read back as the position they were chosen for', () => {
  assert.deepEqual(Object.keys(PARAMETERS).sort(), ['1-2', 'all', 'none']);
  for (const [position, parameters] of Object.entries(PARAMETERS)) assert.equal(positionOf([{ type: 'pull_request', parameters }]), position);
});

test('the CLI reads the rules\' JSON on stdin and prints the position, or why it could not, exit 2', () => {
  const cli = (input) => spawnSync('node', [join(factory, 'kit/.gate/bin/lib/switch.mjs')], { input, encoding: 'utf8' });
  for (const [rules, position] of [[[rule(0, false)], 'all'], [[rule(0, true)], '1-2'], [[rule(1, true)], 'none'], [[], '1-2']]) {
    const out = cli(JSON.stringify(rules));
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `${position}\n`);
  }
  const pages = cli(JSON.stringify([[rule(0, false)], [rule(0, true)]]));
  assert.equal(pages.status, 0, pages.stderr);
  assert.equal(pages.stdout, '1-2\n', 'the pages gh api --paginate --slurp gives');
  for (const bad of ['', 'not json', '{}', JSON.stringify([{ type: 'pull_request', parameters: {} }])]) {
    const out = cli(bad);
    assert.equal(out.status, 2, bad);
    assert.ok((out.stdout + out.stderr).trim().length > 0, 'it says why');
    assert.doesNotMatch(out.stdout.trim(), /^(all|1-2|none)$/);
  }
});
