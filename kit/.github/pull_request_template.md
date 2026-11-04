## TL;DR for the Human
<!-- Tier 3 only: delete this whole section on tier 1 and 2. Plain English for a reader who is not technical; no commit ids, no file paths. -->
- **What you will see:** (what looks or behaves differently to you, in a sentence or two)
- **What changes:** (what this pull request does)
- **What it fixes:** (the problem or the need behind it)
- **Risk:** (what could go wrong, and how to undo it)
- **Recommendation:** (approve, or what to decide first, and why)

Closes #<issue labelled task>
Issue: #<issue labelled task>
Claim: <sha printed by .gate/bin/claim>
Team: <your team's name, as in the claim>
Session: <session id or URL, or none>
Cost: <amount and harness, or unknown>

## Summary for the Human
- Purpose: (1 sentence)
- Change: (≤ 3 bullets)
- Evidence: verify green at <sha>; new test red at base; review: n findings, fixed m, reviewer withdrew k
- Tier: 1 | 2 | 3 (paths touched: …)
- Rollback: revert this PR | has migration <name>, roll back with …
- Needs the Human: no | yes: <question> — recommendation: <answer>

<!-- Cannot write a failing test first? Add a line of its own: No-red: <reason, at least 20 characters>. The reviewer must accept the reason, or `review` fails; the ledger counts this line. -->
