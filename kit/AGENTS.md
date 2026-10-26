# <repo>

<One paragraph: what this repository is, who uses it, where it runs.>

This repository is in the factory (`tuannd9288/factory`). Its gate lives here, in `scripts/`, `.gate/` and
`.github/`; this file is the rules an agent follows in it. At most 150 lines, and
`CLAUDE.md` is `@AGENTS.md`, both checked by `scripts/verify`.

## Commands

| Command | Healthy output |
|---|---|
| `scripts/setup` | `setup: hooks from .githooks` |
| `scripts/verify` | `verify: 6 passed in 12s` (prints only failures and this line) |
| `scripts/verify --fast` | `verify: 2 passed in 1s` (the pre-commit hook runs it) |
| `scripts/verify --tests <files>` | `verify: 1 passed in 2s`; JUnit in `.gate/report.xml` |
| `scripts/tier` | `tier 1` (2: load-bearing path or dependency; 3: a path in `.gate/protected`, or label `needs-human`) |
| `scripts/red-check` | `red-check: red at the base (1 of 1 failed), green at the head (1 passed)` |
| `scripts/prove-check --all` | `prove-check: 7 checks fail on their fixtures` |
| `scripts/live-verify <pr>` | `live-verify: PASS on #12 (head 1a2b3c4, patch 5d6e7f8)`, posted on the pull request |
| `scripts/ship` | `ship: opened #12 <url>`; run again: `ship: armed #12: a live PASS covers HEAD 1a2b3c4` |

Run `scripts/setup` once per clone. Run `scripts/verify` and `scripts/red-check --base origin/main` before opening
the pull request; push as often as you like. CI runs `main`'s copies of both on your change, as the one check `verify`.

## How a change lands

1. One task is one issue labelled `task`, one branch, one worktree and one pull request whose body says
   `Closes #<issue>`; the ledger counts the task from that label. Never push to `main` or delete it; the ruleset refuses it.
2. Before writing, run `scripts/tier` on the files you expect to touch. Tier 2 or 3: commit the failing test
   first, alone, with the trailer `Failing-test: <test command>`. Later commits never edit those test lines.
3. Every source change carries a test that fails without it: `red-check` lays the new or changed tests onto
   the base commit and requires them to fail there as tests, not as load errors. A new name in an existing
   module: import the module (`import * as m from`), not the missing name. A new file: load it inside the
   test with `await import()`. When no test can fail first (a pure refactor, a rename), put one line in the PR
   body: `No-red: <why, 20 characters or more>`. `review` fails unless the reviewer accepts the reason. Do not test
   the wording of a prompt, rule, template or skill; the rule lives in the prompt or AGENTS.md, and review reads it.
4. Push, then run `scripts/ship` (`--body-file`: the template in English, `Closes #<issue>` filled in), and again until it
   says `armed` or stops. Each run takes the next step: opens the pull request, runs `scripts/live-verify <pr>`,
   arms auto-merge. It refuses to open unless origin holds HEAD and a full `verify` and `red-check` passed on it, to arm on FAIL or
   a base other than `main`, and stops on `needs-human`, or on a tier 3 it armed that waits for the Human. FAIL: fix forward with a red
   test, push, run it again. BLOCKED: put the reason and your recommended answer in the pull request. It disarms an
   armed pull request whose HEAD is past its verdict; push, then run it again. Then release the branch; do not wait for CI.
5. Four checks decide, from `main`'s scripts, on the head commit. When one is red or a `tier` waits, or a finding is
   disputed, read the skill `gate-red` (`.claude/skills/gate-red/SKILL.md`) before you act.

## The live verifier

pstack's Shipping verifies each pull request live before it lands (pstack `shipping.md:5`, `:7`;
`autopilot-full.md:14`); `scripts/live-verify` does it here, with two substitutes:

- Codex CLI (`codex exec`) for Shipping's Cursor cloud agent: another vendor's model than the Claude Code that wrote
  the change, run on this machine in a fresh pair of worktrees under `.claude/worktrees/`, on its own profile
  (`~/.agent-profiles/verifier/codex`), which the Human logs in; an agent never logs in. Its sandbox is
  `workspace-write` over the two worktrees, no approval prompts, outbound network only when the driver asks for it,
  no bypass flag. Cursor's cloud agents do not run under Claude Code.
- `.gate/driver.json` for `control-ui` and `control-cli`, which ship in another Cursor plugin: the repository's own
  way to run the change as a user, filled by its session and read from `main`. No driver is BLOCKED, never PASS.

The verdict is not a gate input: it lowers no tier and replaces no required check. The ledger records, for each
merged pull request, whether a verdict covered its head, and the weekly digest lists the misses.

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
`gate-allow <rule-id>: <why, 20 characters or more>`; `scripts/rules` prints that line, with the id, under a block.
The reviewer sees the line in the diff and judges it.
A deleted test file or lost assertions need one added line naming the test kept in their place and a break that
turns it red: `gate-allow test-deleted: <path>; kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"`
(or `assertions-removed`; JSON strings). `red-check` needs the kept test red under the break and green without it,
for step 2's failing test; the change is tier 2, and the reviewer judges whether the kept test covers what went.

## Layout

<The directories that matter and what lives in each.>

## Facts the code cannot tell

<Decisions with their date and who made them, known limits, accounts and services this repository uses.>
