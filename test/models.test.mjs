// INN-39, contract H7: each launcher takes its model and effort from the table it is given: the factory's one table, bin/lib/models.json,
// for every role that runs from the factory checkout, and the kit's own pin for the gate's reviewer (test/claude-reviewer.test.mjs). The
// launchers here get a made-up table, so every expectation is written out, never read from models.json; the approved defaults are one
// matrix of their own. The MacBook Lead, Colly and `factory codex` get theirs in test/factory-here, test/factory-colly and
// packs/pstack/test/codex-step. The Watcher keeps its own frozen setting, bin/lib/reader.json, tested by test/reader.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const { MODELS, entryOf, pstackModels } = await import('../bin/lib/models.mjs');
const { buildArgs } = await import('../bin/lib/seat.mjs');
const { leadArgs, writeModels } = await import('../packs/pstack/bin/lead.mjs');

// Every role a model and effort no other role has, so a launcher that reads another role's entry fails.
const SYNTHETIC = {
  seats: {
    worker: { model: 'mock-worker', effort: 'workereffort' },
    reviewer: { model: 'mock-reviewer', effort: 'reviewereffort' },
    researcher: { model: 'mock-researcher', effort: 'researchereffort' },
  },
  lead: { remote: { model: 'mock-lead-remote', effort: 'remoteeffort' }, here: { model: 'mock-lead-here', effort: 'hereeffort' } },
  pstack: { budget: 'mock budget', roles: { 'mock role': 'mock value', 'other role': 'inherit-parent' } },
};
const SEAT = { run: '/r/issue-1', home: '/h', work: '/r/w' };
const LEAD = { repo: 'app', team: 'lead', home: '/h', root: '/f', roleText: 'role', node: '/n' };

test('each seat and the pack Lead pass their own entry of the table they are given', () => {
  assert.deepEqual(buildArgs({ role: 'worker', ...SEAT, models: SYNTHETIC }).slice(0, 6), ['-p', '--model', 'mock-worker', '--effort', 'workereffort', '--max-turns']);
  assert.deepEqual(buildArgs({ role: 'reviewer', ...SEAT, models: SYNTHETIC }).slice(0, 6), ['-p', '--model', 'mock-reviewer', '--effort', 'reviewereffort', '--max-turns']);
  assert.deepEqual(buildArgs({ role: 'researcher', ...SEAT, resume: 'sid-1', models: SYNTHETIC }).slice(0, 8), ['-p', '--resume', 'sid-1', '--model', 'mock-researcher', '--effort', 'researchereffort', '--max-turns']);
  // lead.remote, never lead.here: the two stay apart until the Human chooses one value.
  assert.deepEqual(leadArgs({ ...LEAD, models: SYNTHETIC }).argv.slice(3, 9), ['claude', '--model', 'mock-lead-remote', '--effort', 'remoteeffort', '--append-system-prompt']);
});

test('inherit, or a key left out, passes no model or effort, so the harness default applies', () => {
  const table = {
    seats: { worker: { model: 'inherit', effort: 'inherit' }, reviewer: {}, researcher: { model: 'mock-researcher' } },
    lead: { remote: { effort: 'remoteeffort' } },
  };
  assert.deepEqual(buildArgs({ role: 'worker', ...SEAT, models: table }).slice(0, 3), ['-p', '--max-turns', '400']);
  assert.deepEqual(buildArgs({ role: 'reviewer', ...SEAT, models: table }).slice(0, 3), ['-p', '--max-turns', '300']);
  assert.deepEqual(buildArgs({ role: 'researcher', ...SEAT, models: table }).slice(0, 4), ['-p', '--model', 'mock-researcher', '--max-turns']);
  assert.deepEqual(leadArgs({ ...LEAD, models: table }).argv.slice(3, 7), ['claude', '--effort', 'remoteeffort', '--append-system-prompt']);
});

test('a missing role, the old flat shape, or a value that is empty or starts with - is refused, naming the role; any other value passes as written', () => {
  assert.throws(() => buildArgs({ role: 'worker', ...SEAT, models: {} }), /no entry for seats\.worker/);
  assert.throws(() => buildArgs({ role: 'reviewer', ...SEAT, models: { seats: { worker: {} } } }), /no entry for seats\.reviewer/);
  assert.throws(() => buildArgs({ role: 'nobody', ...SEAT, models: SYNTHETIC }), /unknown role nobody/);
  // A value that would reach claude as an option of its own.
  assert.throws(() => buildArgs({ role: 'worker', ...SEAT, models: { seats: { worker: { model: '--dangerously-skip-permissions' } } } }), /seats\.worker has no usable model/);
  assert.throws(() => buildArgs({ role: 'worker', ...SEAT, models: { seats: { worker: { model: 'mock', effort: '--verbose' } } } }), /seats\.worker has no usable effort/);
  assert.throws(() => buildArgs({ role: 'worker', ...SEAT, models: { seats: { worker: { model: '' } } } }), /seats\.worker has no usable model/);
  // A model Claude Code 2.1.319 takes that no name pattern foresaw, as seatworks-v3 takes any non-empty string (4c35563, roles.ts:13).
  assert.deepEqual(buildArgs({ role: 'worker', ...SEAT, models: { seats: { worker: { model: 'sonnet[1m]', effort: 'high' } } } }).slice(0, 6), ['-p', '--model', 'sonnet[1m]', '--effort', 'high', '--max-turns']);
  assert.throws(() => leadArgs({ ...LEAD, models: { lead: { model: 'mock-lead', effort: 'high' } } }), /no entry for lead\.remote/);
  assert.throws(() => leadArgs({ ...LEAD, models: { lead: { here: { model: 'mock-lead-here' } } } }), /no entry for lead\.remote/);
  assert.throws(() => pstackModels(undefined), /no usable entry for pstack/);
  assert.throws(() => pstackModels({ budget: 'b', roles: { r: 'v\nsneaked: line' } }), /no usable entry for pstack/);
});

test('a Lead profile\'s rules/pstack-models.md is the given table\'s pstack lines, in pstack\'s own rule-file shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'models-'));
  try {
    writeModels(dir, SYNTHETIC);
    const text = readFileSync(join(dir, 'rules/pstack-models.md'), 'utf8');
    assert.deepEqual(text.split('\n').filter((l) => l && !l.startsWith('#')), ['mock role: mock value', 'other role: inherit-parent']);
    assert.match(text, /^# budget: mock budget$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the approved defaults: changing one is the Human\'s, by a pull request that changes this matrix too', () => {
  const roles = { worker: ['seats', 'worker'], reviewer: ['seats', 'reviewer'], researcher: ['seats', 'researcher'], 'lead.remote': ['lead', 'remote'], 'lead.here': ['lead', 'here'], colly: ['colly'], codex: ['codex'] };
  const inherit = { model: 'inherit', effort: 'inherit' };
  assert.deepEqual(Object.fromEntries(Object.entries(roles).map(([name, path]) => [name, entryOf(MODELS, ...path)])), {
    worker: { model: 'sonnet', effort: 'medium' },
    reviewer: { model: 'opus', effort: 'high' },
    researcher: { model: 'opus', effort: 'high' },
    'lead.remote': { model: 'opus', effort: 'high' },
    'lead.here': inherit,
    colly: inherit,
    codex: inherit,
  });
  assert.deepEqual(MODELS.pstack, {
    budget: 'large (xhigh)',
    roles: {
      'feature, refactoring': 'inherit-parent',
      'bug-fix': 'inherit-parent',
      'perf-issue': 'inherit-parent',
      hillclimb: 'inherit-parent',
      'judgment and prose': 'opus xhigh',
      'hardest tasks': 'opus xhigh',
      'how explorer': 'inherit-parent',
      'how explainer': 'opus xhigh',
      'why investigators': 'inherit-parent',
      'why synthesizer': 'opus xhigh',
      'reflect tooling': 'inherit-parent',
      'reflect judgment, divergent, synthesizer': 'opus xhigh',
      'arena runners': 'opus xhigh, codex high',
      'arena cross-judge pool': 'codex high',
      'swarm workers': 'inherit-parent',
      'architect runners': 'opus xhigh, codex high',
      'interrogate reviewers': 'opus xhigh, codex high',
    },
  });
});

// A model written as a whole string: an alias Claude Code takes, or a model id of Claude, GPT or Gemini.
const MODEL = /(['"`])(opus|sonnet|haiku|fable|claude-(?:opus|sonnet|haiku|fable)[a-z0-9.-]*|gpt-[a-z0-9.-]+|(?:[a-z0-9-]+\/)?gemini-[a-z0-9.-]+)\1/gi;
/** Each model written as a whole string in a source file's text, as `<line>: <string>`. */
const modelsIn = (text) => text.split('\n').flatMap((line, i) => [...line.matchAll(MODEL)].map((m) => `${i + 1}: ${m[0]}`));
// The files that build a model's argv. A launcher in a file not listed here is not scanned; review catches it.
const LAUNCHERS = ['bin/lib/seat.mjs', 'packs/pstack/bin/lead.mjs', 'bin/lib/factory.mjs', 'bin/lib/reader.mjs', 'packs/pstack/bin/codex-step.mjs', 'kit/.gate/bin/lib/claude-reviewer.mjs'];

test('no file that builds a model\'s argv names a model of its own', () => {
  assert.deepEqual(modelsIn("const m = 'opus';\n// opus, high\nspawn('x', ['--model', \"claude-opus-5-5\"]);"), ["1: 'opus'", '3: "claude-opus-5-5"'], 'the scan finds a planted model');
  const found = LAUNCHERS.flatMap((f) => {
    assert.ok(existsSync(join(factory, f)), `${f} is gone: list the file that builds its argv now`);
    return modelsIn(readFileSync(join(factory, f), 'utf8')).map((hit) => `${f}:${hit}`);
  });
  assert.deepEqual(found, []);
});
