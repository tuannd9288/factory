# Gate attacks on tuannd9288/factory-scratch, 2026-10-21

| # | Attack | Result |
|---|---|---|
| 1 | tier 1 auto-merges; tier 3 waits for the code owner | tier 1 held (with the queue); tier 3 FAILED, fixed in verdict, approval path not checkable with one identity |
| 2 | forged status | held |
| 3 | stale verdict | held |
| 4 | missing, failing-closed or cancelled verdict | held; a re-run clears a failure |
| 5 | verify replaced by `exit 0` | held (verify-trusted) |
| 6 | a job reading secrets | environment secret held; repository-level secret readable from any branch (deleted; prose rule) |
| 7 | a job posting its own status | not a 403: a candidate's own workflow can post; the posts did not mask failures; red-check gap fixed |
| 8 | writer negatives | push, force push, delete, `--admin`, self-approval held; tags and releases are not refused by GitHub |
| 9 | merged tree equal to the judged one | held on all 31 merges |
| 10 | rollback with PRs waiting on auto-merge | held with `factory-queue pause` / `resume` |

Ruleset factory-gate id 25538180 applied 2026-10-21 (admin, authorized for scratch), bypass list empty.
Scratch main before attacks: 9dcc0e86. Identity for everything: tuannd9288 (repo admin, the only identity).

## 8. Writer negatives (run first, before anything that depends on enforcement)
- push to main: refused, GH013 "push declined due to repository rule violations". HELD.
- force push (sibling commit 60ef8e7 onto main): refused, GH013 "Cannot force-push to this branch". HELD.
- delete main: refused, "refusing to delete the current branch". HELD (GitHub default-branch rule and ruleset deletion rule).
- `gh pr merge --admin` on red PR #4: refused, "Repository rule violations found, 2 of 6 required status checks are failing". HELD.
- self-approve PR #4: refused, "Can not approve your own pull request". HELD (GitHub).
- `gh release create attack-8-probe`: SUCCEEDED; tag push attack-8-tag: SUCCEEDED. Both deleted at once (0 tags left).
  No server-side enforcer; only the kit's .claude/settings.json deny rule, which binds Claude Code sessions alone.

## 2. Forged status
- PR #4 head fafb18ae, real verify and red-check FAILED (squash broken, no test).
- POST statuses verify=success and red-check=success as tuannd9288: accepted by the API, mergeStateStatus stayed BLOCKED,
  `gh pr merge` refused ("base branch policy prohibits the merge"). HELD: required checks are pinned to GitHub Actions (15368).
- POST check-runs with a PAT: 403 "You must authenticate via a GitHub App". HELD.

## 5. verify replaced by exit 0 (PR #6, head on attack/exit0)
- Candidate scripts/verify prints a green line and exits 0; squash broken. Candidate's `verify`: PASS (as the attacker wanted).
- `verify-trusted`: FAIL, "main's verify fails on the candidate's code" and "the candidate's checks no longer fail on
  main's fixtures". red-check also FAIL. `--admin` merge: "2 of 6 required status checks are failing". HELD.

## 6. Secrets (PR #5, workflow forge.yml added by the candidate)
- job steal-env (environment: reviewer, reads CANARY): refused, "Branch refs/pull/5/merge is not allowed to deploy to
  reviewer due to environment protection rules". HELD.
- job steal-repo (reads repo-level REPO_CANARY): ran, printed sha256 prefix 4a2cbfd968f04a35 = the canary's. HAZARD
  CONFIRMED: any same-repo branch reads repo-level secrets. REPO_CANARY deleted right after; scratch has 0 repo secrets.
  Rule "secrets only in the environment reviewer" has no server-side enforcer.

## 7. Candidate posts its own results (PR #5, head 83995447)
- The candidate's own workflow asked for `statuses: write, checks: write` and got them (the repository default of
  read-only does not cap an explicit request on a same-repo branch). It posted a success status AND a success check run
  from the github-actions app for all six required names. NOT a 403: the expectation in the brief does not hold.
- Effect: none on the merge. The real verify, red-check and verify-trusted runs had failed; `--admin` merge said
  "3 of 6 required status checks are failing". A later success with the same name does not mask a failure. HELD.
- Residual gap: a candidate that edits gate.yml so its own verify/rules/red-check jobs pass trivially, and forges
  nothing, escapes red-check (verify-trusted re-runs main's verify, which includes rules, but not red-check). The change
  is tier 3 (.github/ is a CODEOWNERS path), so it waits for the Human. Fix: verify-trusted also runs main's red-check.

## 1. Tiers
- Tier 1 (PR #8, initials in src/format.js with its test, auto-merge on): all seven checks green, then stranded BEHIND
  once #7 landed first; `bin/factory-queue sweep` updated it (head f61b5e72, a merge of main), the gate re-ran, it
  auto-merged as 784dc6e6. HELD, with the queue.
- Tier 3 (PR #7, kit update touching scripts/verify-trusted and .github/workflows/gate-trusted.yml, label tier-3,
  auto-merge on): MERGED with no review at all. Rule suite 4638891073: pull_request PASS. CODEOWNERS valid (0 errors);
  the author tuannd9288 is the only code owner. FAILED. Cause not separable with one identity (author = owner, or
  required_approving_review_count 0). A gate change landed on scratch main judged by no person; it was the benign kit
  update, but that is the failure mode.
- Fix (factory 138139d, on scratch main from 5b700102): verdict on tier 3
  reads the reviews and passes only on an APPROVED review of the head commit by a code owner who is not the author;
  factory-queue re-runs the verdict after such an approval. Shown failing on the old scripts/review in the kit tests.

## 4. Missing or failing-closed reviewer, and re-runs (PR #9, README only, auto-merge on)
- Repository variable GATE_REVIEWER deleted: `review` FAILED closed ("no reviewer is configured"), PR BLOCKED. HELD.
- Variable set back to stub, `gh run rerun 39584692508 --failed`: the re-run replaced the failed check run (one
  `review` run left, success) and the PR auto-merged. A re-run clears a failure; a later API-created run does not (7).

## 10. Rollback with two PRs waiting on auto-merge (PRs #10, #11, #12)
- #10 (kit update, tier 3, auto-merge off) green and CLEAN on the old gate. #11 red (squash broken) and #12 green
  (README) opened with auto-merge on, checks still running.
- 10:33:17 `factory-queue pause`: auto-merge off on #11 #12. 10:33:23 ruleset disabled. #10 merged by hand as
  5b700102. 10:33:28 ruleset active again (window 5 s). #11 and #12 still OPEN, not merged.
- `factory-queue resume`: auto-merge back on both (both BEHIND). The background sweep updated #11 (re-judged, red
  again, stays open: right) and #12 (re-judged green, auto-merged as caff93cb). Strands none, leaks none. HELD.
- Not observed: what an unpaused PR does while the ruleset is off. The procedure assumes it would land unjudged.
- Queue fix after this: a BEHIND PR whose last judgement failed is no longer updated (it wasted a run on #11).

## 3. Stale verdict (PR #13, tier 2: src/send.js)
- Commit B 2a4c1520 (failing test first with Failing-test:, then the code): all seven green, CLEAN, auto-merge off.
- Pushed commit C ed34818b holding a blocking finding (stub marker); `gh pr merge --auto` 3 s later tried to merge at
  once and was refused: "6 of 6 required status checks are expected". B's results did not count for C. HELD.
- Auto-merge on: verdict FAILED on C, PR stayed BLOCKED. Commit D 61eb070f answered the finding (bound and test):
  all green, auto-merged as bdda9f36. HELD.

## 4 (continued). Missing and cancelled trusted checks (PR #14, README only, auto-merge on)
- Workflow gate-trusted disabled (admin, scratch) before the PR opened: verify, rules, red-check green;
  verify-trusted, review, verdict never reported. `--admin` merge: "3 of 6 required status checks are expected".
  BLOCKED. HELD.
- Workflow enabled, body edited (an unchanged body fires no `edited` event; the first try did nothing), run
  39588726051 cancelled at once: review, verdict, tier, verify-trusted cancelled. "3 of 6 required status checks have
  not succeeded". BLOCKED. HELD.
- `gh run rerun 39588726051 --failed`: all green, auto-merged as 40878f3e.

## 9. Merged tree equal to the judged one (`tree.sh`, after the last probe)
- For each of the 31 merges on scratch main after 9dcc0e86 (M, judged head H = M^2, base B = M^1):
  `git diff --quiet H M`, `git merge-base --is-ancestor B H`, and the six required checks green on H. All 31 pass,
  #10 (merged by hand inside the rollback window) included. HELD: the strict up-to-date rule plus merge commits
  make the merged tree the judged tree.
