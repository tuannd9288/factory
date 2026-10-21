# <repo>

<One paragraph: what this repository is, who uses it, where it runs.>

This repository is in the factory (`tuannd9288/factory`). Its gate lives here, in `scripts/`, `.gate/` and
`.github/`; this file is the rules an agent follows in it. At most 150 lines, counted by `scripts/verify`.

## Commands

| Command | Healthy output |
|---|---|
| `scripts/setup` | `setup: hooks from .githooks` |
| `scripts/verify` | `verify: 4 passed in 12s` (prints only failures and this line) |
| `scripts/verify --fast` | `verify: 2 passed in 1s` (the pre-commit hook runs it) |
| `scripts/verify --tests <files>` | `verify: 1 passed in 2s`; JUnit in `.gate/report.xml` |
| `scripts/tier` | `tier 1` (2: load-bearing path or dependency; 3: a path in `.github/CODEOWNERS`) |
| `scripts/red-check` | `red-check: red at the base (1 of 1 failed), green at the head (1 passed)` |
| `scripts/prove-check --all` | `prove-check: 5 checks fail on their fixtures` |

Run `scripts/setup` once per clone. Run `scripts/verify` before every push; CI runs the same command.

## How a change lands

1. One task is one branch, one worktree and one pull request. Never push to `main`; the ruleset refuses it.
2. Before writing, run `scripts/tier` on the files you expect to touch. Tier 2 or 3: commit the failing test
   first, alone, with the trailer `Failing-test: <test command>`. Later commits never edit those test lines.
3. Every source change carries a test that fails without it: `red-check` lays the new or changed tests onto
   the base commit and requires them to fail there as tests, not as load errors. A new name in an existing
   module: import the module (`import * as m from`), not the missing name. A new file: load it inside the
   test with `await import()`. When no test can fail first (a pure refactor, a rename), put one line in the PR
   body: `No-red: <why, 20 characters or more>`. The review judges the reason and the ledger counts it.
4. Open the pull request with the template, in Vietnamese, and enable auto-merge (`gh pr merge --auto --merge`).
   Then release the branch and move on; do not wait for CI.
5. The gate decides. Tier 1 needs `verify`, `rules`, `red-check`, `verify-trusted` and `review` green on the
   head commit; tier 2 adds `verdict`; on tier 3 `verdict` also waits for the Human's approval of the head commit.
6. A blocking finding is fixed by a new commit, or answered in its thread with `withdraw <id>: <reason>` for
   the reviewer to judge. After three rounds the pull request gets the label `needs-human`.

## What the Human keeps

- Tier 3: changes to `.github/`, `.gate/`, `.githooks/`, `.claude/`, `scripts/`, `AGENTS.md`, `CLAUDE.md`.
- A pull request stuck after three rounds (`needs-human`), with a recommended answer in it.
- Every deploy. Nothing here deploys without him.

Everything else that can be undone, agents decide and report after. A question to him carries a recommended
answer; a reversible question never blocks the work.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| Never push or force-push `main`, never delete it | ruleset on `main` |
| Checks green on the exact head commit before merge | ruleset: required checks pinned to GitHub Actions, branch up to date |
| No focused, skipped or deleted tests; no lost assertions; no debugger; no placeholder bodies; no whole-file suppressions; TLS checks stay on; no hard-coded secrets | `scripts/rules` (seatwork's hand-in rules) in pre-commit and CI |
| A new test fails at the base and passes at the head | `red-check` in CI |
| A failing test committed first is not weakened later | `scripts/rules` (`failing-test-edited`) |
| Every check is shown failing on a fixture | `scripts/prove-check` in `verify` and `verify-trusted` |
| A change to the gate is judged by `main`'s gate | `verify-trusted` (`pull_request_target`) |
| Commit subject present, at most 72 characters | `.githooks/commit-msg` |
| No `--admin` merge, no self-approval | the ruleset (empty bypass list) and GitHub |
| Tier 3 lands only with the Human's approval of the head commit | `verdict` (`pull_request_target`); GitHub's code-owner rule alone lets an owner-author through |
| No `--no-verify`, tags, releases, `.env` reads | `.claude/settings.json` deny rules, in Claude Code only; nothing on GitHub refuses a tag or a release |
| Secrets only in the environment `reviewer`, never at repository level: every branch's jobs read those | prose; the weekly digest lists repository-level secrets |
| `AGENTS.md` at most 150 lines; `CLAUDE.md` is `@AGENTS.md` | `scripts/verify` (`instructions`) |

A rule with no enforcer goes here as `prose` and gets one, or is deleted, within 30 days.

## Hand-in rule exceptions

A block finding that is wrong for one line is allowed on that line only, in a comment:
`gate-allow <rule-id>: <why, 20 characters or more>`. The review sees it; the ledger counts it.

## Layout

<The directories that matter and what lives in each.>

## Facts the code cannot tell

<Decisions with their date and who made them, known limits, accounts and services this repository uses.>
