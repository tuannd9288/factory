# The pack contract: what any way of working keeps at seams S1, S2 and S5

A pack is a way of working: the launcher that starts a session, the instructions it carries, the tools it adds. Today's
pack is plain Claude Code with pstack, started as `cd <root>/<repo> && direnv exec . claude -p "…"` (root `AGENTS.md`).
No standard covers this seam, so the contract is the factory's own. It lives here, beside the probe that proves it,
and root `AGENTS.md` links it with one line: that file is at its line budget, and the contract changes with the probe,
not with the factory's rules. The decision is #6's (2026-10-22). Claude Code is the only agent that runs (settled).

Each clause names the item of `probes/pack-probe.mjs` that proves it. The probe runs two short sessions from the pack's
launcher in a scratch repository the factory has taken in, and prints PASS or FAIL per item; a pack is in use only
after every item passes, with the Claude Code version and the date in `probes/results.md`.

## S1, session start

| Clause | Probe item |
|---|---|
| The session's working directory is inside the repository | `session starts inside the repository` (the `init` event's `cwd`) |
| `CLAUDE_CONFIG_DIR` is that repository's profile, `<profiles>/<owner>/<repo>/claude` | `CLAUDE_CONFIG_DIR equals the repository's profile` (the session prints it) |
| The project settings load: the kit's deny rules and the pstack pin. A launcher that cannot load them carries the kit's deny list itself | `git tag x refused` (with a `git status` control that must run) and `.env read refused`; `pins load (pstack plugin listed)` |
| The session reads the repository's `AGENTS.md` | `AGENTS.md marker line quoted` (a line the probe picks, quoted without a tool) |
| The session runs on Claude Code only | the launcher is `claude`; the `init` event comes from it |

## S2, pull requests

The pack follows `kit/AGENTS.md` § How a change lands: one branch per task, an issue labelled `task`, `Closes #<n>`, a
`Failing-test:` trailer where a source change needs one, no rewrite of a pushed commit, and a merge commit through
auto-merge after a live PASS. The probe's session opens a docs-only pull request and the gate judges it; the clauses
the gate cannot see stay with the checks that already carry them.

| Clause | Check that proves it |
|---|---|
| Branch, issue labelled `task`, `Closes #<n>`, the PR template | `pull request opened and accepted by the gate` (`verify`, `review`, `verdict`, `tier` all `SUCCESS` on its head) and the ledger row below, which counts the task from the label |
| `Failing-test:` trailer; no edit of that test later | `rules` (`failing-test-edited`) in `verify` |
| No rewrite of a pushed commit | the ruleset `factory-branches` (attack 22) |
| Merge commit, through auto-merge after a live PASS | the ruleset (`allowed_merge_methods`); `scripts/live-verify --covered`; the ledger lists a merge no verdict covered |

## S5, cost

| Clause | Probe item |
|---|---|
| The session's files land where `bin/factory-ledger` reads them (the repository's profile, `projects/`), or the pack supplies another cost source the ledger reads | `bin/factory-ledger shows the session with a cost` (`--rows`: the pull request's row has `cost_usd` and it is not null) |

## Running the probe

```
node probes/pack-probe.mjs --repo <owner>/<name>      # from the factory root, as the agents' account
```

It needs the repository taken in (`bin/onboard`: clone, profile, `.envrc`, kit), its profile logged in, the folder
trusted, and on a scratch repository the repository variable `GATE_REVIEWER=stub`, so `review` and `verdict` pass a
tier-1 change without a model. The two refused commands are really run in the clone (`git tag x`, a read of a `.env` the
probe plants and removes), so run it on a scratch repository only. Logs go to `~/factory-runs/issue-6/pack-<stamp>/`,
each starting with `gh auth status`, `git remote get-url origin`, the Claude Code version and the command.
Another pack passes `--claude "<its launcher>"`; the probe appends `-p --max-turns … --output-format stream-json`.

The scratch repository is a new one, `factory-pack-scratch`, made from `probes/pack-seed.sh`: the kit already on
`factory-scratch` is older than ours (it lacks the pstack pin, `scripts/live-verify`, the policy check and the four
required checks' names), and `bin/onboard` keeps every file a repository already has except `AGENTS.md`, `CLAUDE.md`
and `.githooks/`, so it cannot bring that kit up to date.
