// bin/seat (#91): the one command that starts an unattended `claude -p` session. This file holds the role presets: the
// arguments each role gives claude. They come from the hand-written launchers of ~/factory-runs, role by role (see
// PRESETS). Nothing here reads a credential.

/** What a session reports back through --json-schema (as the gate's reviewer does, kit/scripts/lib/claude-reviewer.mjs).
 * The cost is not asked of the model: the record takes it from the session's result event. */
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'evidence', 'couldNotRead', 'needsHuman'],
  properties: {
    conclusion: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    couldNotRead: { type: 'array', items: { type: 'string' } },
    needsHuman: { type: 'array', items: { type: 'string' } },
  },
};

// The deny list every launcher shared. WebFetch and WebSearch are denied for every role but the researcher.
const secretsRead = ['Read(~/.config/**)', 'Read(~/.claude/**)', 'Read(~/.codex/**)', 'Read(~/.agent-profiles/**)', 'Read(~/.ssh/**)', 'Read(~/.local/share/claude/**)'];
const denyOf = (home, web) => [
  'Bash(gh:*)', 'Bash(git push:*)', 'Bash(git config:*)', 'Bash(claude:*)', 'Bash(codex:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(curl:*)',
  'Bash(herdr:*)', `Bash(${home}/.local/bin/herdr:*)`, ...(web ? [] : ['WebFetch', 'WebSearch']), ...secretsRead,
];

// --json-schema adds the StructuredOutput tool to the session, so each allow list admits it (claude-reviewer.mjs).
const builderAllow = (run) => [
  'Read', 'Glob', 'Grep', 'Bash(node:*)', 'Bash(git:*)', `Bash(${run}/sv)`, 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(cd:*)', 'Bash(mktemp:*)', 'Bash(grep:*)', 'Bash(diff:*)',
];

/** The presets. turns is a new session's --max-turns, resumeTurns a resumed one's. The budget is the Lead's choice
 * (#91); whether it stops a session on a subscription seat is not known yet.
 * worker: run-90.sh worker (sonnet, medium, 400 turns); its fix rounds (run-90fix.sh) resume with 200.
 * reviewer: run-90.sh reviewer (opus, high, 300 turns); its rounds (run-90rr family) resume with 300 or 200, 300 here.
 * researcher: run-79.sh, run-71.sh and run-58.sh (opus, high, 300 turns, the web and read-only git); resumed with 200
 *   (run-71tx.sh, run-71rc.sh). */
export const PRESETS = {
  worker: {
    model: 'sonnet', effort: 'medium', turns: 400, resumeTurns: 200, budget: 20, web: false,
    allow: (run) => [...builderAllow(run), 'Write', 'Edit', 'Bash(cp:*)', 'Bash(sed:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(cmp:*)'],
  },
  reviewer: {
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 300, budget: 15, web: false,
    allow: (run) => [...builderAllow(run), 'Write'],
  },
  researcher: {
    model: 'opus', effort: 'high', turns: 300, resumeTurns: 200, budget: 15, web: true,
    allow: () => [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash(git clone:*)', 'Bash(git -C:*)', 'Bash(git log:*)',
      'Bash(git show:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)', 'Bash(git grep:*)', 'Bash(git diff:*)',
      'Bash(ls:*)', 'Bash(wc:*)', 'Bash(mkdir:*)', 'Bash(date:*)', 'Bash(cd:*)',
    ],
  },
};

export const ROLES = Object.keys(PRESETS);

/** The arguments of `claude`, for a role. run is the run folder (the session may add it to its directories and run its
 * `sv`); skills become Skill(<name>) grants and allow is a run's own extra grants; seat and tokenPath add seat 1's
 * deny rules. */
export function buildArgs({ role, run, home, resume = null, skills = [], allow = [], addDirs = [], maxTurns = null, seat = null, tokenPath = null }) {
  const p = PRESETS[role];
  if (!p) throw new Error(`unknown role ${role}; the roles are ${ROLES.join(', ')}`);
  const deny = [...denyOf(home, p.web), ...(seat === 1 ? ['Bash(env:*)', 'Bash(printenv:*)', `Read(/${tokenPath})`] : [])];
  return [
    '-p', ...(resume ? ['--resume', resume] : []),
    '--model', p.model, '--effort', p.effort, '--max-turns', String(maxTurns ?? (resume ? p.resumeTurns : p.turns)),
    '--max-budget-usd', String(p.budget), '--permission-mode', 'acceptEdits',
    '--add-dir', run, ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--allowedTools', ...p.allow(run), 'StructuredOutput', ...skills.map((s) => `Skill(${s})`), ...allow,
    '--disallowedTools', ...deny,
    '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(SCHEMA),
  ];
}
