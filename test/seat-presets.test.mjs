// bin/seat (#91): the argument list each role's preset gives `claude -p`, pinned exactly. The presets come from the
// hand-written launchers of ~/factory-runs (worker and reviewer from run-90.sh, researcher from run-79.sh and run-71.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const lib = () => import('../bin/lib/seat.mjs');

const RUN = '/r/issue-1';
const WORK = '/r/w';
const HOME = '/h';
const SCHEMA = '{"type":"object","additionalProperties":false,"required":["conclusion","evidence","couldNotRead","needsLead","foundOutside","findings"],"properties":{"conclusion":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}},"couldNotRead":{"type":"array","items":{"type":"string"}},"needsLead":{"type":"array","items":{"type":"string"}},"foundOutside":{"type":"array","items":{"type":"string"}},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["kind","claim","blocking"],"properties":{"kind":{"type":"string","pattern":"^[a-z0-9]+(-[a-z0-9]+)*$","maxLength":40},"claim":{"type":"string"},"blocking":{"type":"boolean"}}}}}}';

const DENY = [
  'Bash(*factory account add*)', 'Bash(*factory store*)', 'Bash(*lib/factory.mjs account add*)', 'Bash(*lib/factory.mjs store*)',
  'Bash(*factory use*)', 'Bash(*factory account remove*)', 'Bash(*lib/factory.mjs use*)', 'Bash(*lib/factory.mjs account remove*)',
  'Bash(gh:*)', 'Bash(git push:*)', 'Bash(git config:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(curl:*)',
  'Bash(herdr:*)', 'Bash(/h/.local/bin/herdr:*)', 'Bash(env:*)', 'Bash(printenv:*)', 'WebFetch', 'WebSearch',
  'Read(~/.config/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)', 'Read(~/.agent-profiles/**)', 'Read(~/.ssh/**)', 'Read(~/.local/share/claude/**)',
  'Read(~/factory-runs/*/transcripts/**)',
  'Bash(security:*)', 'Bash(/usr/bin/security:*)',
];
// The researcher's own allow list, which it keeps while hideKey is true (#307).
const RESEARCHER_ALLOW = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', `Bash(${join(factory, 'bin/research-git')}:*)`, 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(date:*)', 'Bash(cd:*)'];
// Write, Edit and redirects only in the session's own folders: the run folder and the work folder (#188); the researcher's only.
const EDITS = ['Edit(//r/issue-1/**)', 'Edit(//r/w/**)'];

const ALERTS = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: join(factory, 'bin/factory-alerts'), timeout: 10 }] }] } });
// The worker's and the reviewer's settings add the sandbox (#183), whose content test/seat-sandbox.test.mjs pins.
const sandboxed = async () => {
  const { sandboxSettings } = await lib();
  return JSON.stringify({ ...JSON.parse(ALERTS), sandbox: sandboxSettings({ home: HOME, run: RUN, work: WORK }) });
};
const tail = ['--output-format', 'stream-json', '--verbose', '--json-schema', SCHEMA];

test('worker: sonnet, medium effort, 400 turns, auto mode, no role allow list and the common deny list (#307)', async () => {
  const { buildArgs } = await lib();
  assert.deepEqual(buildArgs({ role: 'worker', run: RUN, home: HOME, work: WORK }), [
    '-p', '--model', 'sonnet', '--effort', 'medium', '--max-turns', '400', '--permission-mode', 'auto',
    '--settings', await sandboxed(),
    '--add-dir', RUN,
    '--allowedTools', 'StructuredOutput',
    '--disallowedTools', ...DENY,
    ...tail,
  ]);
});

test('reviewer: opus, high effort, 300 turns, auto mode, no role allow list and the common deny list (#307)', async () => {
  const { buildArgs } = await lib();
  assert.deepEqual(buildArgs({ role: 'reviewer', run: RUN, home: HOME, work: WORK }), [
    '-p', '--model', 'opus', '--effort', 'high', '--max-turns', '300', '--permission-mode', 'auto',
    '--settings', await sandboxed(),
    '--add-dir', RUN,
    '--allowedTools', 'StructuredOutput',
    '--disallowedTools', ...DENY,
    ...tail,
  ]);
});

test('researcher: opus, high effort, 300 turns, the web and git only through bin/research-git, and no WebFetch or WebSearch deny', async () => {
  const { buildArgs } = await lib();
  assert.deepEqual(buildArgs({ role: 'researcher', run: RUN, home: HOME, work: WORK }), [
    '-p', '--model', 'opus', '--effort', 'high', '--max-turns', '300', '--permission-mode', 'default',
    '--settings', ALERTS,
    '--add-dir', RUN,
    '--allowedTools', ...RESEARCHER_ALLOW, ...EDITS, 'StructuredOutput',
    '--disallowedTools', ...DENY.filter((r) => r !== 'WebFetch' && r !== 'WebSearch'), 'Bash(git:*)',
    ...tail,
  ]);
});

test('a resume names the session, takes the role\'s resume turns, and keeps the preset otherwise', async () => {
  const { buildArgs } = await lib();
  const worker = buildArgs({ role: 'worker', run: RUN, home: HOME, work: WORK, resume: 'sid-1' });
  assert.deepEqual(worker.slice(0, 9), ['-p', '--resume', 'sid-1', '--model', 'sonnet', '--effort', 'medium', '--max-turns', '200']);
  assert.deepEqual(worker.slice(9), buildArgs({ role: 'worker', run: RUN, home: HOME, work: WORK }).slice(7));
  const reviewer = buildArgs({ role: 'reviewer', run: RUN, home: HOME, resume: 'sid-2' });
  assert.deepEqual(reviewer.slice(0, 9), ['-p', '--resume', 'sid-2', '--model', 'opus', '--effort', 'high', '--max-turns', '300']);
});

test('--skill adds Skill(<name>) and --allow a run\'s own rule, after the preset\'s, and --add-dir and --max-turns are honoured', async () => {
  const { buildArgs } = await lib();
  const args = buildArgs({ role: 'worker', run: RUN, home: HOME, work: WORK, skills: ['deletion-proof'], allow: ['Bash(/r/issue-1/other:*)'], addDirs: ['/x'], maxTurns: 50 });
  assert.equal(args[args.indexOf('--max-turns') + 1], '50');
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--allowedTools')), ['--add-dir', RUN, '--add-dir', '/x']);
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['StructuredOutput', 'Skill(deletion-proof)', 'Bash(/r/issue-1/other:*)']);
});

test('with no work folder, the researcher\'s only Edit rule is the run folder\'s: no rule for a missing folder (#192)', async () => {
  const { buildArgs } = await lib();
  const args = buildArgs({ role: 'researcher', run: RUN, home: HOME });
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed.filter((r) => r.startsWith('Edit(')), ['Edit(//r/issue-1/**)']);
});

test('given the profiles folder, every seat adds three deny rules by absolute path: the tokens, the archive and seat 1\'s old file (#178)', async () => {
  const { buildArgs } = await lib();
  const denied = (args) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format'));
  const rules = [...DENY, 'Read(//p/tokens/**)', 'Read(//p/archive/**)', 'Read(//p/seats/1/oauth-token)'];
  for (const seat of [1, 2]) assert.deepEqual(denied(buildArgs({ role: 'worker', run: RUN, home: HOME, seat, profiles: '/p' })), rules, `seat ${seat}`);
  assert.deepEqual(denied(buildArgs({ role: 'worker', run: RUN, home: HOME, seat: 2 })), DENY, 'with no folder given, none');
});

test('an unknown role is refused by name', async () => {
  const { buildArgs } = await lib();
  assert.throws(() => buildArgs({ role: 'builder', run: RUN, home: HOME }), /unknown role builder/);
});

test('a researcher\'s resume takes 200 turns', async () => {
  const { buildArgs } = await lib();
  const resumed = buildArgs({ role: 'researcher', run: RUN, home: HOME, resume: 'sid-3' });
  assert.deepEqual(resumed.slice(0, 9), ['-p', '--resume', 'sid-3', '--model', 'opus', '--effort', 'high', '--max-turns', '200']);
  assert.deepEqual(resumed.slice(9), buildArgs({ role: 'researcher', run: RUN, home: HOME }).slice(7));
});

test('no role is granted a bare Write or Edit; the researcher alone gets one Edit rule for each folder (#188, #307)', async () => {
  const { buildArgs, ROLES } = await lib();
  for (const role of ROLES) {
    const args = buildArgs({ role, run: RUN, home: HOME, work: WORK, addDirs: ['/x', RUN] });
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    assert.deepEqual(allowed.filter((r) => /^(Write|Edit|NotebookEdit|MultiEdit)\b/.test(r)), role === 'researcher' ? [...EDITS, 'Edit(//x/**)'] : [], role);
  }
});

test('hideKey is on the researcher alone and decides its mode and allow list: true keeps today\'s, false is the team\'s (#307)', async () => {
  const { buildArgs, PRESETS } = await lib();
  assert.deepEqual(Object.keys(PRESETS).filter((r) => Object.hasOwn(PRESETS[r], 'hideKey')), ['researcher']);
  const part = (args) => ({ mode: args[args.indexOf('--permission-mode') + 1], allowed: args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')), denied: args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format')) });
  const was = PRESETS.researcher.hideKey;
  try {
    assert.equal(was, true, 'the default hides the key');
    PRESETS.researcher.hideKey = true;
    const on = part(buildArgs({ role: 'researcher', run: RUN, home: HOME, work: WORK }));
    assert.equal(on.mode, 'default');
    assert.deepEqual(on.allowed, [...RESEARCHER_ALLOW, ...EDITS, 'StructuredOutput']);
    PRESETS.researcher.hideKey = false;
    const off = part(buildArgs({ role: 'researcher', run: RUN, home: HOME, work: WORK }));
    assert.equal(off.mode, 'auto');
    assert.deepEqual(off.allowed, ['StructuredOutput']);
    assert.deepEqual(off.denied, on.denied, 'the deny rules do not change');
  } finally {
    PRESETS.researcher.hideKey = was;
  }
});
