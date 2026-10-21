// The probe driver, read as text: nothing here opens a pull request or runs a probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const probes = join(factory, 'probes');
const read = (name) => (existsSync(join(probes, name)) ? readFileSync(join(probes, name), 'utf8') : '');

test('every probe of plan.md has one builder, and every builder a row of plan.md', () => {
  const planned = [...read('plan.md').matchAll(/^\| ([CD]\d+) \|/gm)].map((m) => m[1]).sort();
  const built = [...read('probes.sh').matchAll(/^p_([CD]\d+)\(\)/gm)].map((m) => m[1]).sort();
  assert.equal(planned.length, 40);
  assert.deepEqual(built, planned);
});

test('the driver parses, takes the scratch repository as input, and evaluates no text', () => {
  for (const name of ['drive.sh', 'probes.sh', 'run.sh', 'dry.sh', 'wait.sh', 'tree.sh']) {
    const text = read(name);
    assert.ok(text, `probes/${name} is missing`);
    assert.equal(spawnSync('bash', ['-n', join(probes, name)]).status, 0, `probes/${name} does not parse`);
    assert.doesNotMatch(text, /^[^#]*\beval\b/m, `probes/${name} evaluates text`);
    assert.doesNotMatch(text, /tuannd9288\/factory-scratch/, `probes/${name} names the repository`);
  }
});
