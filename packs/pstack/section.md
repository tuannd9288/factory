## Where pstack yields

A session runs a pstack playbook when it types `/pstack:<skill>`, in `claude -p` at the prompt's start. Where one
differs from the factory, the gate's rule wins (sources: the factory's `packs/pstack/yields.md`):

- `forcePush` in origin/main’s `.gate/driver.json` defaults to `pstack`: only your own PR branch with `--force-with-lease`, never main; `off` means fix forward.
- No stacked pull requests: `scripts/ship` opens against `main` and arms no other base.
- No merge by hand: `merge` in `.gate/driver.json` on main defaults to `squash`; `merge` selects merge commits, and `scripts/ship` arms the selected method with `--auto`.
- Title: Conventional Commits `type(scope): subject`, no trailing period, at most 72 characters; type is `feat`, `fix`, `docs`, `refactor`, `test`, `chore` or `perf`; scope is the area; subject is short, imperative and names a real symbol when one carries the change; `scripts/ship` defaults to the head commit's subject without its trailing `(#<n>)`; body: the repository's template with `Closes #<issue>` (`scripts/ship` sends them).
- `gh api` freely to read (a GET or a GraphQL query; on a REST read, `-X GET` with `-f`/`-F`); a write through it only
  with the Human's approval; a seat has no `gh` at all.
- `claude -p` has no `AskUserQuestion`: ask in the report.
- `/repo-refresh` runs only when the Human types it (`skillOverrides`), and changes a repository only by pull request.

A session that `bin/seat` or `factory lead` starts is denied its profile. Where pstack's docs say `~/.claude/`, its
plugin is under `~/.local/share/factory/plugins/`; `recall` and `reflect` read a seat's `run-<tag>.jsonl` in its run
folder, or a Lead's `~/factory-runs/<repo>-<team>/transcripts/`; no profile gets a rules file, so a role uses its
skill's default model.

## Docs

- A work spec is its tracker issue. No `docs/` tree is required.
- A product description is the Feature Map: `feature-map/` at the repository root, a `README.md` index and one short
  file per feature, from the user's side, in the four sections `/pstack:create-verification-skill` writes.
- A pull request that changes a feature updates that feature's file.
- A flow diagram is drawn only for a complex flow, with `/pstack:statechart`, in that feature's file.
- Linear Documents hold only writing the Human reads.
- Until the map is seeded, an existing feature doc stays where it is and is corrected in place; the pull request that
  seeds the map moves it in and deletes the old file.

## Shipping with pstack

Push, then run `scripts/ship --body-file <body>` until it says `armed` or stops. Each run takes the next step: it opens
the pull request, posts a `no driver` note (`.gate/driver.json` stays the template until #264 is fixed), and arms
auto-merge. It refuses a wrong step with the reason, and never a push. Stopped: put the reason and your recommended
answer in the pull request. Then release the branch; do not wait for CI.
