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

## Issue #4: the tag ruleset and attack 22, 2026-10-22

On `tuannd9288/factory-scratch`, cloned over HTTPS only, as `tuan9288-agent` (`gh auth status` showed it active before
every push). Rulesets imported by the Human: `factory-branches` (id 25631764), `factory-tags` (id 25631767, only bypass
`RepositoryRole` 5). Logs: `~/factory-runs/issue-4/`.

- **Tag push, refused.** `git tag probe-agent-tag && git push origin probe-agent-tag`: `GH013: Repository rule violations
  found for refs/tags/probe-agent-tag ... Cannot create ref due to creations being restricted`.
- **Release that creates a tag, refused.** `gh release create probe-agent-release --target main --notes probe -R tuannd9288/factory-scratch`:
  `HTTP 422 ... Cannot create ref due to creations being restricted. Published releases must have a valid tag`.
- **Draft release, accepted.** `gh release create probe-agent-draft --draft --notes probe -R tuannd9288/factory-scratch`
  created an untagged draft (`.../releases/tag/untagged-ad55...`), so `factory-tags` refuses a release only when it would
  create a tag ref; a draft, a release on an existing tag, an edit and a delete are not covered (only the draft was
  probed). I deleted it at once with `gh release delete probe-agent-draft --yes` (listing empty after). Logs
  `probe5-draft.log`, `probe5-draft-delete.log`, each starting with the date, identity (`tuan9288-agent` active), remote
  and command.
- `probe2-release.log` holds no identity line; the run shows `tuan9288-agent` active in `probe1-tag.log` lines 4-5.
- **The Human's half (the Lead's comment on #4, which makes his release the bypass evidence):** as admin
  `tuannd9288` he created the release `probe-human-tag` (`--target main`) and deleted it with `--cleanup-tag`; both succeeded, so `RepositoryRole` 5 resolves and bypasses.
  A `git push` of a tag by him was not run; his release stands as the bypass evidence.
- **Attack 22, passes.** `probe-22` cut from `main~1` plus one commit (`59ec9a5`), pull request #55, behind `main`.
  `gh pr update-branch 55`: `PR branch updated` (merge commit `0297d7b`). Then `git reset --hard 59ec9a5` and
  `git push --force-with-lease origin probe-22`: `GH013 ... Cannot force-push to this branch`; the remote stayed at
  `0297d7b`. `gh pr close 55 --delete-branch` closed it and deleted the branch (`non_fast_forward` does not refuse a
  deletion). So `factory-branches` on `~ALL` holds with the queue's update-by-merge.
- **Change:** `bin/rulesets/tags.json` is `factory-tags` as imported; `bin/onboard-owner` wants it before and after the
  kit lands, and its tests cover the file, the dry run, `--apply`, the read-back and a changed bypass list. Its live dry
  run and apply on a fresh repository happen at #6's sitting, as the Human's step.
