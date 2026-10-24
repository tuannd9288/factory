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
| 3 | a path in `.gate/protected` (the gate, `AGENTS.md`, `.claude/`, test and lint configuration), or the label `needs-human` | tier 2 and his approval of the head commit, or of one whose patch the head carries unchanged, which `tier` checks | approves from the summary |

A tier never drops within a pull request: every label `tier-N` or `needs-human` it ever had raises it, even once
removed.

Agents open pull requests under their own GitHub account, never the Human's. GitHub refuses an author's approval of
his own pull request, and its code-owner rule asks nothing of an author who owns the code: on the scratch repository
a tier-3 pull request opened from the Human's account merged with no approval (2026-10-21). So the `tier` check
itself requires, on tier 3, an approval of the head commit by a code owner who is not the author.

## What the Human keeps

- Tier 3 approvals, `needs-human` pull requests (stuck after three rounds), and every deploy.
- Admin steps: running `bin/onboard-owner` (the agents' account, rulesets, the `reviewer` environment), the
  reviewer's secrets, registering the runner.
- Logging into a repository's profile and the verifier's Codex profile. An agent never logs in or switches accounts.

Everything else that can be undone, agents decide and report after.

## This root

- No `CLAUDE.md` here. With one, Claude Code reads it and skips the `AGENTS.md` of every repository below
  (tested on Claude Code 2.1.304, 2026-10-20). Each repository keeps a one-line `CLAUDE.md`: `@AGENTS.md`.
- Nothing in a repository points outside it: no links into `~/Desktop/TuanHub`, no user-level skills.
- This folder stays out of every sync between the Macs. Code moves only through GitHub.
- `.gitignore` admits only the factory's own files, so every repository folder is ignored.
- A change to `kit/` changes every repository's gate at its next kit pull request: it is tier 3 here.
- The weekly digest is `bin/factory-ledger --post tuannd9288/factory`: it posts even when the canary (`--check`) finds a
  field missing or stale, saying so in one line. No job runs it yet; its schedule (launchd, as the agents' account) is
  the Human's to set up.

| Path | What it is |
|---|---|
| `kit/` | What every repository receives through one pull request when it joins |
| `bin/onboard-owner` | The Human's half of taking a repository in: account, rulesets, `reviewer` environment |
| `bin/onboard` | The agents' half: clone, profile, kit, verify, the kit pull request |
| `bin/kit-evidence` | Proves the kit pull request's files are the kit at one factory commit, by git object |
| `bin/rulesets/` | The rulesets `bin/onboard-owner` sets besides the kit's gate |
| `bin/factory-ledger` | The ledger (one row per task) and the weekly Vietnamese digest; it charges an entry to a repository by its own profile, or by `cwd` under `<root>/<repo>` in `--profile-dir` folders; `--check` is its canary on Claude Code's session format |
| `bin/factory-queue` | The merge queue: updates one auto-merge PR at a time when `main` moves, and re-runs the tier check after the Human approves |
| `probes/` | The gate's attacks and the 20 seeded + 20 clean probes on factory-scratch: plan, driver, results, `score.mjs` (scores the heads, costs per job, stops at the first unavailable reviewer); `probes/pack-contract.md` is what a way of working keeps, `probes/pack-probe.mjs` proves it |
| `scripts/verify` | This repository's own checks: the kit's tests in `test/` |
| `test/` | The kit's tests; each check is shown failing on a bad input |
| `NOTICE` | What was taken from other projects, with the commit |

## Taking a repository in

Two halves, the Human's first. From this clone, logged into `gh` as the repository's owner, he runs
`bin/onboard-owner <owner/repo> --id <id>`, reads the changes it prints, and runs it again with `--apply`. The id is
the repository's own (`gh api repos/<owner/repo> --jq .id`), so a typo or a renamed repository is refused. It invites
the agents' account (write), sets `factory-branches` (every branch: no rewrite), `factory-tags` (every tag: no create,
update or delete, but for a repository admin) and `factory-bootstrap` (`main`: a pull request, one approval of the
last push, merge commits only), creates the `reviewer` environment for `main`, and
reads it all back; it calls only `gh api`, never `git` and nothing the repository holds. Once the agents' account
has accepted the invitation, an agent runs `bin/onboard <repo-url>` from this root, logged into `gh` as that account.
It refuses any other login, and a `main` without the bootstrap pull request rule:

1. clones the repository into `<root>/<repo>`;
2. creates its profile `~/.agent-profiles/<owner>/<repo>/claude`, only now; it holds state only, never edit it (a
   Codex profile joins when Codex does);
3. writes `.envrc` (`CLAUDE_CONFIG_DIR` pointing at the profile), adds it to `.git/info/exclude` and runs
   `direnv allow`; an `.envrc` the repository has is kept, and onboard prints the line to add to it. Either way
   `.claude/worktrees/` joins `.git/info/exclude`: Claude Code's worktrees go there, inside the repository, so they
   find its `.envrc`, and `git add -A` never stages one under the tier-3 `.claude/`;
4. lays the kit over it: `scripts/`, `.gate/`, `.githooks/`, the gate workflows, the PR template, `CODEOWNERS`,
   deny rules, an `AGENTS.md` and the one-line `CLAUDE.md`. The repository's own `AGENTS.md`, `CLAUDE.md` and hooks
   are replaced, since a kept one would switch the kit's off; the parts of them the Human approved come in through
   `--own <file>`, which holds only the kit `AGENTS.md`'s last two sections, `## Layout` and `## Facts the code cannot
   tell`, within its 150 lines (`bin/lib/own.mjs`). A repository with its own `AGENTS.md` or `CLAUDE.md` and no
   `--own` is refused and its clone removed. Every other file the repository already has is kept. Both lists go in
   the pull request, kept ones for its session to merge by hand, and the old hook's commands into `gate_fast`;
5. runs the full `scripts/verify`, and only when it passes commits the kit and opens its pull request, authored by
   the agents' account. When it fails the kit stays staged on `factory/kit` for the repository's session to finish.
   The pull request carries `bin/kit-evidence`'s result: every managed file against the kit at the factory commit
   (contents, modes, symlinks), the two rendered files line by line with the `--own` parts in full, the files the
   kit replaced with the blob each had, the files the repository kept, and nothing else changed, bound to that commit, the kit's tree, the repository's id, base and head. Onboard opens it only from a
   factory commit on `origin/main` whose `kit/` has no uncommitted, untracked or ignored file, since it lays the kit
   from the working tree.

Then the repository's session fills `.gate/config.sh` (test command, fast checks, its own checks with proofs),
proposes `.gate/load-bearing`, and runs the probes. The Human approves the kit pull request (the bootstrap rule asks
for his approval), runs `bin/onboard-owner … --apply` again once it merged, which puts the kit's `factory-gate` in and
only then takes `factory-bootstrap` out, sets the reviewer's secrets in `reviewer`, and logs into the profile in a new
pane opened in the repository (`echo $CLAUDE_CONFIG_DIR`, then `claude`).

Run `bin/factory-queue sweep --repo <owner/repo>...` from launchd every minute, logged into `gh` as the agents'
account (it refuses the Human's): the ruleset requires a branch to be up to date, GitHub updates none by itself, and
without the queue every auto-merge pull request strands when another lands. Each run is one sweep under a lock; a
repository whose sweep failed keeps `~/.local/state/factory/queue-<owner>-<repo>.failed` until one succeeds; a run that
fails before its repository loop keeps `queue-run.failed` until a run gets past it; a clean sweep writes
`queue-<owner>-<repo>.ok`, and the weekly digest lists every such file. A sweep that holds the lock records its pid in
`queue.lock`: if the queue stops and that pid is not running, remove `~/.local/state/factory/queue.lock` by hand. A
rollback is a revert pull request through the gate. Only when the gate itself is broken does the Human turn the
ruleset off, after taking auto-merge off every open pull request, since with the ruleset off each would land unjudged.
The queue leaves a tier-3 pull request behind `main` until the Human approved it, then updates it once; his approval
holds on the updated head, whose patch is unchanged (`git patch-id`), so he is asked once.

`bin/factory-queue plist --repo <owner/repo>...` prints that job, `com.tuanhub.factory.queue`: every 60 s from this
clone, with the `gh` and `node` the shell finds, logging to `~/Library/Logs/factory/queue.log`. Before loading it, run
`bin/factory-queue check` with the same repositories from the same shell, in a terminal on that machine (over SSH `gh`
cannot read the keychain): it runs one sweep in the job's environment, makes the log's folder, which launchd does not,
and says whether the job is ready. The Human saves the plist in `~/Library/LaunchAgents/`, loads it with `launchctl bootstrap gui/$(id -u) <plist>` and stops it with
`launchctl bootout gui/$(id -u)/com.tuanhub.factory.queue`, under the account #24 settles. `tuannd9288/factory` itself
is not swept: its ruleset dismisses an approval on any push, so an update would ask the Human twice.

The live verifier runs on one Codex profile for every repository, `~/.agent-profiles/verifier/codex`, which only
the Human logs in: `mkdir -p ~/.agent-profiles/verifier/codex`, then `CODEX_HOME=~/.agent-profiles/verifier/codex`
before Codex's own login command. Until he has, every live verdict is BLOCKED and nothing auto-merges.

Unattended runs (launchd, `herdr pane run`) start no shell and never load `.envrc`; run them as
`cd <root>/<repo> && direnv exec . claude -p "…" --permission-mode acceptEdits --allowedTools "Bash(git branch work-*)" "Bash(git add *)" …`.
`direnv exec DIR` loads DIR's `.envrc` but keeps the caller's directory (from `/` it printed `/`, 2026-10-22), so
without the `cd` Claude starts outside the repository: on the right profile, but without its deny rules and its
`AGENTS.md`. With no permission mode `claude -p` starts in `default` and denies every call that needs approval
(2.1.308, 2026-10-22: `git branch x` gave "This command requires approval"); name the mode and the exact commands the
run may use (code.claude.com/docs/en/permissions, fetched 2026-10-22). A rule matches the text before its first `*`
as written, so a blanket `git` or `gh` grant also allows `git -C . tag y` and `gh -R x pr merge`, and a
trailing `*` admits any arguments, a refspec included (`git push origin b:refs/tags/y`): grant a push with no `*`. A
deny rule still wins over a grant; a command holding a variable or `$(…)` is denied even under a matching grant
(2.1.308, grants-check): use `--body-file`, a plain `-m '…'`.

pstack, per repository: the kit's `.claude/settings.json` pins it through a `settings` marketplace named for the
commit (`pstack-f713f14`, a `git-subdir` source at the full SHA) and enables it at project scope. Once per repository
and profile, after the Human has opened `claude` in the repository and trusted the folder, install it from the
repository root with `claude plugin install pstack@pstack-f713f14 --scope project`. Never at user scope: no install
without `--scope project`, and never the `--marketplace` form, which declares the marketplace in the profile's user
settings. A new pin is a new marketplace name, in a tier-3 pull request per repository; attack 23 checks that two
pins share one profile without clashing. Found on Claude Code 2.1.308, 2026-10-22 (`probes/results.md`, attack 23):

- The install fails with `Plugin "pstack" not found in marketplace` in a folder the profile has not trusted (logged-in
  writer profile, untrusted `case1/a`). The kit ships `.claude/settings.json` in the order the installer writes: uninstalling
  and installing again in `case2/a` on the same profile left `git status` empty (a first install on a new profile was
  not tried). An uninstall rewrites `enabledPlugins` to `{}`.
- 53 of 54 pstack skills carry `disable-model-invocation`, so the model's own Skill call is refused; `setup-pstack`
  does not. The agents `pstack:poteto-agent` and `pstack:comment-sicko` have no guard: a model may spawn them, and with
  poteto-agent poteto-mode's playbook, in a run nobody typed (#8 decides whether to forbid that).
- `claude -p "/pstack:poteto-mode …"` starts the skill; a prompt that only names it does not. So an unattended prompt
  starts a skill explicitly with `/pstack:<skill>` at its start; without that the run follows the kit's `AGENTS.md`
  and whatever the model spawns.
- Two pins under two marketplace names share one profile, each folder loading its own.

pstack is a Cursor plugin; in Claude Code its texts run, and these parts do not, so the factory does not use them:

- `/setup-pstack`: it writes `~/.cursor/rules/pstack-models.mdc`, a Cursor rule for the whole machine that Claude
  Code never loads. Every role keeps its default model.
- Autopilot's owners and swarm of verifiers: Cursor cloud agents. Shipping's one verifier per pull request is taken,
  on the Codex CLI instead (`scripts/live-verify`, kit `AGENTS.md` § The live verifier); its verdict is no gate
  input, so the gate's reviewer (`review`, `verdict`) stays the only judge the merge waits for.
- The transcript readers (recall, reflect, session pickup, eval, show-me-your-work's audit): they read
  `~/.cursor/projects/<slug>/agent-transcripts/`, where Claude Code writes nothing. Adapted, they would read the
  Human's own profile, which the kit's deny rules refuse.
- `cursor-team-kit`'s `deslop`, `control-ui` and `control-cli`: they ship in another Cursor plugin, not in pstack.
