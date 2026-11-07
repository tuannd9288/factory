// INN-39, contract H7: every role's model and effort come from one table, bin/lib/models.json (the gate's reviewer from the kit's own
// kit/.gate/bin/lib/reviewer.json), and no launcher names a model of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const models = () => import('../bin/lib/models.mjs');

// A model written as a whole string: an alias Claude Code takes, or a model id of Claude, GPT or Gemini.
const MODEL = /(['"`])(opus|sonnet|haiku|fable|claude-(?:opus|sonnet|haiku|fable)[a-z0-9.-]*|gpt-[a-z0-9.-]+|(?:[a-z0-9-]+\/)?gemini-[a-z0-9.-]+)\1/gi;
/** Each model written as a whole string in a source file's text, as `<line>: <string>`. */
const modelsIn = (text) => text.split('\n').flatMap((line, i) => [...line.matchAll(MODEL)].map((m) => `${i + 1}: ${m[0]}`));

test('no launcher names a model of its own: no source file under bin/, packs/pstack/bin/ or kit/.gate/bin/ holds one as a string', () => {
  // The scope is the launchers' source folders, not a list of exceptions: a price list, a test or a comment is no launcher.
  assert.deepEqual(modelsIn("const m = 'opus';\n// opus, high\nspawn('x', ['--model', \"claude-opus-5-5\"]);"), ["1: 'opus'", '3: "claude-opus-5-5"'], 'the scan finds a planted model');
  const files = execFileSync('git', ['ls-files', 'bin', 'packs/pstack/bin', 'kit/.gate/bin'], { cwd: factory, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 20, files.join(' '));
  const found = files.flatMap((f) => modelsIn(readFileSync(join(factory, f), 'utf8')).map((hit) => `${f}:${hit}`));
  assert.deepEqual(found, []);
});

test('every seat, the pack Lead and the Watcher take their model and effort from the table', async () => {
  const { MODELS, claudeModelArgs } = await models();
  const { ROLES, buildArgs } = await import('../bin/lib/seat.mjs');
  for (const role of ROLES) {
    const args = buildArgs({ role, run: '/r/issue-1', home: '/h', work: '/r/w' });
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4), claudeModelArgs(MODELS.seats[role]), role);
  }
  const { leadArgs } = await import('../packs/pstack/bin/lead.mjs');
  const { argv } = leadArgs({ repo: 'app', team: 'lead', home: '/h', root: '/f', roleText: 'role', node: '/opt/homebrew/bin/node' });
  assert.deepEqual(argv.slice(argv.indexOf('claude') + 1, argv.indexOf('claude') + 5), claudeModelArgs(MODELS.lead));
  const { loadSetting, SETTING_FILE } = await import('../bin/lib/reader.mjs');
  const { side, sides } = MODELS.watcher;
  assert.deepEqual(loadSetting(SETTING_FILE), { side, ...sides[side] });
});

test('an entry of inherit passes no model or effort, so the harness default applies', async () => {
  const { claudeModelArgs } = await models();
  assert.deepEqual(claudeModelArgs({ model: 'inherit', effort: 'inherit' }), []);
  assert.deepEqual(claudeModelArgs({ model: 'x', effort: 'inherit' }), ['--model', 'x']);
  assert.deepEqual(claudeModelArgs({ model: 'x', effort: 'high' }), ['--model', 'x', '--effort', 'high']);
});

test('a Lead profile\'s rules/pstack-models.md is the table\'s pstack lines, rendered in pstack\'s own rule-file shape', async () => {
  const { MODELS, pstackModels } = await models();
  const lines = pstackModels().split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, Object.entries(MODELS.pstack.roles).map(([role, value]) => `${role}: ${value}`));
  assert.match(pstackModels(), new RegExp(`^# budget: ${MODELS.pstack.budget.replace(/[()]/g, '\\$&')}$`, 'm'));
});
