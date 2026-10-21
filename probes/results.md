# Probe results, 2026-10-21

tuannd9288/factory-scratch, GitHub-hosted runners, kit 138139d on scratch main from 5b700102, GATE_REVIEWER=stub
(no model runs). Plan and expected layers: `plan.md`, written before any probe was opened. Attacks: `attacks.md`.

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

To run the probes again: `run.sh`'s edits target the tree before the probes (scratch main 40878f3e). Scratch main has
since taken D15, D17, D19, D20 and the twenty clean changes, so first reset scratch main to 40878f3e (the ruleset off
for that push: an admin step) or make a new scratch repository from the kit.

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
