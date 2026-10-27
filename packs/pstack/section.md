## Where pstack yields

pstack's playbooks run here when a session types `/pstack:<skill>`, at the prompt's start in `claude -p` too. Its
skills but `setup-pstack` refuse the model's own call; its agents `poteto-agent` and `comment-sicko` do not. No point
is left where they yield: the kit says each rule once, and where a playbook differs, the gate's rule wins.

## Shipping with pstack

| Command | Healthy output |
|---|---|
| `scripts/live-verify <pr>` | `live-verify: PASS on #12 (head 1a2b3c4, patch 5d6e7f8)`, posted on the pull request |
| `scripts/ship` | `ship: opened #12 <url>`; run again: `ship: armed #12: a live PASS covers HEAD 1a2b3c4` |

Push, then run `scripts/ship` (`--body-file`: the template in English, `Closes #<issue>` filled in), and again until it
says `armed` or stops. Each run takes the next step: opens the pull request, runs `scripts/live-verify <pr>`,
arms auto-merge. It refuses to open unless origin holds HEAD and a full `verify` and `red-check` passed on it, to arm on FAIL or
a base other than `main`, and stops on `needs-human`, or on a tier 3 it armed that waits for the Human. FAIL: fix forward with a red
test, push, run it again. BLOCKED: put the reason and your recommended answer in the pull request. It disarms an
armed pull request whose HEAD is past its verdict; push, then run it again. Then release the branch; do not wait for CI.

## The live verifier

pstack's Shipping verifies each pull request live before it lands (pstack `shipping.md:5`, `:7`;
`autopilot-full.md:14`); `scripts/live-verify` does it here, with two substitutes:

- Codex CLI (`codex exec`) for Shipping's Cursor cloud agent: another vendor's model than the Claude Code that wrote
  the change, run on this machine in a fresh pair of worktrees under `.claude/worktrees/`, on its own profile
  (`~/.agent-profiles/verifier/codex`), which the Human logs in; an agent never logs in. Its sandbox is
  `workspace-write` over the two worktrees, no approval prompts, outbound network only when the driver asks for it,
  no bypass flag. Cursor's cloud agents do not run under Claude Code.
- `.gate/driver.json` for `control-ui` and `control-cli`, which ship in another Cursor plugin: the repository's own
  way to run the change as a user, filled by its session and read from `main`. No driver is BLOCKED, never PASS.

The verdict is not a gate input: it lowers no tier and replaces no required check. The ledger records, for each
merged pull request, whether a verdict covered its head, and the weekly digest lists the misses.

