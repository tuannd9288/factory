// bin/seat (#91): the argument list each role's preset gives `claude -p`, pinned exactly. The presets come from the
// hand-written launchers of ~/factory-runs (worker and reviewer from run-90.sh, researcher from run-79.sh and run-71.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lib = () => import('../bin/lib/seat.mjs');

const RUN = '/r/issue-1';
const HOME = '/h';
const SCHEMA = '{"type":"object","additionalProperties":false,"required":["conclusion","evidence","couldNotRead","needsHuman"],"properties":{"conclusion":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}},"couldNotRead":{"type":"array","items":{"type":"string"}},"needsHuman":{"type":"array","items":{"type":"string"}}}}';

const DENY = [
  'Bash(gh:*)', 'Bash(git push:*)', 'Bash(git config:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(curl:*)',
  'Bash(herdr:*)', 'Bash(/h/.local/bin/herdr:*)', 'WebFetch', 'WebSearch',
  'Read(~/.config/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)', 'Read(~/.agent-profiles/**)', 'Read(~/.ssh/**)', 'Read(~/.local/share/claude/**)',
];
const BASE = ['Read', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(git:*)', 'Bash(/r/issue-1/sv)', 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(cd:*)', 'Bash(mktemp:*)', 'Bash(grep:*)', 'Bash(diff:*)'];
const WORKER_ALLOW = [...BASE, 'Write', 'Edit', 'Bash(cp:*)', 'Bash(sed:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(cmp:*)', 'StructuredOutput'];

const tail = ['--output-format', 'stream-json', '--verbose', '--json-schema', SCHEMA];

test('worker: sonnet, medium effort, 400 turns, $20, the worker allow list and the common deny list', async () => {
  const { buildArgs } = await lib();
  assert.deepEqual(buildArgs({ role: 'worker', run: RUN, home: HOME }), [
    '-p', '--model', 'sonnet', '--effort', 'medium', '--max-turns', '400', '--max-budget-usd', '20', '--permission-mode', 'acceptEdits',
    '--add-dir', RUN,
    '--allowedTools', ...WORKER_ALLOW,
    '--disallowedTools', ...DENY,
    ...tail,
  ]);
});

test('reviewer: opus, high effort, 300 turns, $15, the base allow list with Write only', async () => {
  const { buildArgs } = await lib();
  assert.deepEqual(buildArgs({ role: 'reviewer', run: RUN, home: HOME }), [
    '-p', '--model', 'opus', '--effort', 'high', '--max-turns', '300', '--max-budget-usd', '15', '--permission-mode', 'acceptEdits',
    '--add-dir', RUN,
    '--allowedTools', ...BASE, 'Write', 'StructuredOutput',
    '--disallowedTools', ...DENY,
    ...tail,
  ]);
});

test('researcher: opus, high effort, 300 turns, $15, the web and read-only git, and no WebFetch or WebSearch deny', async () => {
  const { buildArgs } = await lib();
  assert.deepEqual(buildArgs({ role: 'researcher', run: RUN, home: HOME }), [
    '-p', '--model', 'opus', '--effort', 'high', '--max-turns', '300', '--max-budget-usd', '15', '--permission-mode', 'acceptEdits',
    '--add-dir', RUN,
    '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash(git clone:*)', 'Bash(git -C:*)', 'Bash(git log:*)',
    'Bash(git show:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)', 'Bash(git grep:*)', 'Bash(git diff:*)',
    'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(date:*)', 'Bash(cd:*)', 'StructuredOutput',
    '--disallowedTools', ...DENY.filter((r) => r !== 'WebFetch' && r !== 'WebSearch'),
    ...tail,
  ]);
});

test('a resume names the session, takes the role\'s resume turns, and keeps the preset otherwise', async () => {
  const { buildArgs } = await lib();
  const worker = buildArgs({ role: 'worker', run: RUN, home: HOME, resume: 'sid-1' });
  assert.deepEqual(worker.slice(0, 9), ['-p', '--resume', 'sid-1', '--model', 'sonnet', '--effort', 'medium', '--max-turns', '200']);
  assert.deepEqual(worker.slice(9), buildArgs({ role: 'worker', run: RUN, home: HOME }).slice(7));
  const reviewer = buildArgs({ role: 'reviewer', run: RUN, home: HOME, resume: 'sid-2' });
  assert.deepEqual(reviewer.slice(0, 9), ['-p', '--resume', 'sid-2', '--model', 'opus', '--effort', 'high', '--max-turns', '300']);
});

test('--skill adds Skill(<name>) and --allow a run\'s own rule, after the preset\'s, and --add-dir and --max-turns are honoured', async () => {
  const { buildArgs } = await lib();
  const args = buildArgs({ role: 'worker', run: RUN, home: HOME, skills: ['deletion-proof'], allow: ['Bash(/r/issue-1/other:*)'], addDirs: ['/x'], maxTurns: 50 });
  assert.equal(args[args.indexOf('--max-turns') + 1], '50');
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--allowedTools')), ['--add-dir', RUN, '--add-dir', '/x']);
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, [...WORKER_ALLOW, 'Skill(deletion-proof)', 'Bash(/r/issue-1/other:*)']);
});

test('seat 1 adds three deny rules, one of them the token file by absolute path; seat 2 adds none', async () => {
  const { buildArgs } = await lib();
  const denied = (args) => args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--output-format'));
  const one = denied(buildArgs({ role: 'worker', run: RUN, home: HOME, seat: 1, tokenPath: '/p/seats/1/oauth-token' }));
  assert.deepEqual(one, [...DENY, 'Bash(env:*)', 'Bash(printenv:*)', 'Read(//p/seats/1/oauth-token)']);
  assert.deepEqual(denied(buildArgs({ role: 'worker', run: RUN, home: HOME, seat: 2, tokenPath: '/p/seats/2/oauth-token' })), DENY);
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
