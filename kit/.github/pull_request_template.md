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
