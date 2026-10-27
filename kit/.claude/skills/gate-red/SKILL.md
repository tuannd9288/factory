---
name: gate-red
description: Use when a pull request's check is red or pending (`verify`, `review`, `verdict` or `tier`), when `tier` says `review is red; tier follows it` or waits for the Human's approval, when the reviewer's finding looks wrong, or when a push would be the third round. Says how the four checks decide, which jobs to re-run, how to fix or dispute a blocking finding, and when `rounds` hands the pull request to the Human. Not for writing the change or for the local `verify`.
compatibility: Claude Code in a factory repository; the gate's checks run on GitHub Actions.
---

# When the gate is red

The gate decides from `main`'s scripts. The rules a program enforces are in `.gate/enforced-rules.md`.

## The four checks

Every pull request needs four checks green on its head commit:

- `verify` (`gate.yml`): `main`'s verify, rules and red-check, run on your code.
- `review` and `verdict` (`gate-trusted.yml`): the reviewer reads your change as data once `verify` passed. `verdict` passes
  at once on tier 1.
- `tier`: below tier 3 it waits for `review` to end; on tier 3 it waits for the Human's approval of your change.

The reviewer may raise a change to tier 3 (label `raised`), never lower one. A label never lowers a tier. The Human's
approval holds while the patch is unchanged, as when the queue merges `main` in; a new patch needs a new one.

## A red or waiting `tier`

- `review is red; tier follows it`: this is not his wait. Re-run the failed jobs, never `review` alone.
- A `tier` that waits for his approval is his wait. Never re-run it; the queue re-runs it after he approves.

## A blocking finding

- Fix it with a new commit; `AGENTS.md`, in "Rules and what enforces them", says why a pushed commit is never rewritten.
- A finding you dispute goes to the Human: label the pull request `needs-human` and put your recommended answer in it.

## Rounds

At the third head commit judged red, `rounds` labels the pull request `needs-human`, which makes it tier 3: the Human
decides. Stop pushing until the Human answers.
