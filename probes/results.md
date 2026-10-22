# Probe results, 2026-10-21

tuannd9288/factory-scratch, GitHub-hosted runners, kit 138139d on scratch main from 5b700102, GATE_REVIEWER=stub
(no model runs). Plan and expected layers: `plan.md` as of commit 15d6e21, written before any probe was opened.
Attacks: `attacks.md`. The plan for the next run, with both bars, is the current `plan.md`.

| Measure | Result | 95% Wilson | Bar | Met |
|---|---|---|---|---|
| Seeded defects caught | 16/20 | 58.4–91.9% | at least 18/20 | no |
| Load-bearing defects caught (src/auth/, src/send.js) | 5/7 | 35.9–91.8% | all | no |
| Clean changes blocked | 0/20 | 0.0–16.1% | at most 1/20 | yes |
| Defects a mechanical layer should catch (class M) | 16/16 | 80.6–100% | | |
| Defects only a reviewer could catch (class R) | 0/4 | 0.0–49.0% | | |

Every miss is class R and was predicted in `plan.md`: D15 (a test changed to expect the new wrong behaviour),
D17 (a bug the new test does not reach), D19 (MACs compared with `===`, behind a No-red line), D20 (a postinstall
script in package.json). The stub reviewer cannot catch them; the bar waits on a real reviewer behind review and
verdict.

Deviations from the plan: D12 as built changed only `test/auth/` (the plan said it would also change token.js), so
the gate rated it tier 1, not load-bearing; it was caught by rules (failing-test-edited). C20 landed through
auto-merge at 11:24:02Z (merge 22893d7, its head 63167e0 green on all six checks); a later push of main's commit to
its branch, mine, turned the PR record to CLOSED. Every clean change was dry-run locally with verify and red-check
before it was opened, as an agent would; the defects were only checked to build.

The tier-3 approval in verdict was seen refusing D16 on scratch ("the only code owner (@tuannd9288) wrote this pull
request"); approve, re-run and merge could not be checked with one GitHub identity and is covered by the kit tests.

To run the probes again: the builders (`probes.sh`) edit the tree before the probes (scratch main 40878f3e). Scratch
main has since taken D15, D17, D19, D20 and the twenty clean changes, so the next run uses a new scratch repository
seeded from that tree, named by `PROBE_REPO`.

Every merge on scratch main after the ruleset (31, `tree.sh`): merged tree equal to the judged head's tree, head
already holding main, six of six required checks green on that head.

| Probe | PR | Tier | Outcome | Required checks that failed on the judged head |
|---|---|---|---|---|
| D1 | #15 | tier-1 | blocked, closed after | rules,verify |
| D2 | #16 | tier-1 | blocked, closed after | red-check,rules,verify |
| D3 | #17 | tier-1 | blocked, closed after | red-check,rules,verify |
| D4 | #18 | tier-1 | blocked, closed after | red-check,rules,verify |
| D5 | #19 | tier-1 | blocked, closed after | red-check,verify |
| D6 | #20 | tier-1 | blocked, closed after | red-check |
| D7 | #21 | tier-2 | blocked, closed after | rules,verify |
| D8 | #22 | tier-2 | blocked, closed after | rules,verify |
| D9 | #23 | tier-2 | blocked, closed after | red-check,rules,verify |
| D10 | #24 | tier-1 | blocked, closed after | rules,verify |
| D11 | #25 | tier-1 | blocked, closed after | rules,verify |
| D12 | #26 | tier-1 | blocked, closed after | rules,verify |
| D13 | #27 | tier-2 | blocked, closed after | red-check,verify |
| D14 | #28 | tier-2 | blocked, closed after | red-check,verify |
| D15 | #29 | tier-2 | landed | - |
| D16 | #30 | tier-3 | blocked, closed after | red-check,verdict,verify,verify-trusted |
| D17 | #31 | tier-1 | landed | - |
| D18 | #32 | tier-1 | blocked, closed after | red-check,verify |
| D19 | #33 | tier-2 | landed | - |
| D20 | #34 | tier-2 | landed | - |
| C1 | #35 | tier-1 | landed | - |
| C2 | #36 | tier-1 | landed | - |
| C3 | #37 | tier-1 | landed | - |
| C4 | #38 | tier-1 | landed | - |
| C5 | #39 | tier-1 | landed | - |
| C6 | #40 | tier-1 | landed | - |
| C7 | #41 | tier-2 | landed | - |
| C8 | #42 | tier-2 | landed | - |
| C9 | #43 | tier-2 | landed | - |
| C10 | #44 | tier-1 | landed | - |
| C11 | #45 | tier-1 | landed | - |
| C12 | #46 | tier-1 | landed | - |
| C13 | #47 | tier-1 | landed | - |
| C14 | #48 | tier-2 | landed | - |
| C15 | #49 | tier-1 | landed | - |
| C16 | #50 | tier-1 | landed | - |
| C17 | #51 | tier-1 | landed | - |
| C18 | #52 | tier-1 | landed | - |
| C19 | #53 | tier-1 | landed | - |
| C20 | #54 | tier-1 | landed | - |

## Attack 23 and the pin trial (issue #3), Claude Code 2.1.308, 2026-10-22

Folders on the Mac mini under `~/factory-probes/attack-23`: `case2/{a,b}` (names `pstack-f713f14`, `pstack-1e5c90a`),
`case1/{a,b}` (name `pstack-pin` in both, pins f713f14 and 1e5c90a). Each holds one commit with its settings file.
Logs: `~/factory-runs/issue-3/`.

**Registry half, unlogged scratch profile (`CLAUDE_CONFIG_DIR=$T/registry`): no login asked, but it fails.**
`claude plugin install pstack@pstack-f713f14 --scope project` printed `Plugin "pstack" not found in marketplace
"pstack-f713f14"`, likewise for `pstack-1e5c90a` and `pstack-pin`; `plugin list --json` was `[]` and no `plugins/`
directory appeared. That profile was fresh, never logged in and had trusted nothing, all at once. The same install
on the writer profile, which trusted `case2/a`, succeeded. Control (`fix-3a-control.log`): on the writer profile, logged
in, in `case1/a`, which it has not trusted, `claude plugin install pstack@pstack-pin --scope project` failed with the
same `not found` error. So an untrusted folder fails even on a logged-in profile.

**Case 2 (two names, one writer profile, installs without cache override): each folder loads its own pin; `git status`
failed before the reorder and is empty after; the registry checks were not run.**
- `plugin list --json` run from `a` showed `pstack@pstack-f713f14` 0.15.25 `enabled: true` and `pstack@pstack-1e5c90a`
  `enabled: false`; run from `b` the reverse. `claude -p --max-turns 1 --output-format stream-json --verbose "reply ok"`:
  the `init` event's `plugins[]` for `a` held `pstack` at `.../plugins/cache/pstack-f713f14/pstack/0.15.25` and for `b`
  `.../cache/pstack-1e5c90a/pstack/0.15.24`; 54 pstack skills listed in each. Both marketplaces are in
  `plugin marketplace list --json`.
- `git status --porcelain` before the reorder: ` M .claude/settings.json` after the install (22 lines moved, same
  content). After shipping the file in the installer's order (`jq --indent 2 '{permissions, enabledPlugins,
  extraKnownMarketplaces}'`, `cmp`-identical to what the installer wrote), committed as the baseline in `case2/a`:
  uninstall left ` M` with one change, `"enabledPlugins": {}` in place of `{"pstack@pstack-f713f14": true}`
  (`fix-2-proof.log`); after the install again, `git status --porcelain` was empty.
- With `CLAUDE_CODE_PLUGIN_CACHE_DIR=$C/plugins` (the plan's session half) an empty override made the install fail with
  the same `not found` error, and a session loaded no pstack (`init` lists only the three builtin plugins). An empty
  override loads nothing; a filled one was not tried.
- Not run: `.orphaned_at` and `known_marketplaces.json` stability across the third listing sit in the profile, which an
  agent does not open. The three `plugin list` outputs above were stable.

**Case 1 (one name, two pins), and the registry checks, move to #9, the shared writer profile.** Not run here: the
`case1` folders are untrusted by the writer profile.

**#3 proper, `case2/a`, writer profile, no override.** The profile was set by `CLAUDE_CONFIG_DIR` in the environment
of both unattended runs, with no `.envrc` and no `direnv exec`.
- Interactive (Herdr sibling pane, `claude` v2.1.308): typed `/pstack:poteto-mode say which skill you are running and
  stop`; output `I'm running the pstack:poteto-mode skill. I've stopped there as you asked.` The typed form resolves.
- Unattended, typed form: `claude -p --max-turns 2 --output-format stream-json --verbose "/pstack:poteto-mode say
  which skill you are running and stop"` answered `I'm running the **poteto-mode** skill from the pstack plugin,
  version 0.15.25.` The skill ran.
- Unattended, skill named in prose, prompt `Run the pstack poteto-mode skill (Skill tool, skill name
  pstack:poteto-mode) with the task: say which skill you are running and stop.`: the model called the Skill tool and
  got `Skill pstack:poteto-mode cannot be used with Skill tool due to disable-model-invocation. Ask the user to run
  /pstack:poteto-mode themselves`. It did not run.
- Answer to the open question: `disable-model-invocation: true` stops a skill the prompt only names, not one the prompt
  starts with its slash. pstack can run unattended, so choice (a): unattended prompts start the skill with
  `/pstack:<skill>` at the prompt's start. pstack's two agents have no such guard (`init` lists `pstack:poteto-agent`
  and `pstack:comment-sicko`); #8 decides whether to forbid them in unattended runs.
