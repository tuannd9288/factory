# Rules that code enforces

The rows of `AGENTS.md`'s table that a program refuses or flags. The gate's reviewer reads this file from `main` with
`AGENTS.md`; a session reads it when a check is red or when its change touches the gate. A path here is tier 3.

| Rule | Enforced by |
|---|---|
| Checks green on the exact head commit before merge | ruleset: `verify`, `review`, `verdict`, `tier` pinned to GitHub Actions, branch up to date |
| No focused, skipped or deleted tests; no lost assertions; no debugger; no placeholder bodies; no whole-file suppressions; TLS checks stay on; no hard-coded secrets | `scripts/rules` (seatwork's hand-in rules) in pre-commit and in `verify`; a dropped test's proof: `red-check`, and `tier` makes it tier 2 |
| A new test fails at the base and passes at the head | `red-check`, inside `verify` |
| A failing test committed first is not weakened later | `scripts/rules` (`failing-test-edited`) |
| Every check is shown failing on a fixture | `scripts/prove-check` in `verify` and `verify-trusted` |
| Every pull request is judged by `main`'s scripts, whatever it changes | `gate.yml` (base checkout, `scripts/verify-trusted`), `gate-trusted.yml` (`pull_request_target`) |
| Tier-3 paths are one list, and CODEOWNERS ends with exactly it | `.gate/protected`; `verify` (`policy`) |
| Removing a label lowers no tier | `tier` reads every label the pull request ever had |
| Commit subject present, at most 72 characters, never `wip`, a placeholder, `fixup!` or `squash!` | `verify` (`subjects`, every commit of the change); `.githooks/commit-msg` is the local copy |
| Auto-merge only on a base of `main`; a pull request opens only after a local pass; a tier 3 is armed, then stops until the Human approves; `needs-human` stops before arming | `scripts/ship`, on the stamps a full `verify` and `red-check` leave; a push is never refused |
| Auto-merge armed only while a live PASS or PASS+NOTES covers the head or its patch; disarmed on the next `ship` once a patch moved past its verdict | `scripts/ship`, on `scripts/live-verify --covered`; the ledger lists each merged pull request no verdict covered |
| No `--admin` merge, no self-approval | the ruleset (empty bypass list) and GitHub |
| Tier 3 lands only with the Human's approval of the head commit, or of one whose patch (`git patch-id`) the head carries unchanged | `tier` (`pull_request_target`); GitHub's code-owner rule alone lets an owner-author through |
| No `--no-verify`, tags, releases; no reads of `.env` or of the Human's own Claude Code and Cursor profiles (`~/.claude*`, `~/.cursor/`), whose transcripts are his, or of the verifier's Codex profile, which holds its login | `.claude/settings.json` deny rules, in Claude Code only; for tags, and for a release that would create one, also the ruleset `factory-tags`; a draft is not refused |
| A candidate's code runs only in `gate.yml`'s `verify`: on `pull_request`, which cannot write `main`'s Actions cache, never under `pull_request_target`; on a GitHub-hosted runner, never on a self-hosted one that also runs `main`'s or a deploy's jobs; with no secret and a read-only token | the factory's tests check the kit's workflows. A pull request that changes `gate.yml` runs its own copy for its `verify`; it is tier 3, and the Human reads that file before approving |
