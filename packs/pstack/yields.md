# The sources of `section.md`

`section.md` is what a repository copies into its own `AGENTS.md`, in as few lines as its rules leave room for (#288).
This file stays in the factory: for each rule there, the pstack lines it overrides, the code that enforces it and the
runs that checked it.

## Where pstack yields

pstack's playbooks run here when a session types `/pstack:<skill>`, at the prompt's start in `claude -p` too. Its
skills but `setup-pstack` refuse the model's own call; its agents `poteto-agent` and `comment-sicko` do not. Where a
playbook differs from the factory, the gate's rule wins. These are the places (upstream lines at `4dd1d05`, under
`skills/poteto-mode/playbooks/` unless a path says otherwise):

- **Force-push** (`shipping.md:8`, `babysit.md:10`, `autopilot-full.md:12`: `--force-with-lease`). The factory never
  rewrites a pushed branch: `factory-branches` refuses a non-fast-forward push on every branch, and `bin/seat` denies every
  `git push` (`Bash(git push:*)` in `bin/lib/seat.mjs`). Fix forward with a new commit.
- **Stacked pull requests** (`opening-a-pr.md:28`, `autopilot-stack.md:6`, `multi-phase-plan.md:57`: a base that is the
  parent's branch; `shipping.md:8`: retarget to trunk with `gh pr edit --base`). `scripts/ship` opens with `--base main`
  and refuses to arm any other base (`refused to arm #<n>: its base is <base>, not main`): no stack.
- **Merge by hand** (`shipping.md:8`: `gh pr merge <pr> --squash`). `factory-gate` allows merge commits only
  (`kit/.gate/ruleset.json:18`), and `scripts/ship` arms `--auto --merge`; nobody merges by hand.
- **The pull request's title and body** (`opening-a-pr.md:11`, `:13`: a Conventional Commits title, a body that becomes
  the squash commit body). The template wins: `scripts/ship --body-file` sends the repository's template with
  `Closes #<issue>` filled in, and the title is the head commit's subject.
- **Babysit's `watch-pr`** (`babysit.md:12`; `shipping.md:9`). It runs `gh api graphql` inside, only to read. The Human
  allowed it on 2026-10-30 ("theo đề xuất", Factory Map v18 item 3); the grant is #182's work, not made yet. Babysit's
  replies through `gh api` (`babysit.md:20`) are not used: the Human's decision on #182 (2026-10-30). The Lead is denied
  `Bash(gh api:*)` (`packs/pstack/bin/lead.mjs`), and a seat every `gh` (`Bash(gh:*)` in `bin/lib/seat.mjs`).
- **`AskUserQuestion`** (`docs/harness/claude-code.md:10`: "In `-p` mode it is absent, so ask in plain text"). A `-p`
  seat's tool list in its log (#203's `run-yields-2.jsonl`, line 3) holds no `AskUserQuestion`, so a seat asks in its
  report. `bin/seat`'s code says nothing of it. An interactive Lead: not checked.

`/repo-refresh` (the Human's, #19) runs only when typed, hidden from the model. Its audit mode, the default,
changes nothing; its apply mode changes a repository only through pull requests that pass the gate.

## Where the adapter's `~/.claude/...` paths are, here

`docs/harness/claude-code.md` names paths under `~/.claude/`. A factory session has its own profile
(`$CLAUDE_CONFIG_DIR`, `~/.agent-profiles/...`), which no session may read, so these are the real ones:

- **The plugin** is read from the profile's plugin root, `~/.local/share/factory/plugins/<the profile's path under
  ~/.agent-profiles>`, mode 700, one for each profile (#185), not `~/.claude/plugins/`.
- **Transcripts.** A profile keeps its own under `$CLAUDE_CONFIG_DIR/projects/`, which every session is denied.
  `recall` and `reflect` read the copies instead: a seat's `run-<tag>.jsonl` in its run folder, and a Lead's
  `~/factory-runs/<repo>-lead/transcripts/`, which seats are denied. That a profile keeps them under `projects/`, where
  the Lead's hook copies from, was checked by the Lead's live run on 2.1.308 (#185, issuecomment-6545015874,
  item d). `recall` and `reflect` themselves have not yet run on the copies (#185, acceptance 5).
- **Rules.** The factory writes no rules into any profile; `setup-pstack`, their only writer, is not used. So nothing
  the factory runs writes the adapter's `~/.claude/rules/pstack-models.md`; without it, a role uses its skill's default
  slug (`docs/harness/claude-code.md:37`). A project's `.claude/rules/` loads in a seat session on 2.1.308: a probe's
  session quoted a marker line from `.claude/rules/factory-probe.md` with no tool call (#203's `run-rules-1.jsonl`). A
  profile's own `rules/` is per the docs, not probed: a probe would need a write into a profile's folder, which no agent
  makes.

## Shipping: what `scripts/ship` says

| Command | Healthy output |
|---|---|
| `scripts/live-verify <pr>` | `live-verify: PASS on #12 (head 1a2b3c4, patch 5d6e7f8)`, posted on the pull request |
| `scripts/ship` | `ship: opened #12 <url>`; run again: `ship: armed #12: a live PASS covers HEAD 1a2b3c4`, or, with no driver, `ship: armed #12: not run as a user, no driver; the note covers HEAD 1a2b3c4` |

With no driver on `main`, `scripts/ship` runs no `live-verify`: it posts one comment, `not run as a user: no driver
(head <full sha>)`, and goes on. A note counts for a head only if the pull request's author, the agents' login, wrote it
and nobody has edited it; any other comment stands for nothing. The note is no verdict: the ledger counts that head as a
miss. It refuses to open unless origin holds HEAD and `red-check` passed on it, to arm on FAIL or a base other than
`main`, and stops on `needs-human`, or on a tier 3 it armed that waits for the Human. It disarms an armed pull request
whose HEAD is past its verdict.

## The live verifier

pstack's Shipping verifies each pull request live before it lands (pstack `shipping.md:5`, `:7`;
`autopilot-full.md:14`); `scripts/live-verify` does it here, with two substitutes:

- Codex CLI (`codex exec`) for Shipping's Cursor cloud agent: another vendor's model than the Claude Code that wrote
  the change, run on this machine in a fresh pair of worktrees under `.claude/worktrees/`, on its own profile
  (`~/.agent-profiles/verifier/codex`), which the Human logs in; an agent never logs in. Its sandbox is
  `workspace-write` over the two worktrees, no approval prompts, outbound network only when the driver asks for it,
  no bypass flag. Cursor's cloud agents do not run under Claude Code.
- `.gate/driver.json` for `control-ui` and `control-cli`, which ship in another Cursor plugin: the repository's own
  way to run the change as a user, filled by its session and read from `main`. No driver is never PASS: `live-verify`
  run by hand posts BLOCKED, and `scripts/ship` runs none and posts the "no driver" note instead.

The verdict is not a gate input: it lowers no tier and replaces no required check. The ledger records, for each
merged pull request, whether a verdict covered its head, and the weekly digest lists the misses.

Until #264 is fixed, `INSTALL.md` lays no `live-verify` in a repository: `scripts/ship` reads the driver through
`scripts/lib/driver.mjs`, and with the template's empty driver it never runs `live-verify`.
