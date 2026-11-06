# Installing the pstack pack in a repository

The pack is a folder a team copies; the kit does not lay it. A pack is what the factory holds only for one way of working, and
a team copies it; the kit lays none (#132). `packs/pstack/` holds its scripts (`ship`, `pr-body`, `live-verify`), `.gate/driver.json`, the
pin (`settings.json`), the prose for the repository's own `AGENTS.md` (`section.md`) and its sources (`yields.md`), two rows for
`.gate/enforced-rules.md` and `INSTALL.md`, the steps; a repository that chooses it copies them in its own tier-3 pull request.
There is no `.gate/pack` and no `--pack`. Run from the repository's root, with the factory
checkout at `$FACTORY`, in a branch, and open the pull request: `scripts/`, `.gate/` and `.claude/` are tier 3.

1. `mkdir -p scripts/lib && cp -p $FACTORY/packs/pstack/scripts/ship $FACTORY/packs/pstack/scripts/pr-body scripts/ && cp -p
   $FACTORY/packs/pstack/scripts/lib/ship.mjs $FACTORY/packs/pstack/scripts/lib/driver.mjs scripts/lib/`. A `scripts/`
   the repository already has keeps its other files. `live-verify`, `lib/live-verify.mjs` and `lib/verdict.mjs` stay out
   until #264 is fixed (`yields.md`, "The live verifier").
2. `cp $FACTORY/packs/pstack/.gate/driver.json .gate/driver.json`. It stays the template until #264 is fixed: with
   no `scripts/live-verify`, a filled driver stops `scripts/ship` on every pull request.
3. Append the two rows of `enforced-rules.rows.md` to `.gate/enforced-rules.md`.
4. Add what `section.md` says to the repository's own `AGENTS.md`, after the Gate block, within 150 lines and 32 KiB.
   A repository already near the limit shortens its own rules first, through the Human's rule audit; the pack is not
   cut further (#288).
5. Add `packs/pstack/settings.json`'s keys to `.claude/settings.json` (one pin for each repository), then, once per
   repository and profile, `claude plugin install pstack@pstack-4dd1d05 --scope project` (below, "pstack, per repository").
6. `mkdir -p .claude/skills && cp -R $FACTORY/packs/pstack/skills/repo-refresh .claude/skills/`: the Human's
   `repo-refresh` skill (#19), as a project skill, unedited. A session runs it only when it names it
   (`/repo-refresh`), as the skill's own rule says, and step 5's `skillOverrides` is what keeps it user-only;
   `.claude/` is tier 3.

## Pull request readiness

The `drafts` switch in `.gate/driver.json` on `origin/main` defaults to `landable`, including when
the file is absent, for every repository, the factory included. Choose `"drafts": "pstack"` to open
ready (pstack `opening-a-pr.md:30`). With `landable`, the queue marks a draft
ready and arms auto-merge once `verify` passed and it has no conflict, and turns it back to a draft when either fails (#455).

## The live verifier's login

For a repository that installs `live-verify`: the live verifier runs on one Codex profile for every repository,
`~/.agent-profiles/verifier/codex`, which only the Human logs in: `mkdir -p ~/.agent-profiles/verifier/codex`, then
`CODEX_HOME=~/.agent-profiles/verifier/codex` before Codex's own login command. Until he has, every live verdict is BLOCKED and
nothing auto-merges, but for a repository whose `main` has no driver, where `scripts/ship` arms on its "no driver" note in place
of a verdict.

## pstack, per repository

The pstack pack's `packs/pstack/settings.json` pins upstream's Claude Code build of it (#182: a `git-subdir` source, path
`harness/pstack/claude-code` of `cursor/plugins`, at the full SHA) through a `settings` marketplace named for the commit
(`pstack-4dd1d05`) and enables it at project scope. Once per repository and profile, after the Human has opened `claude` in the
repository and trusted the folder, install it from the repository root with
`claude plugin install pstack@pstack-4dd1d05 --scope project`. Never at user scope: no install without `--scope project` (or
`--scope local`, which `packs/pstack/bin/lead` uses), and never the `--marketplace` form, which declares the marketplace in the
profile's user settings. A new pin is a new marketplace name, in a tier-3 pull request per repository; attack 23 checked that two
pins share one profile without clashing. Found on Claude Code 2.1.308, 2026-10-22 (attack 23; `probes/results.md` at the tag
`before-271`):

- The install fails with `Plugin "pstack" not found in marketplace` in a folder the profile has not trusted (logged-in
  writer profile, untrusted `case1/a`). The pstack pack's `packs/pstack/settings.json` is in the order the installer writes:
  uninstalling and installing again in `case2/a` on the same profile left `git status` empty (a first install on a new profile
  was not tried). An uninstall rewrites `enabledPlugins` to `{}`.
- 53 of 54 pstack skills carry `disable-model-invocation` (57 of 58 at `4dd1d05`), so the model's own Skill call is
  refused; `setup-pstack` does not. The agents `pstack:poteto-agent` and `pstack:comment-sicko` have no guard: a model
  may spawn them, and with
  poteto-agent poteto-mode's playbook, in a run nobody typed (#182 decides whether to forbid that; #8 was merged into
  it).
- `claude -p "/pstack:poteto-mode …"` starts the skill; a prompt that only names it does not. So an unattended prompt
  starts a skill explicitly with `/pstack:<skill>` at its start; without that the run follows the repository's `AGENTS.md`
  and whatever the model spawns.
- Two pins under two marketplace names share one profile, each folder loading its own.

## pstack's skills use Cursor's names

23 of its 58 skills point to its adapter, `docs/harness/claude-code.md`, which maps Cursor's tools, subagent fields, models and
paths to Claude Code's, and skips, with one line, a step that needs Cursor Automations, Bugbot or a Cursor cloud agent itself. A
session reads the adapter and the other files of the plugin from its profile's plugin root, outside `~/.agent-profiles/` (#185; a
seat's run shows it reading `docs/harness/claude-code.md` and `references/explainer-prompt.md` with no denial), so it can map
Cursor's names as the adapter says; before that, the plugin was cached under the profile, which `secretsRead` denies, and the
model mapped them itself (#193's seat run). The factory does not use these parts:

- `/setup-pstack`: the launcher now writes `$CLAUDE_CONFIG_DIR/rules/pstack-models.md` at every start, with the
  skill defaults mapped by the adapter: a `grok` role runs on the session model, and the seats that exist to be another
  model family (the second seat of arena, architect and interrogate, and arena's cross-judge) are `codex high`, run through
  `factory codex` on the verifier's Codex profile, never on Claude (#182); a change of model is the Human's; whether Claude
  Code loads a profile's own `$CLAUDE_CONFIG_DIR/rules/` instead is not checked (#182).
- Autopilot's owners and swarm of verifiers: the adapter runs a Cursor cloud agent as a worktree subagent of the
  session, outside `bin/seat` (#182). Shipping's one verifier per pull request is taken, on the Codex CLI instead
  (`packs/pstack/scripts/live-verify`, `packs/pstack/yields.md`); its verdict is no gate
  input, so the gate's reviewer (`review`, `verdict`) stays the only judge the merge waits for.
- The transcript readers (recall, reflect, session pickup, eval, show-me-your-work's audit): the adapter points them
  at `~/.claude/projects/<slug>/`, which the kit's deny rules refuse. A factory profile keeps its transcripts under its
  own `CLAUDE_CONFIG_DIR`, in `~/.agent-profiles/`, which `bin/seat` and `packs/pstack/bin/lead` deny (#185); they read
  the copies instead: a seat's `run-<tag>.jsonl` and a Lead's `~/factory-runs/<repo>-<team>/transcripts/`.
- `cursor-team-kit`'s `deslop`, `control-ui` and `control-cli`: they ship in another Cursor plugin, not in pstack.
