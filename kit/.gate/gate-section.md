<!-- factory:gate:begin -->
## Gate

Gate marker: gate-section-v1 (a session that loaded this file can quote this line).
This repository is in the factory (`tuannd9288/factory`). The kit owns this block; the repository owns the rest of the
file. What a program enforces: `.gate/enforced-rules.md`.

- Work enters as one issue labelled `task`; claim it first: `.gate/bin/claim <n> <team>` (a second claim is refused). It
  leaves as one pull request whose body says `Issue: #<n>`, `Claim: <sha>` and `Team: <name>`. Never push to `main`;
  land by a merge commit through auto-merge.
- Run `.gate/bin/setup` once per clone. Before the pull request run `.gate/bin/verify` (it runs the repository's own
  verify too) and `.gate/bin/red-check --base origin/main`; push as often as you like.
- For a feature new to this repository, search GitHub (`gh search repos`, `gh search code`) and existing products for projects that already do it, and compare their approaches before writing it from scratch. Judge a project by its mechanism, never its stars or age. Adding a library, service or dependency is the Human's choice: propose it with the comparison.
- A source change carries a test that fails at the base. Where none can, the pull request body says
  `No-red: <why, 20 characters or more>`; the reviewer judges it.
- `.gate/bin/tier` prints the tier. Tier 2: commit the failing test first, alone, with `Failing-test: <command>`.
  Tier 3 (a path in `.gate/protected`, this block included): the Human approves the head commit.
- Four checks decide on the exact head commit, from `main`'s copies: `verify`, `review`, `verdict`, `tier`. When one is
  red, read `.claude/skills/gate-red/SKILL.md` first.
- Never rewrite a pushed commit or force-push. After three red rounds the pull request is `needs-human`, with your
  recommended answer in it.
- Every deploy is the Human's; decide and report anything else that can be undone, and a reversible question never
  blocks the work. Secrets live only in the environment `reviewer`. A rules finding wrong for one line:
  `gate-allow <rule-id>: <why>` (syntax in the file above).
- A hosted agent assigned on GitHub takes tier 1 and 2 issues only, and never receives the shared bot token.
<!-- factory:gate:end -->
