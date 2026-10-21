# The factory

This repository (`tuannd9288/factory`) is the root of the Human's software factory. On the Mac mini it is cloned
as `~/Desktop/workspaces`; each repository in the factory is a subfolder there, cloned from GitHub and ignored by
this root's git. This file covers the factory's rules and taking a repository in. Inside a repository, that
repository's own `AGENTS.md` governs.

## Decisions

- **K1, 2026-10-21 (the Human: "Triển khai theo đề xuất đi").** A reversible change in tier 1 or 2 merges by rule
  once the repository's gate is green on its head commit. The Human keeps tier 3, a change stuck after three
  rounds, and every deploy.
- No change auto-merges in a repository until its gate has passed the attacks and the 20 seeded + 20 clean probes
  on a scratch repository against two bars (the Human, 2026-10-21): the mechanical bar, every mechanical defect
  caught; and the full-gate bar, with the real reviewer, at least 18/20 seeded caught, every load-bearing one caught,
  at most 1/20 clean blocked. `probes/plan.md` states both; `probes/results.md` has the first run's numbers.
- agent-desk stays parked. Every lead, worker and reviewer runs through Claude Code.

## Tiers

The change sets the tier, by the paths it touches (`scripts/tier`), never the author.

| Tier | Trigger | Must be true to merge | The Human |
|---|---|---|---|
| 1 | no tier-2 or tier-3 path | `verify`, `review`, `verdict`, `tier` green on the head commit; `verdict` passes at once | none |
| 2 | a `.gate/load-bearing` path, or a dependency manifest | the same, with `verdict` judged by the reviewer | reads it in the weekly digest and on the deploy page |
| 3 | a path in `.gate/protected` (the gate, `AGENTS.md`, `.claude/`, test and lint configuration), or the label `needs-human` | tier 2 and his approval of the head commit, which `tier` checks | approves from the summary |

A tier never drops within a pull request: every label `tier-N` or `needs-human` it ever had raises it, even once
removed.

Agents open pull requests under their own GitHub account, never the Human's. GitHub refuses an author's approval of
his own pull request, and its code-owner rule asks nothing of an author who owns the code: on the scratch repository
a tier-3 pull request opened from the Human's account merged with no approval (2026-10-21). So the `tier` check
itself requires, on tier 3, an approval of the head commit by a code owner who is not the author.

## What the Human keeps

- Tier 3 approvals, `needs-human` pull requests (stuck after three rounds), and every deploy.
- Admin steps: importing a repository's ruleset, its `reviewer` environment and secrets, registering the runner.
- Logging into a repository's profile. An agent never logs in or switches accounts.

Everything else that can be undone, agents decide and report after.

## This root

- No `CLAUDE.md` here. With one, Claude Code reads it and skips the `AGENTS.md` of every repository below
  (tested on Claude Code 2.1.304, 2026-10-20). Each repository keeps a one-line `CLAUDE.md`: `@AGENTS.md`.
- Nothing in a repository points outside it: no links into `~/Desktop/TuanHub`, no user-level skills.
- This folder stays out of every sync between the Macs. Code moves only through GitHub.
- `.gitignore` admits only the factory's own files, so every repository folder is ignored.
- A change to `kit/` changes every repository's gate at its next kit pull request: it is tier 3 here.

| Path | What it is |
|---|---|
| `kit/` | What every repository receives through one pull request when it joins |
| `bin/onboard` | Takes a repository in |
| `bin/factory-ledger` | The ledger (one row per task) and the weekly Vietnamese digest |
| `bin/factory-queue` | The merge queue: updates one auto-merge PR at a time when `main` moves, and re-runs the tier check after the Human approves |
| `probes/` | The gate's attacks and the 20 seeded + 20 clean probes on factory-scratch: plan, driver, results |
| `scripts/verify` | This repository's own checks: the kit's tests in `test/` |
| `test/` | The kit's tests; each check is shown failing on a bad input |
| `NOTICE` | What was taken from other projects, with the commit |

## Taking a repository in

Run `bin/onboard <repo-url>` from this root. It does what the old layout did by hand:

1. clones the repository into `<root>/<repo>`;
2. creates its profile `~/.agent-profiles/<owner>/<repo>/claude`, only now; it holds state only, never edit it (a
   Codex profile joins when Codex does);
3. writes `.envrc` (`CLAUDE_CONFIG_DIR` pointing at the profile), adds it to `.git/info/exclude` and runs
   `direnv allow`; an `.envrc` the repository has is kept, and onboard prints the line to add to it;
4. lays the kit over it: `scripts/`, `.gate/`, `.githooks/`, the two gate workflows, the PR template, `CODEOWNERS`,
   deny rules, an `AGENTS.md` and the one-line `CLAUDE.md`. Files the repository already has are kept and listed in
   the pull request for its session to merge by hand;
5. runs the full `scripts/verify`, and only when it passes commits the kit and opens its pull request. When it fails
   the kit stays staged on `factory/kit` for the repository's session to finish.

Then the repository's session fills `.gate/config.sh` (test command, fast checks, its own checks with proofs),
proposes `.gate/load-bearing`, and runs the probes. The Human approves the kit pull request (tier 3), imports
`.gate/ruleset.json`, creates the `reviewer` environment, and logs into the profile in a new pane opened in the
repository (`echo $CLAUDE_CONFIG_DIR`, then `claude`).

Run `bin/factory-queue sweep --repo <owner/repo>...` from launchd every minute, logged into `gh` as the agents'
account (it refuses the Human's): the ruleset requires a branch to be up to date, GitHub updates none by itself, and
without the queue every auto-merge pull request strands when another lands. Each run is one sweep under a lock; a
repository whose sweep failed keeps `~/.local/state/factory/queue-<owner>-<repo>.failed` until one succeeds. A
rollback is a revert pull request through the gate. Only when the gate itself is broken does the Human turn the
ruleset off, after taking auto-merge off every open pull request, since with the ruleset off each would land unjudged.

Unattended runs (launchd, `herdr pane run`) start no shell and never load `.envrc`; run them as
`direnv exec <root>/<repo> claude -p "…"`.

pstack, per profile: a repository's `.claude/settings.json` may pin pstack through a `settings` marketplace; open
`claude` in a worktree of the repository, trust the folder, then install it once in that profile with `/plugin`.
