# Installing the pstack pack in a repository

The pack is a folder a team copies; the kit does not lay it. Run from the repository's root, with the factory
checkout at `$FACTORY`, in a branch, and open the pull request: `scripts/`, `.gate/` and `.claude/` are tier 3.

1. `cp -p $FACTORY/packs/pstack/scripts/ship $FACTORY/packs/pstack/scripts/live-verify scripts/` and
   `mkdir -p scripts/lib && cp -p $FACTORY/packs/pstack/scripts/lib/*.mjs scripts/lib/`. A `scripts/` the repository
   already has keeps its other files.
2. `cp $FACTORY/packs/pstack/.gate/driver.json .gate/driver.json`; the repository's session fills it.
3. Append the two rows of `enforced-rules.rows.md` to `.gate/enforced-rules.md`.
4. Add what `section.md` says to the repository's own `AGENTS.md`, after the Gate block, within 150 lines and 32 KiB.
5. Add `packs/pstack/settings.json`'s keys to `.claude/settings.json` (one pin for each repository), then, once per
   repository and profile, `claude plugin install pstack@pstack-4dd1d05 --scope project` (the factory `AGENTS.md`,
   "pstack, per repository").
6. `mkdir -p .claude/skills && cp -R $FACTORY/packs/pstack/skills/repo-refresh .claude/skills/`: the Human's
   `repo-refresh` skill (#19), as a project skill, unedited. A session runs it only when it names it
   (`/repo-refresh`), as the skill's own rule says; `.claude/` is tier 3.
