# Rules that code enforces

The rules a program refuses or flags, or that the reviewer judges, in the detail the Gate block of `AGENTS.md` leaves out.
The gate's reviewer reads this file from `main` with `AGENTS.md`. A path here is tier 3. A rule with no enforcer goes here
as `prose` and gets one, or is deleted, within 30 days.

| Rule | Enforced by |
|---|---|
| `AGENTS.md` has the kit's Gate block at its start (after an optional title line), is at most 150 lines and 32 KiB, and `CLAUDE.md` starts with the line `@AGENTS.md` or is a relative symlink to it | `.gate/bin/verify` (`instructions`); `.gate/bin/verify-trusted` reads the candidate's git objects, and a changed block passes only as a kit update the factory's `main` vouches for |
| Land by a merge commit, through auto-merge | the ruleset (`allowed_merge_methods`); a direct merge shows in the ledger as the Human's touch |
| No rewrite of a pushed commit (rebase, amend) and no force-push in any form, wherever the flag stands (`--force`, `-f`, `--force-with-lease[=…]`, `+<ref>`, `--mirror`): a rewrite drops the red heads `rounds` counts and the commit the Human's approval is bound to | the ruleset `factory-branches` on every branch (`non_fast_forward`, set by the factory's `bin/onboard-owner`); deleting a branch other than `main` and `claim/*` and pushing it again is not refused, nor is a `--mirror` push that deletes such branches |
| Secrets only in the environment `reviewer`, never at repository level: every branch's jobs read those | prose; the weekly digest lists repository-level secrets |
| Do not test the wording of a prompt, rule, template or skill; the rule lives in the prompt or `AGENTS.md`, and review reads it | the reviewer |
| Checks green on the exact head commit before merge | ruleset: `verify`, `review`, `verdict`, `tier` pinned to GitHub Actions, branch up to date. With the repository variable `GATE_REVIEWER=entire`, `verify` and `tier`, and Entire's `Entire Gates` pinned to its App (`bin/onboard-owner` writes that ruleset from the variable); `tier` passes only on that check's success, since GitHub counts its neutral and skipped as passing, and fails while the rules in force pin no such App |
| No focused, skipped or deleted tests; no lost assertions; no debugger; no placeholder bodies; no whole-file suppressions; TLS checks stay on; no hard-coded secrets | `.gate/bin/rules` (seatwork's hand-in rules) in pre-commit and in `verify`; a dropped test's proof: `red-check`, and `tier` makes it tier 2 |
| A new test fails at the base and passes at the head | `red-check`, inside `verify` |
| A failing test committed first is not weakened later | `.gate/bin/rules` (`failing-test-edited`) |
| Every check is shown failing on a fixture | `.gate/bin/prove-check` in `verify` and `verify-trusted` |
| Every pull request is judged by `main`'s scripts, whatever it changes | `gate.yml` (base checkout, `.gate/bin/verify-trusted`), `gate-trusted.yml` (`pull_request_target`) |
| Tier-3 paths are one list, and CODEOWNERS ends with exactly it; a directory line has no trailing "/", so the path itself is protected too | `.gate/protected`; `verify` (`policy`) |
| Removing a label lowers no tier | `tier` reads every label the pull request ever had |
| Commit subject present, at most 72 characters, never `wip`, a placeholder, `fixup!` or `squash!` | `verify` (`subjects`, every commit of the change); `.gate/hooks/commit-msg` is the local copy |
| No `--admin` merge, no self-approval | the ruleset (empty bypass list) and GitHub |
| Tier 3 lands only with the Human's approval of the head commit, or of one whose patch (`git patch-id`) the head carries unchanged | `tier` (`pull_request_target`); GitHub's code-owner rule alone lets an owner-author through |
| No `--no-verify`, tags, releases; no reads of `.env` or of the Human's own Claude Code and Cursor profiles (`~/.claude*`, `~/.cursor/`), whose transcripts are his, or of the verifier's Codex profile, which holds its login | for reads, `.claude/settings.json` deny rules, in Claude Code only; for tags, and for a release that would create one, the ruleset `factory-tags`, and a draft release, a release on an existing tag, or an edit or deletion of an existing release is not refused; a commit made with `--no-verify` still meets the same checks in the required check `verify` |
| A candidate's code runs only in `gate.yml`'s `verify`: on `pull_request`, which cannot write `main`'s Actions cache, never under `pull_request_target`; on a GitHub-hosted runner when `GATE_PR_RUNNER` is unset; never on a runner that holds a secret or runs `main`'s or a deploy's jobs; a self-hosted runner only when it is ephemeral and the two-job canary has proven it clean, but for the Human's exception in the next row; with no secret and a read-only token | the factory's tests check the kit's workflows. `GATE_PR_RUNNER` is a repository variable only an admin sets, after the canary; nothing in code checks that a runner is ephemeral. A pull request that changes `gate.yml` runs its own copy for its `verify`; it is tier 3, and the Human reads that file before approving |
| `gate-trusted.yml`'s jobs run on `GATE_TRUSTED_RUNNER`, on a GitHub-hosted runner when it is unset; never on a runner a candidate's, `main`'s or a deploy's job uses, nor on one that another workflow can reach, since they hold the reviewer's credential and a token that writes labels. The one exception is the Human's (#155): with `GATE_REVIEWER=entire` and no reviewer secret in the environment `reviewer` they hold no reviewer credential, and he may run them, `main.yml` and the candidate's `verify` on the same self-hosted runners. He accepts that a job a candidate planted there can fake `tier`: GitHub still requires Entire's check and a code owner's approval of a protected path, given on any earlier commit, but counts that check's neutral or skipped as passing, and nothing else holds what only `tier` asks for: the Human's approval, of the head, of a No-red line, `needs-human` or a `tier-3` label, or a change to a `key` line of `.gate/protected` (a test or lint script, a tool's config section), and the claim check | the factory's tests check that every job of `gate-trusted.yml` reads the variable, with hosted Ubuntu as its default. `GATE_TRUSTED_RUNNER` is a repository variable only an admin sets; nothing in code checks which workflows can reach a runner |
| A claim on an issue is the ref `claim/<n>`: created once, never rewritten or deleted; a second claim is refused, naming the holder | the rulesets `factory-branches` and `factory-claims`, which GitHub enforces for every login; `.gate/bin/claim` refuses a second claim and a release by anyone but the holder or the Human, which under one login is cooperative |
| A pull request names its team in a `Team:` line | `verify-trusted` (`.gate/bin/lib/prbody.mjs`), from the body GitHub gives `gate.yml`; `Session:` and `Cost:` inform and gate nothing |
| A pull request's `Claim:` is the tip of `claim/<n>` for the issue named in `Issue:`, that issue is open, and it closes no other issue | `tier`, which reads the ref when it ends; `.gate/bin/claim` re-runs `tier` of the open pull requests of an issue it releases or hands off, and a claim moved by a raw `git push` is not re-checked until a run |
| A pull request whose head is in another repository gets a red `review` before any step that holds the credential | `gate-trusted.yml`'s first `review` step, red and never skipped, since a skipped required job passes |

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

Push as often as you like; CI runs `main`'s copies of `verify` and `red-check` on your change, as the one check `verify`.
Before writing, run `.gate/bin/tier` on the files you expect to touch. Tier 2 or 3: commit the failing test first, alone, with
the trailer `Failing-test: <test command>`; later commits never edit those test lines.

`red-check` lays the new or changed tests onto the base commit and requires them to fail there as tests, not as load errors.
A new name in an existing module: import the module (`import * as m from`), not the missing name. A new file: load it inside
the test with `await import()`. When no test can fail first (a pure refactor, a rename), put one line in the PR body:
`No-red: <why, 20 characters or more>`. `review` fails unless the reviewer accepts the reason. Where Entire reviews
(`GATE_REVIEWER=entire`), `tier` makes the change tier 3 instead: the Human judges the reason.

## Exceptions

A block finding that is wrong for one line is allowed on that line only, in a comment:
`gate-allow <rule-id>: <why, 20 characters or more>`; `.gate/bin/rules` prints that line, with the id, under a block.
The reviewer sees the line in the diff and judges it.
A deleted test file or lost assertions need one added line naming the test kept in their place and a break that
turns it red: `gate-allow test-deleted: <path>; kept: <test file> "<test name>"; red: <source file> "<from>" -> "<to>"`
(or `assertions-removed`; JSON strings). `red-check` needs the kept test red under the break and green without it,
for the failing test above; the change is tier 2, and the reviewer judges whether the kept test covers what went.
