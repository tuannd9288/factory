**Tóm tắt cho anh**
<!-- Tier 3 only: delete the two blocks (this one and **TL;DR**) on tier 1 and 2. The Vietnamese block is the repository's only Vietnamese (AGENTS.md, its Language line): plain words, with the terms in English (PR, main, revert, Approve). Each line is one sentence of about 15 words, with no commit id and no file path. A decision for the Human goes in Đề xuất, numbered, each with your recommendation. Add a fourth line, `- **Nếu không trả lời:**` and `- **If no answer:**`, only when silence has a consequence; on a pull request it almost never does. A push that makes these lines untrue rewrites both blocks in the same push. The title carries no issue number; the issue is in `Issue:`. -->
- **Anh quyết:** (duyệt PR này, và anh sẽ thấy gì khác)
- **Đề xuất:** (Approve; hoặc điều anh cần quyết trước, đánh số, mỗi điều kèm đề xuất)
- **Rủi ro:** (có thể hỏng gì; muốn bỏ thì revert PR này)

**TL;DR**
- **You decide:** (approve this PR, and what you will see change)
- **Recommendation:** (Approve; or what you must decide first, numbered, each with your recommendation)
- **Risk:** (what could break; to undo, revert this PR)

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
