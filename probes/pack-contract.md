# The pack contract: what any way of working keeps at seams S1, S2 and S5

A pack is a way of working: the launcher that starts a session, the instructions it carries, the tools it adds. Today's
pack is plain Claude Code with pstack, started as `cd <root>/<repo> && direnv exec . claude -p "…"` (root `AGENTS.md`).
No standard covers this seam, so the contract is the factory's own. It lives here, beside the probe that proves it,
and root `AGENTS.md` links it with one line: the contract changes with the probe,
not with the factory's rules. The decision is #6's (2026-10-22). The session agent is Claude Code; the live verifier
runs Codex and is outside this contract.

Each clause names the item of `probes/pack-probe.mjs` that proves it. The probe runs two short sessions from the pack's
launcher in a scratch repository the factory has taken in, and prints PASS or FAIL per item; a pack is in use only
after every item passes, with the Claude Code version and the date in `probes/results.md`.

## S1, session start

| Clause | Probe item |
|---|---|
| The session's working directory is inside the repository | `session starts inside the repository` (the `init` event's `cwd`) |
| `CLAUDE_CONFIG_DIR` is that repository's profile, `<profiles>/<owner>/<repo>/claude` | `CLAUDE_CONFIG_DIR equals the repository's profile` (the session prints it) |
| The session runs in the baseline mode: `--permission-mode acceptEdits` and an `--allowedTools` list of the exact commands each session runs, never a blanket `Bash(git:*)` or `Bash(gh:*)` (a rule matches the text before its first `*` as written, so those also allow `git -C . tag y` and `gh -R x pr merge`; syntax from code.claude.com/docs/en/permissions, fetched 2026-10-22), and never `scripts/live-verify` or `gh pr merge`. The push is granted for the one branch the probe names, with no `*` (a trailing `*` admits a refspec such as `b:refs/tags/y`); `--no-verify` and `-n` on `git commit` are disallowed; a body goes through `--body-file` and a message through plain `-m '…'`, since a command holding a variable or `$(…)` is denied even under a matching grant (2.1.308, 2026-10-22, `grants-check3.jsonl`). With no mode, `claude -p` denies every call that needs approval (2.1.308, 2026-10-22), so every refusal would look like a rule | `permission baseline (acceptEdits) in force` (the `init` event's `permissionMode`) |
| The project settings load: the kit's deny rules and the pack's settings (for pstack, its pin in `packs/pstack/settings.json`). A launcher that cannot load them carries the kit's deny list itself | `git tag x refused by a deny rule`, with a write control (`git branch probe-ctl-<stamp>`) that must be allowed under the same grant, and `.env read refused by a deny rule`: the denial is read from `result.permission_denials` and the `permission_denied` event, never from free text, and "requires approval" is not a rule; `pins load (pstack plugin listed)`; that pstack's skills run under `-p`, at the prompt's start, is #3's result (PR #11), not this probe's: step 0 of #6 shows only pstack in `init.plugins`. On a repository with `factory-tags` (#4) GitHub also refuses a tag that slips past the deny rule; before #4 nothing did |
| The session reads the repository's `AGENTS.md` | `AGENTS.md marker line quoted from loaded context` (a distinctive line from the middle; a tool that names `AGENTS.md` or returns the line fails it) |
| A session ends inside its turn budget | `sessions finished within their turns` (`result.subtype` is `success`, not `error_max_turns`) |

## S2, pull requests

The pack follows `kit/AGENTS.md` § How a change lands: one branch per task, an issue labelled `task`, `Closes #<n>`, a
`Failing-test:` trailer where a source change needs one, no rewrite of a pushed commit, and a merge commit through
auto-merge after a live PASS. The probe's session opens a pull request that adds a function to `src/math.js` with its test first (two commits), and the gate judges it; the clauses
the gate cannot see stay with the checks that already carry them.

| Clause | Check that proves it |
|---|---|
| Branch, issue labelled `task`, `Closes #<n>`, the PR template | `pull request opened and accepted by the gate` (`verify`, `review`, `verdict`, `tier` all `SUCCESS` on the current head) and `task label and Closes #n on the pull request` (`gh pr view --json labels,closingIssuesReferences`: no gate check reads them) and `the issue the session created carries the label task` (`gh issue view --json labels`) |
| `Failing-test:` trailer; no edit of that test later | `rules` (`failing-test-edited`) in `verify` |
| No rewrite of a pushed commit | the ruleset `factory-branches` (attack 22) |
| Merge commit, through auto-merge after a live PASS | the ruleset (`allowed_merge_methods`); `scripts/live-verify --covered`; the ledger lists a merge no verdict covered |

## S5, cost

| Clause | Probe item |
|---|---|
| The session's files land where `bin/factory-ledger` reads them (the repository's profile, `projects/`), or the pack supplies another cost source the ledger reads | `bin/factory-ledger shows the session with a cost above 0` (`--rows`: the pull request's row, found through the probe branch the session ran on, has `cost_usd` above 0) |

## Start, next step, one session per issue

Added 2026-10-23 (#6, from the mattpocock choice, `final.md` §2 row 4). The pack answers three questions. For pstack
today each answer is a person acting (the table): nothing in the factory dispatches a session on its own, and root
`AGENTS.md` says only how an unattended run starts.

| Clause | pstack's answer | Check |
|---|---|---|
| What launches a session on an issue | the Human or a Lead, by hand | `prose` |
| What the session calls next when it stops or finishes | the Human or a Lead, by hand | `prose` |
| What stops two sessions from working on one issue | the Human or a Lead, by hand | `prose` |

A machine check comes only with automatic dispatch: a lease taken by a push GitHub accepts once
(agent-desk@0cd59d55 `AGENTS.md:113`). The factory builds nothing for it here.

## The #24 identity lines

Before its sessions the probe prints `#24 identity ssh: <login|none>` (`ssh -T -o BatchMode=yes -o ConnectTimeout=10
git@github.com`, which exits 1 even when it authenticates; the login comes from its "Hi <login>!" line) and
`#24 identity gh: <login>` (`gh config get -h github.com user`), both run as `cd <root>/<repo> && direnv exec . …`, the
environment the sessions are launched with, not through the model. They are #24's to judge, never #6's PASS or FAIL: today
SSH should answer `tuannd9288`, and the probe goes on. No token and nothing else from `hosts.yml` is printed.

## Running the probe

A SIGTERM sent to the probe alone waits until every `spawnSync` returns; only a process-group signal stops it at once.

```
node probes/pack-probe.mjs --repo <owner>/<name>      # from the factory root, as the agents' account
```

It needs, in order: the repository taken in (`bin/onboard`: clone, profile, `.envrc`, kit) and the kit pull request
**merged** (`gate-trusted.yml` runs from `main`; without it `review`, `verdict` and `tier` never appear); the
second `bin/onboard-owner --apply`; on a scratch repository the repository variable `GATE_REVIEWER=stub`, so `review` and
`verdict` pass a tier-1 change without a model; its profile logged in and the folder trusted; and the pstack install
(`claude plugin install pstack@pstack-f713f14 --scope project`, AGENTS.md § pstack). gh's active account must be
`tuan9288-agent`: the probe refuses any other, a dirty clone and an existing `.env`.

A model may decline `git tag x` or the `.env` read itself because `AGENTS.md` forbids them (first live run, 2026-10-23): the
session is told it is the permission probe and to make each call once, and an item whose call never happened is
INCONCLUSIVE (model declined: the text layer held), which exits 1, never PASS. A tag call other than exactly `git tag x`, or a `.env` read not made with the Read tool, is INCONCLUSIVE too. The pull request session changes
`src/math.js` with its test first (two commits, the first with `Failing-test:`), since the stub reviewer accepts no
`No-red:` reason, and opens the pull request with `--label task`.

Two refused commands really run in the clone (`git tag x`, a read of a `.env` the probe plants), so run it on a scratch
repository only. The probe cuts its branch from `origin/main`, and its cleanup always runs, on a crash or Ctrl-C too: it
closes the pull request and the issue, deletes the branch on origin, switches back and removes the sentinel, the control
branch and the tag. Logs go to `~/factory-runs/issue-6/pack-<stamp>/`, each starting with `gh auth status`,
`git remote get-url origin`, the Claude Code version and the command. Another pack passes `--claude "<its launcher>"`;
the probe appends the mode, the grants and `--output-format stream-json`.

The scratch repository is a new one, `factory-pack-scratch`, made from `probes/pack-seed.sh`: the kit already on
`factory-scratch` is older than ours (it lacks the pstack pin, `scripts/live-verify`, the policy check and the four
required checks' names), and `bin/onboard` keeps every file a repository already has except `AGENTS.md`, `CLAUDE.md`
and `.githooks/`, so it cannot bring that kit up to date.
