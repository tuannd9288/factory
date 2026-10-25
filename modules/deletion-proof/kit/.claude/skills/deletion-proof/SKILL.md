---
name: deletion-proof
description: Use when a change should only delete unused files here (whole files nothing imports) and land with no new test and no `No-red:` line, even if the task only says "remove dead code" or "knip says these files are unused"; also when `red-check` prints `not a pure deletion`. Shows how to make the pull request the gate's deletion proof accepts, and what to do when it refuses. Not for refactors, renames, edits inside a file, removing an export, features still in use, deleting tests, or dependencies.
compatibility: Claude Code in a factory repository whose main lists deletion-proof in .gate/modules; Node with npx, git.
allowed-tools: Bash(.claude/skills/deletion-proof/scripts/knip-at-base *)
---

# Deletion proof

`red-check` passes a change with no test and no `No-red:` line only when it can prove that the change deletes files
nothing uses. The proof is the gate's, run from `main`'s copy in CI; this skill helps you make a change it accepts on
the first push. The repository's `AGENTS.md` still governs everything else (tiers, the template, live-verify).

## First: is the proof on here?

```bash
git fetch -q origin main && git show origin/main:.gate/modules
```

The proof is on only if a line reads `deletion-proof`. If not, stop using this skill: delete the code with a test that
fails first, or with a `No-red:` line, as `AGENTS.md` step 3 says. A `.gate/modules` you add in your branch does not
count: CI reads `main`'s copy.

## What the gate accepts

All of these, judged at the base (the merge-base with `origin/main`):

1. **Only whole files.** Every changed source path is a file deleted whole. A source file that is edited, added or
   changed in type refuses the proof, and so does an `export` removed from a file that stays: that takes a test or
   `No-red:`. Docs, configs and other non-source files may change in the same pull request.
2. **Nothing names it.** A fixed-string `git grep` finds neither a deleted file's path nor its basename in any tracked
   file at the head. Docs, configs and comments count. It is not a full reference check: an import written without
   the extension (`'./old'`) names neither, so knip's list (3) is what vouches for it.
3. **knip listed it.** knip 6.42.1, run at the base with the repository's own config, listed each deleted file as an
   unused file.
4. **knip's config is trusted.** It is a JSON file (`knip.json`, `knip.jsonc`, `.knip.json`, `.knip.jsonc`) of plain
   data keys, a regular file (not a link), and `.gate/protected` at the base names it. And
   `package.json` at the base is a regular file that reads as JSON or JSONC, and has no top-level `"knip"` key,
   because knip merges that key with the file and a manifest change is not tier 3.
   Also no tracked file is gitignored at the base, because knip reads every `.gitignore` and does not follow the
   imports of an ignored file; and the base's `gate_prepare` changes no tracked file. That is all the proof checks
   of knip's inputs: the configs knip's plugins run are not covered, nor is a `tsconfig` `extends` target.

`review` still runs on a proved deletion and can still block it; the proof replaces only the `No-red:` line.

## Make the pull request

Progress:
- [ ] 1. Confirm the proof is on (above). Start from a fresh branch off `origin/main`.
- [ ] 2. Ask knip what is unused at the base: `.claude/skills/deletion-proof/scripts/knip-at-base report`. It prints
      JSON with `base` and `files`; diagnostics go to stderr.
- [ ] 3. Choose what to delete from `files` only. Never delete a file knip did not list, however dead it looks: the
      gate refuses it (check 3).
- [ ] 4. `git rm <path>` for each file.
- [ ] 5. Remove every mention the head still holds: `git grep -n <path>` and `git grep -n <basename>`. A mention in a
      doc or a comment you may delete in the same pull request; a mention in source means the code is used: put the
      file back.
- [ ] 6. Validate: `scripts/verify`, then `scripts/red-check --base origin/main`. It must print
      `red-check: passed as a pure deletion`. On `not a pure deletion`, read `references/refusals.md`, fix, run again.
- [ ] 7. Open the pull request as `AGENTS.md` step 4 says, with no `No-red:` line. Say in the body that it only
      deletes files knip listed at the base, and paste the `red-check` line.

## Gotchas

- Deletion only. Do not mix in a rename, a new helper, an edit to a file that stays or a dependency removal; put
  those in another pull request with a test.
- Convention files. A file a framework loads by its place or a binding (a Cloudflare Pages `functions/` file, a
  Durable Object bound by `class_name`) is named nowhere, so it passes all the gate's checks. Never delete one on
  knip's word: the reviewer judges these, and so do you.
- A mention under a tier-3 path (`scripts/`, `.github/`, `.gate/`, `.claude/`, `AGENTS.md`) is removed in a tier-3
  pull request: the deletion then waits for the Human. Say so in the body.
- Tests. A module that a test imports is not unused to knip. Deleting the test too is a deleted test, which
  `scripts/rules` refuses without its `gate-allow` line; such code takes a test or `No-red:` instead.
- Not yours to change here. `knip.json`, `.gate/protected`, `.gate/modules` and every path under `.gate/`, `scripts/`
  or `.claude/` are tier 3: editing them in a deletion pull request makes it the Human's, and CI judges it with `main`'s
  copies anyway. When the gate asks for one of them, open a separate pull request with your recommended answer.
- Whole-file deletion works for any file knip lists, `.jsx` and `.tsx` included: the gate reads no code.
- A file that stays is never part of the proof. If knip also lists an unused export in a file you keep, leave it for
  a pull request with a test.

## Available scripts

- `scripts/knip-at-base report` prints what knip 6.42.1 lists as unused files at the merge-base with `origin/main`,
  the way the gate runs it (a detached worktree, `gate_prepare`, then knip). `--help` shows the exit codes.
