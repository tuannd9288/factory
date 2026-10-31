// bin/seat (#92): --deny <rule> adds a rule to the preset's --disallowedTools, so a run can switch off one tool (the research
// eval's arm B has no Agent tool) without a change to any preset's grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { until, world } from './seat-world.mjs';

const lib = () => import('../bin/lib/seat.mjs');
const denied = (args) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format'));

test('deny rules come after the preset\'s own, and before the three profiles rules; the grants stay as they were', async () => {
  const { buildArgs } = await lib();
  const plain = buildArgs({ role: 'researcher', run: '/r', home: '/h', seat: 1, profiles: '/p' });
  const withDeny = buildArgs({ role: 'researcher', run: '/r', home: '/h', seat: 1, profiles: '/p', deny: ['Agent', 'Task'] });
  const base = denied(plain);
  const rules = denied(withDeny);
  assert.deepEqual(rules.slice(0, base.length - 3), base.slice(0, -3));
  assert.deepEqual(rules.slice(base.length - 3, base.length - 1), ['Agent', 'Task']);
  assert.deepEqual(rules.slice(base.length - 1), base.slice(-3));
  assert.deepEqual(withDeny.slice(0, withDeny.indexOf('--disallowedTools')), plain.slice(0, plain.indexOf('--disallowedTools')));
});

test('--deny is repeatable, and a value that starts with a dash is refused like --allow\'s', async () => {
  const { parseArgs } = await lib();
  // A folder must be its own real path (#192), so a real one stands for run and work.
  const dir = realpathSync(tmpdir());
  const o = parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir, '--deny', 'Agent', '--deny', 'Task']);
  assert.deepEqual(o.deny, ['Agent', 'Task']);
  assert.deepEqual(parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir]).deny, []);
  assert.throws(() => parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir, '--deny', '--model']), /--deny --model: a value that starts with a dash is refused/);
  assert.throws(() => parseArgs(['researcher', 'b.md', '--run', dir, '--work', dir, '--deny']), /--deny needs a value/);
});

test('bin/seat passes --deny on to claude', () => world(async (w) => {
  const r = w.start('researcher', ['--deny', 'Agent', '--deny', 'Task']);
  assert.equal(r.code, 0, r.out + r.err);
  await until(() => w.records().length === 1, 'the record');
  const rules = denied(w.saw().argv);
  assert.deepEqual(rules.slice(-5, -3), ['Agent', 'Task'], 'before the three rules for the tokens, the archive and the old seat 1 file');
}));
