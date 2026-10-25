# <repo>

<One paragraph: what this repository is, who uses it, where it runs.>

This repository is in the factory (`tuannd9288/factory`). Its gate lives here, in `scripts/`, `.gate/` and
`.github/`; this file is the rules an agent follows in it. At most 150 lines, counted by `scripts/verify`.

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
4. Once `scripts/verify` and `red-check` pass locally, open the pull request with the template, in English,
   and run `scripts/live-verify <pr>`. On PASS or PASS+NOTES, and when its base is `main`, enable auto-merge
   (`gh pr merge --auto --merge`). FAIL: fix forward with a red test, then run it again. BLOCKED: stop, and put
   the reason and your recommended answer in the pull request. Before pushing a new patch to an armed pull
   request, disarm it (`gh pr merge --disable-auto`); arm it again once `scripts/live-verify --covered <pr>`
   passes. Then release the branch and move on; do not wait for CI.
5. The gate decides, from `main`'s scripts. Every pull request needs four checks green on its head commit:
   `verify` (`gate.yml`: main's verify, rules and red-check on your code), then `review` and `verdict`
   (`gate-trusted.yml`: the reviewer reads your change as data once `verify` passed; `verdict` passes at once on
   tier 1), and `tier`, which below tier 3 waits for `review` to end, and on tier 3 for the Human's approval of your
   change. The reviewer may raise a change to tier 3 (label `raised`), never lower one. His approval holds while the
   patch is unchanged, as when the queue merges `main` in; a new patch needs a new one. A label never lowers a tier.
   A red `tier` that says `review is red; tier follows it` is not his wait: re-run the failed jobs, never `review` alone.
6. A blocking finding is fixed by a new commit. A finding you dispute goes to the Human: label the pull request
   `needs-human` and put your recommended answer in it. At the third head commit judged red, `rounds` labels the
   pull request `needs-human`, which makes it tier 3: the Human decides.

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
| No focused, skipped or deleted tests; no lost assertions; no debugger; no placeholder bodies; no whole-file suppressions; TLS checks stay on; no hard-coded secrets | `scripts/rules` (seatwork's hand-in rules) in pre-commit and in `verify`; a dropped test's proof: `red-check`, and `tier` makes it tier 2 |
| A new test fails at the base and passes at the head | `red-check`, inside `verify` |
| A failing test committed first is not weakened later | `scripts/rules` (`failing-test-edited`) |
| Every check is shown failing on a fixture | `scripts/prove-check` in `verify` and `verify-trusted` |
| Every pull request is judged by `main`'s scripts, whatever it changes | `gate.yml` (base checkout, `scripts/verify-trusted`), `gate-trusted.yml` (`pull_request_target`) |
| Tier-3 paths are one list, and CODEOWNERS ends with exactly it | `.gate/protected`; `verify` (`policy`) |
| Removing a label lowers no tier | `tier` reads every label the pull request ever had |
| Commit subject present, at most 72 characters, never `wip`, a placeholder, `fixup!` or `squash!` | `verify` (`subjects`, every commit of the change); `.githooks/commit-msg` is the local copy |
| Land by a merge commit, through auto-merge | the ruleset (`allowed_merge_methods`); a direct merge shows in the ledger as the Human's touch |
| Auto-merge only on a base of `main`; a pull request opens only after a local pass; a waiting `tier` or `needs-human` stops your pushes | prose |
| Auto-merge armed only while a live PASS or PASS+NOTES covers the head or its patch; disarmed before a new patch is pushed | `scripts/live-verify --covered`; the ledger lists each merged pull request no verdict covered |
| No `--admin` merge, no self-approval | the ruleset (empty bypass list) and GitHub |
| Tier 3 lands only with the Human's approval of the head commit, or of one whose patch (`git patch-id`) the head carries unchanged | `tier` (`pull_request_target`); GitHub's code-owner rule alone lets an owner-author through |
| No force-push in any form, wherever the flag stands (`--force`, `-f`, `--force-with-lease[=…]`, `+<ref>`, `--mirror`): a rewrite drops the red heads `rounds` counts and the commit the Human's approval is bound to | the ruleset `factory-branches` on every branch (`non_fast_forward`, set by the factory's `bin/onboard-owner`), and `.claude/settings.json` deny rules |
| No `--no-verify`, tags, releases; no reads of `.env` or of the Human's own Claude Code and Cursor profiles (`~/.claude*`, `~/.cursor/`), whose transcripts are his, or of the verifier's Codex profile, which holds its login | `.claude/settings.json` deny rules, in Claude Code only; for tags, and for a release that would create one, also the ruleset `factory-tags`; a draft is not refused |
| Secrets only in the environment `reviewer`, never at repository level: every branch's jobs read those | prose; the weekly digest lists repository-level secrets |
| A candidate's code runs only in `gate.yml`'s `verify`: on `pull_request`, which cannot write `main`'s Actions cache, never under `pull_request_target`; on a GitHub-hosted runner, never on a self-hosted one that also runs `main`'s or a deploy's jobs; with no secret and a read-only token | the factory's tests check the kit's workflows. A pull request that changes `gate.yml` runs its own copy for its `verify`; it is tier 3, and the Human reads that file before approving |
| `AGENTS.md` at most 150 lines; `CLAUDE.md` is `@AGENTS.md` | `scripts/verify` (`instructions`) |

A rule with no enforcer goes here as `prose` and gets one, or is deleted, within 30 days.

## Hand-in rule exceptions

A block finding that is wrong for one line is allowed on that line only, in a comment:
`gate-allow <rule-id>: <why, 20 characters or more>`. The reviewer sees the line in the diff and judges it.
A deleted test file or lost assertions need one added line naming the test kept in their place and a break that
turns it red: `gate-allow test-deleted: <path>; kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"`
(or `assertions-removed`; JSON strings). `red-check` needs the kept test red under the break and green without it,
for step 2's failing test; the change is tier 2, and the reviewer judges whether the kept test covers what went.

## Layout

<The directories that matter and what lives in each.>

## Facts the code cannot tell

<Decisions with their date and who made them, known limits, accounts and services this repository uses.>
