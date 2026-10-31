## Where pstack yields

A session runs a pstack playbook when it types `/pstack:<skill>`, in `claude -p` at the prompt's start. Where one
differs from the factory, the gate's rule wins (sources: the factory's `packs/pstack/yields.md`):

- No force-push; fix forward with a new commit. `factory-branches` refuses a non-fast-forward push.
- No stacked pull requests: `scripts/ship` opens against `main` and arms no other base.
- No merge by hand: `factory-gate` allows merge commits only, and `scripts/ship` arms `--auto --merge`.
- The title is the head commit's subject; the body is the repository's template, with `Closes #<issue>` filled in.
- No `gh api` (the Human's decision on #182): the Lead and seats are denied it.
- `claude -p` has no `AskUserQuestion`: ask in the report.
- `/repo-refresh` runs only when the Human types it, and changes the repository only through pull requests.

Every session is denied its profile (`$CLAUDE_CONFIG_DIR`). Where pstack's docs say `~/.claude/`, the plugin is under
`~/.local/share/factory/plugins/`; `recall` and `reflect` read a seat's `run-<tag>.jsonl` in its run folder, or a Lead's
`~/factory-runs/<repo>-lead/transcripts/`; no profile gets a rules file, so a role uses its skill's default model.

## Shipping with pstack

Push, then run `scripts/ship --body-file <body>` until it says `armed` or stops. Each run takes the next step: it opens
the pull request, posts a `no driver` note (`.gate/driver.json` stays the template until #264 is fixed), and arms
auto-merge. It refuses a wrong step with the reason, and never a push. Stopped: put the reason and your recommended
answer in the pull request. Then release the branch; do not wait for CI.
