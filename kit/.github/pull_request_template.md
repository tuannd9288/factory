**Tóm tắt cho anh**
<!-- Tier 3 only: delete these lines on tier 1 and 2. This is the repository's only Vietnamese (AGENTS.md, its Language line): plain words, with the terms in English (PR, main, revert, Approve), no commit ids and no file paths. A decision for the Human goes in Đề xuất, numbered, each with your recommendation. A push that makes these lines untrue rewrites them in the same push. The title carries no issue number; the issue is in `Issue:`. -->
- **Thay đổi:** (anh sẽ thấy gì khác, và PR này làm gì)
- **Rủi ro:** (có thể hỏng gì; muốn bỏ thì revert PR này)
- **Đề xuất:** (Approve; hoặc điều anh cần quyết trước, đánh số, mỗi điều kèm đề xuất)

<details>
<summary>The change in detail</summary>

- Purpose: (1 sentence)
- Change: (≤ 3 bullets)
- Evidence: verify green at <sha>; new test red at base; review: n findings, fixed m, reviewer withdrew k
- Tier: 1 | 2 | 3 (paths touched: …)
- Rollback: revert this PR | has migration <name>, roll back with …

</details>

Closes #<issue labelled task>
Issue: #<issue labelled task>
Claim: <sha printed by .gate/bin/claim>
Team: <your team's name, as in the claim>
Session: <session id or URL, or none>
Cost: <amount and harness, or unknown>

<!-- Cannot write a failing test first? Add a line of its own: No-red: <reason, at least 20 characters>. The reviewer must accept the reason, or `review` fails; the ledger counts this line. -->
