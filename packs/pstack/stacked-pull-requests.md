# Stacked pull requests

Goal (#436, sublayer 3c): dependent changes can land bottom-up without rebuilding
children by hand. `scripts/ship --base <parent-branch>` opens a child. The child
waits unarmed until its base is `main`, then the queue merges the new `main` into
it and waits for its required checks before arming that exact head.

`stacks` comes from `.gate/driver.json` on `origin/main`, defaults to `pstack`,
and accepts `off` to refuse new children and stop automatic restacking. Both
ready and draft children follow the same stack path. A squash landing still
gets a merge when restacked; neither path rebases or asks for a force-push.
Conflicts wait for their owner to resolve them.

## Acceptance audit before changes

All references in this table are at main `81aeac3`.

| Acceptance | Already built? | Evidence |
| --- | --- | --- |
| Open a child against its parent's branch | Yes | `packs/pstack/scripts/lib/ship.mjs:69` passes `--base`; `:237` reads trunk policy and `:241` defaults stacks on. |
| Keep a child unarmed; retarget, merge, then arm after checks | Partial | `ship.mjs:131` disarms children, `:136` finds merged parents, `:150` retargets and merges in merge mode. It misses an already-retargeted child; `:143` rebases in squash mode. `bin/lib/queue.mjs:362` can arm a draft child from verify alone. |
| Only main-based PRs with required checks on their head reach main | Gate already exists; stack automation incomplete | `ship.mjs:204` refuses arming non-main bases; `kit/.gate/ruleset.json:22` requires status checks. The queue's `:362` lacks a base guard. |
| Off refuses non-main opening | Yes | `ship.mjs:243`. |
| Yields row names switch, default and the Human's words | Yes | `packs/pstack/yields.md:18` and `:19`; unchanged. |

## Ownership and sources

GitHub retargets the child when it deletes the merged parent branch, as configured
for this repository. `ship` keeps the explicit retarget fallback for a parent
branch that remains. Its restack now always merges. An already-retargeted child
is handed to the queue, including when the drafts switch opens it ready.

The queue owns automatic restacking and arming because it continues after the
parent lands. It reads the latest manual or automatic base-change event, so it
need not have observed the parent before the merge. It compares the exact base
and head before calling `pr update-branch` with its default merge method. A later
sweep reads the new head and its checks; the update sweep cannot arm from the old
checks. Only one stack branch is updated per readiness pass.

Ported from `pstack/skills/poteto-mode/playbooks/` in the supplied cursor-plugins
reference:

- `opening-a-pr.md:28@f713f14`: base-branch chains, children moving to trunk.
- `shipping.md:8@f713f14`: bottom-up landing, post-merge retarget and checks.
- `shipping.md:7@f713f14`: unchanged-patch verdict coverage, left intact.
- `autopilot-stack.md:6@f713f14` and `:8@f713f14`: one topology owner during landing.

The dated #436 settlement replaces upstream's rebase/lease-push with a merge.
No other switch or rule text changes.

GitHub's [pull request event schema](https://docs.github.com/en/graphql/reference/pulls)
defines both `BaseRefChangedEvent` and `AutomaticBaseChangeSucceededEvent`; the
queries normalize their old/new base fields.

## Checks and approval seam

The assumption is that retargeting emits a base-change event and schedules the
checks configured for `edited` (`.github/workflows/verify.yml:6`). A subsequent
merge schedules checks on its new head through `synchronize`. The queue requires
all required checks to succeed on the current head and to have started no earlier
than the retarget event. If GitHub does not schedule them, the child waits;
pre-retarget green results do not arm it. Arming uses `--match-head-commit`.

The seam for #456 is the required-check predicate in
`bin/lib/queue.mjs` immediately after the ancestry comparison. It currently waits
for approval like any other required check. No approval or verdict is copied to
a new head. Existing patch-id coverage in
`packs/pstack/scripts/lib/live-verify.mjs:24` and `:64` is unchanged; this change
adds no alternative way to declare an old verdict valid.

Tests use the existing fake forge with real local commit graphs: a child forks,
the parent advances and lands by merge or squash, GitHub's retarget is simulated,
and the queue merges main, waits for missing/stale/incomplete checks, then arms.
They cover default/pstack/off, both drafts settings, and an already armed child.
The fake assumes the retarget event; this is not a live GitHub verification.

`foundOutside: []` — no unrelated code fixes.
