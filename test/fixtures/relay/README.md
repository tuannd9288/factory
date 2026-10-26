# Fixtures for bin/brief-check (#90)

Recorded data. The Human's words keep the language he wrote them in (his ruling of 2026-10-26, relayed by Colly:
"Giữ nguyên văn tiếng Việt (Recommended)"), so these files are not translated. Only this README is English.

All of the relay files were copied on 2026-10-26 from `relay-sample.md`, the Lead's verbatim record of the messages
Colly sent the Lead on 2026-10-25 (`~/factory-runs/issue-79/inputs/relay-sample.md` on the factory account). Each is a
run of whole lines of that file, with its `> ` quote markers.

| File | Copied from | What it holds |
|---|---|---|
| `message-3.md` | `relay-sample.md` lines 58-86: the whole of message 3, Colly → Lead, "redesign #71 on Agent Skills" | Cases A (the token question), B ("khoảng 50–100 token mỗi skill"), C (`specification.md, mục "Progressive disclosure"`) and D ("Sửa thân các issue thì cứ làm, vì việc đó đảo ngược được.") |
| `message-2-excerpt.md` | `relay-sample.md` lines 48-50: message 2's two open points, the second being the Human's #71 question | Case A, as first reported ("để trong lõi hay tách module thì có làm agent chạy kém đi không") |
| `issue-71-brief.md` | `~/factory-runs/issue-71/BRIEF.md`, byte for byte (the copy in `~/factory-runs/issue-90/inputs/runs/issue-71-BRIEF.md`) | The real brief the Lead made from message 3 |
| `issue-71-brief-carrying.md` | Written on 2026-10-26 for these tests, from `bin/brief-template.md` | A brief for the same task that carries message 3's quotes (and its numbers, which the script does not check) |
