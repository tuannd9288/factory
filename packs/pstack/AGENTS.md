## Where pstack yields

pstack's playbooks run here when a session types `/pstack:<skill>`, at the prompt's start in `claude -p` too. Its
skills but `setup-pstack` refuse the model's own call; its agents `poteto-agent` and `comment-sicko` do not. They
yield at these six points, where the gate's rule wins:

- Never rewrite a pushed commit: no rebase or amend of a pushed branch, no force-push. Bring `main` in by merging
  it (`git pull --no-rebase`). The round count and the Human's tier-3 approval live on the pushed commits.
  (pstack `autopilot-full.md:12`, `babysit.md:10`, `opening-a-pr.md:7`)
- Land only by `gh pr merge --auto --merge`; never squash, never a direct merge. The ruleset takes merge commits
  only, and a direct merge counts as the Human's touch. (pstack `shipping.md:8`)
- Arm auto-merge only on a pull request whose base is `main`. A stacked child waits until its parent lands and
  is retargeted to `main`: no ruleset guards a branch, so an armed child lands in its parent unjudged.
  (pstack `shipping.md:8`)
- Open the pull request only after `scripts/verify` and `red-check` pass locally; push the branch as often as you
  like before that. Every head the gate judges red is a round, and the third makes the change tier 3.
  (pstack `autopilot-full.md:10`)
- A red `tier` whose log says it waits for the Human is his wait, not a failure: never re-run it, never push to
  clear it; the queue re-runs it after he approves. On `needs-human`, stop pushing and put your recommended answer
  in the pull request. (pstack `babysit.md:19`)
- A pause commit says what it holds (`Pause the parser split, tests red`), without `wip`, which the commit-msg hook
  refuses: with merge commits, the branch's subjects reach `main`. (pstack `pause-safely.md:7`)

