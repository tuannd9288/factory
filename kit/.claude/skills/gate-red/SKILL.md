---
name: gate-red
description: Use when a pull request's check is red or pending (`verify` or `tier`), when `tier` waits for the Human's approval, when a check names the body's `Team:`, `Issue:` or `Claim:` line, when a blocking finding looks wrong, or when a push would be the third round. Says how the two checks decide, when not to re-run `tier`, how to fix or dispute a blocking finding, and when to hand the pull request to the Human. Not for writing the change or for the local `verify`.
compatibility: Claude Code in a factory repository; the gate's checks run on GitHub Actions.
---

# When the gate is red

The gate decides from `main`'s scripts. The rules a program enforces are in `.gate/enforced-rules.md`.

## The two checks

Every pull request needs two checks green on its head commit:

- `verify` (`gate.yml`): `main`'s verify, rules and red-check, run on your code.
- `tier` (`gate-trusted.yml`): it reads your change as data and waits for no other check; on tier 3 it waits for the
  Human's approval of your change, unless the repository's merge switch is at `all`.

No check on GitHub runs a reviewer: the review runs beside the workers. A label never lowers a tier. The Human's
approval holds while the patch is unchanged, as when the queue merges `main` in; a new patch needs a new one.

## A red or waiting `tier`

- A `tier` that waits for his approval is his wait. Never re-run it; the queue re-runs it after he approves.
- A `tier` red on the claim (the body has no `Claim:` line, it is not the tip of `claim/<n>`, or its `Team:` is not the
  team holding the claim): take the issue with `.gate/bin/claim <n> <team>`, which prints the `Claim:` line, or ask the
  holder to run `.gate/bin/claim --handoff <n> <holder> <team>`; after a handoff, the body carries the new `Claim:` and
  the new holder's `Team:`. Only the holder or the Human releases a claim; the ref is never deleted.

## The body's lines

`verify` needs one line `Team: <name>`; editing the body runs the checks again. `tier` reads `Issue: #<n>` (or
`Issue: none`) and `Claim: <sha>`, and on a claimed issue checks that `Team:` names the holder. `Session:` and `Cost:`
only inform.

## A blocking finding

- Fix it with a new commit; `.gate/enforced-rules.md` says why a pushed commit is never rewritten.
- A finding you dispute goes to the Human: label the pull request `needs-human` and put your recommended answer in it.

## Rounds

After three red rounds, label the pull request `needs-human` with your recommended answer, which makes it tier 3: the
Human decides. No check counts the rounds. Stop pushing until the Human answers.
