# Installing the pstack pack in a repository

The pack is a folder a team copies; the kit does not lay it. Run from the repository's root, with the factory
checkout at `$FACTORY`, in a branch, and open the pull request: `scripts/`, `.gate/` and `.claude/` are tier 3.

1. `cp -p $FACTORY/packs/pstack/scripts/ship scripts/` and `mkdir -p scripts/lib && cp -p
   $FACTORY/packs/pstack/scripts/lib/ship.mjs $FACTORY/packs/pstack/scripts/lib/driver.mjs scripts/lib/`. A `scripts/`
   the repository already has keeps its other files. `live-verify`, `lib/live-verify.mjs` and `lib/verdict.mjs` stay out
   until #264 is fixed (`yields.md`, "The live verifier").
2. `cp $FACTORY/packs/pstack/.gate/driver.json .gate/driver.json`; the repository's session fills it.
3. Append the two rows of `enforced-rules.rows.md` to `.gate/enforced-rules.md`.
4. Add what `section.md` says to the repository's own `AGENTS.md`, after the Gate block, within 150 lines and 32 KiB.
   A repository already near the limit shortens its own rules first, through the Human's rule audit; the pack is not
   cut further (#288).
5. Add `packs/pstack/settings.json`'s keys to `.claude/settings.json` (one pin for each repository), then, once per
   repository and profile, `claude plugin install pstack@pstack-4dd1d05 --scope project` (the factory `AGENTS.md`,
   "pstack, per repository").
6. `mkdir -p .claude/skills && cp -R $FACTORY/packs/pstack/skills/repo-refresh .claude/skills/`: the Human's
   `repo-refresh` skill (#19), as a project skill, unedited. A session runs it only when it names it
   (`/repo-refresh`), as the skill's own rule says, and step 5's `skillOverrides` is what keeps it user-only;
   `.claude/` is tier 3.
