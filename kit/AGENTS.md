# <repo>

<!-- factory:gate:begin -->
## Gate

Gate marker: gate-section-v1 (a session that loaded this file can quote this line).
This repository is in the factory (`tuannd9288/factory`). The kit owns this block; the repository owns the rest of the
file. What a program enforces: `.gate/enforced-rules.md`.

- Work enters as one issue labelled `task`, leaves as one pull request that says `Closes #<issue>`. Never push to `main`;
  land by a merge commit through auto-merge.
- Run `.gate/bin/setup` once per clone. Before the pull request run `.gate/bin/verify` (it runs the repository's own
  verify too) and `.gate/bin/red-check --base origin/main`.
- A source change carries a test that fails at the base. Where none can, the pull request body says
  `No-red: <why, 20 characters or more>`; the reviewer judges it.
- `.gate/bin/tier` prints the tier. Tier 2: commit the failing test first, alone, with `Failing-test: <command>`.
  Tier 3 (a path in `.gate/protected`, this block included): the Human approves the head commit.
- Four checks decide on the exact head commit, from `main`'s copies: `verify`, `review`, `verdict`, `tier`. When one is
  red, read `.claude/skills/gate-red/SKILL.md` first.
- Never rewrite a pushed commit or force-push. After three red rounds the pull request is `needs-human`, with your
  recommended answer in it.
- Every deploy is the Human's; decide and report anything else that can be undone. Secrets live only in the
  environment `reviewer`. A rules finding wrong for one line: `gate-allow <rule-id>: <why>` (syntax in the file above).
- A hosted agent assigned on GitHub takes tier 1 and 2 issues only, and never receives the shared bot token.
<!-- factory:gate:end -->

<One paragraph: what this repository is, who uses it, where it runs.>

This repository is in the factory (`tuannd9288/factory`). Its gate lives here, in `.gate/` (its commands in
`.gate/bin/`) and `.github/`; this file is the rules an agent follows in it. At most 150 lines, and
`CLAUDE.md` is `@AGENTS.md`, both checked by `.gate/bin/verify`.

## Commands

| Command | Healthy output |
|---|---|
| `.gate/bin/setup` | `setup: hooks from .gate/hooks` |
| `.gate/bin/verify` | `verify: 6 passed in 12s` (prints only failures and this line) |
| `.gate/bin/verify --fast` | `verify: 2 passed in 1s` (the pre-commit hook runs it) |
| `.gate/bin/verify --tests <files>` | `verify: 1 passed in 2s`; JUnit in `.gate/report.xml` |
| `.gate/bin/tier` | `tier 1` (2: load-bearing path or dependency; 3: a path in `.gate/protected`, or label `needs-human`) |
| `.gate/bin/red-check` | `red-check: red at the base (1 of 1 failed), green at the head (1 passed)` |
| `.gate/bin/prove-check --all` | `prove-check: 7 checks fail on their fixtures` |

Run `.gate/bin/setup` once per clone. Run `.gate/bin/verify` and `.gate/bin/red-check --base origin/main` before opening
the pull request; push as often as you like. CI runs `main`'s copies of both on your change, as the one check `verify`.

## How a change lands

1. One task is one issue labelled `task`, one branch, one worktree and one pull request whose body says
   `Closes #<issue>`; the ledger counts the task from that label. Never push to `main` or delete it; the ruleset refuses it.
2. Before writing, run `.gate/bin/tier` on the files you expect to touch. Tier 2 or 3: commit the failing test
   first, alone, with the trailer `Failing-test: <test command>`. Later commits never edit those test lines.
3. Every source change carries a test that fails without it: `red-check` lays the new or changed tests onto
   the base commit and requires them to fail there as tests, not as load errors. A new name in an existing
   module: import the module (`import * as m from`), not the missing name. A new file: load it inside the
   test with `await import()`. When no test can fail first (a pure refactor, a rename), put one line in the PR
   body: `No-red: <why, 20 characters or more>`. `review` fails unless the reviewer accepts the reason. Do not test
   the wording of a prompt, rule, template or skill; the rule lives in the prompt or AGENTS.md, and review reads it.
4. Four checks decide, from `main`'s scripts, on the head commit. When one is red or a `tier` waits, or a finding is
   disputed, read the skill `gate-red` (`.claude/skills/gate-red/SKILL.md`) before you act.

## What the Human keeps

- Tier 3: changes to a path in `.gate/protected`.
- A pull request stuck after three rounds (`needs-human`), with a recommended answer in it.
- Every deploy. Nothing here deploys without him.

Everything else that can be undone, agents decide and report after. A question to him carries a recommended
answer; a reversible question never blocks the work.

## Rules and what enforces them

The rules a program refuses or flags are in `.gate/enforced-rules.md`, which the gate's reviewer reads with this file; read it when a check is red or your change touches the gate.

| Rule | Enforced by |
|---|---|
| Land by a merge commit, through auto-merge | the ruleset (`allowed_merge_methods`); a direct merge shows in the ledger as the Human's touch |
| No rewrite of a pushed commit (rebase, amend) and no force-push in any form, wherever the flag stands (`--force`, `-f`, `--force-with-lease[=…]`, `+<ref>`, `--mirror`): a rewrite drops the red heads `rounds` counts and the commit the Human's approval is bound to | the ruleset `factory-branches` on every branch (`non_fast_forward`, set by the factory's `bin/onboard-owner`), and `.claude/settings.json` deny rules |
| Secrets only in the environment `reviewer`, never at repository level: every branch's jobs read those | prose; the weekly digest lists repository-level secrets |

A rule with no enforcer goes here as `prose` and gets one, or is deleted, within 30 days.

## Hand-in rule exceptions

A block finding that is wrong for one line is allowed on that line only, in a comment:
`gate-allow <rule-id>: <why, 20 characters or more>`; `.gate/bin/rules` prints that line, with the id, under a block.
The reviewer sees the line in the diff and judges it.
A deleted test file or lost assertions need one added line naming the test kept in their place and a break that
turns it red: `gate-allow test-deleted: <path>; kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"`
(or `assertions-removed`; JSON strings). `red-check` needs the kept test red under the break and green without it,
for step 2's failing test; the change is tier 2, and the reviewer judges whether the kept test covers what went.

## Layout

<The directories that matter and what lives in each.>

## Facts the code cannot tell

<Decisions with their date and who made them, known limits, accounts and services this repository uses.>
