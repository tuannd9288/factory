# <repo>

<One paragraph: what this repository is, who uses it, where it runs.>

This repository is in the factory (`tuannd9288/factory`). Its gate lives here, in `scripts/`, `.gate/` and
`.github/`; this file is the rules an agent follows in it. At most 150 lines, counted by `scripts/verify`.

## Commands

| Command | Healthy output |
|---|---|
| `scripts/setup` | `setup: hooks from .githooks` |
| `scripts/verify` | `verify: 5 passed in 12s` (prints only failures and this line) |
| `scripts/verify --fast` | `verify: 2 passed in 1s` (the pre-commit hook runs it) |
| `scripts/verify --tests <files>` | `verify: 1 passed in 2s`; JUnit in `.gate/report.xml` |
| `scripts/tier` | `tier 1` (2: load-bearing path or dependency; 3: a path in `.gate/protected`, or label `needs-human`) |
| `scripts/red-check` | `red-check: red at the base (1 of 1 failed), green at the head (1 passed)` |
| `scripts/prove-check --all` | `prove-check: 6 checks fail on their fixtures` |

Run `scripts/setup` once per clone. Run `scripts/verify` and `scripts/red-check --base origin/main` before every
push; CI runs `main`'s copies of both on your change, as the one check `verify`.

## How a change lands

1. One task is one issue labelled `task`, one branch, one worktree and one pull request whose body says
   `Closes #<issue>`; the ledger counts the task from that label. Never push to `main`; the ruleset refuses it.
2. Before writing, run `scripts/tier` on the files you expect to touch. Tier 2 or 3: commit the failing test
   first, alone, with the trailer `Failing-test: <test command>`. Later commits never edit those test lines.
3. Every source change carries a test that fails without it: `red-check` lays the new or changed tests onto
   the base commit and requires them to fail there as tests, not as load errors. A new name in an existing
   module: import the module (`import * as m from`), not the missing name. A new file: load it inside the
   test with `await import()`. When no test can fail first (a pure refactor, a rename), put one line in the PR
   body: `No-red: <why, 20 characters or more>`. `review` fails unless the reviewer accepts the reason.
4. Open the pull request with the template, in Vietnamese, and enable auto-merge (`gh pr merge --auto --merge`).
   Then release the branch and move on; do not wait for CI.
5. The gate decides, from `main`'s scripts. Every pull request needs four checks green on its head commit:
   `verify` (`gate.yml`: main's verify, rules and red-check on your code), then `review` and `verdict`
   (`gate-trusted.yml`: the reviewer reads your change as data once `verify` passed; `verdict` passes at once on
   tier 1), and `tier`, which on tier 3 waits for the Human's approval of your change. His approval holds while the
   patch is unchanged, as when the queue merges `main` in; any change to the patch needs a new one. A label never
   lowers the tier, even once removed.
6. A blocking finding is fixed by a new commit, or answered in its thread with `withdraw <id>: <reason>` for
   the reviewer to judge. At the third head commit judged red, `rounds` labels the pull request `needs-human`,
   which makes it tier 3: the Human decides.

## What the Human keeps

- Tier 3: changes to a path in `.gate/protected`: `.github/`, `.gate/`, `.githooks/`, `.claude/`, `scripts/`,
  `AGENTS.md`, `CLAUDE.md`, and the test, lint and type-check configuration.
- A pull request stuck after three rounds (`needs-human`), with a recommended answer in it.
- Every deploy. Nothing here deploys without him.

Everything else that can be undone, agents decide and report after. A question to him carries a recommended
answer; a reversible question never blocks the work.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| Never push or force-push `main`, never delete it | ruleset on `main` |
| Checks green on the exact head commit before merge | ruleset: `verify`, `review`, `verdict`, `tier` pinned to GitHub Actions, branch up to date |
| No focused, skipped or deleted tests; no lost assertions; no debugger; no placeholder bodies; no whole-file suppressions; TLS checks stay on; no hard-coded secrets | `scripts/rules` (seatwork's hand-in rules) in pre-commit and in `verify` |
| A new test fails at the base and passes at the head | `red-check`, inside `verify` |
| A failing test committed first is not weakened later | `scripts/rules` (`failing-test-edited`) |
| Every check is shown failing on a fixture | `scripts/prove-check` in `verify` and `verify-trusted` |
| Every pull request is judged by `main`'s scripts, whatever it changes | `gate.yml` (base checkout, `scripts/verify-trusted`), `gate-trusted.yml` (`pull_request_target`) |
| Tier-3 paths are one list, and CODEOWNERS ends with exactly it | `.gate/protected`; `verify` (`policy`) |
| Removing a label lowers no tier | `tier` reads every label the pull request ever had |
| Commit subject present, at most 72 characters | `.githooks/commit-msg` |
| No `--admin` merge, no self-approval | the ruleset (empty bypass list) and GitHub |
| Tier 3 lands only with the Human's approval of the head commit, or of one whose patch (`git patch-id`) the head carries unchanged | `tier` (`pull_request_target`); GitHub's code-owner rule alone lets an owner-author through |
| No force-push in any form, wherever the flag stands (`--force`, `-f`, `--force-with-lease[=…]`, `+<ref>`, `--mirror`): a rewrite drops the red heads `rounds` counts and the commit the Human's approval is bound to | `.claude/settings.json` deny rules, in Claude Code only; nothing on GitHub refuses one to a branch other than `main` |
| No `--no-verify`, tags, releases; no reads of `.env` or of the Human's own Claude Code and Cursor profiles (`~/.claude*`, `~/.cursor/`), whose transcripts are his | `.claude/settings.json` deny rules, in Claude Code only; nothing on GitHub refuses a tag or a release |
| Secrets only in the environment `reviewer`, never at repository level: every branch's jobs read those | prose; the weekly digest lists repository-level secrets |
| A candidate's code runs only in `gate.yml`'s `verify`: on `pull_request`, which cannot write `main`'s Actions cache, never under `pull_request_target`; on a GitHub-hosted runner, never on a self-hosted one that also runs `main`'s or a deploy's jobs; with no secret and a read-only token | the factory's tests check the kit's workflows. A pull request that changes `gate.yml` runs its own copy for its `verify`; it is tier 3, and the Human reads that file before approving |
| `AGENTS.md` at most 150 lines; `CLAUDE.md` is `@AGENTS.md` | `scripts/verify` (`instructions`) |

A rule with no enforcer goes here as `prose` and gets one, or is deleted, within 30 days.

## Hand-in rule exceptions

A block finding that is wrong for one line is allowed on that line only, in a comment:
`gate-allow <rule-id>: <why, 20 characters or more>`. The reviewer sees the line in the diff and judges it.

## Layout

<The directories that matter and what lives in each.>

## Facts the code cannot tell

<Decisions with their date and who made them, known limits, accounts and services this repository uses.>
