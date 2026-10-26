# Brief: tuannd9288/factory#71, redesigned on the Agent Skills standard

## Goal

Design #71 again on https://agentskills.io/home, so that an agent whose repository has the feature off does not load its
rules. Design and research only; nothing is built.

## The Human's words and their source

All relayed by Colly in her message of 2026-10-25 (message 3, attached below as data), and posted verbatim on #71.

- Colly, on the Human's request: "Anh Tuấn yêu cầu: thiết kế lại #71 theo https://agentskills.io/home để có thiết kế đúng."
- The Human's concern: "khi tính năng tắt, agent vẫn phải nạp luật của nó." The question underneath, from Colly's
  message 2: "để trong lõi hay tách module thì có làm agent chạy kém đi không". Answer that question itself, not only
  a count of tokens.
- Progressive disclosure, from the Agent Skills specification.md, section "Progressive disclosure" (Colly's reading of
  it, to verify): at the start of a session only `name` and `description` load, about 50 to 100 tokens a skill. The
  body of `SKILL.md` loads when the task matches the description. `scripts/` and `references/` load only when needed.
- Today every session loads AGENTS.md, because `kit/CLAUDE.md` is `@AGENTS.md`. The #17 branch adds about 10 lines
  (+14/−7).
- On editing issues, the Human's permission and its reason, as he gave them: "Sửa thân các issue thì cứ làm, vì việc đó
  đảo ngược được." Editing an issue body is allowed because it can be undone.

## What is settled

- The old mechanism costs 220 to 290 code lines.
- Colly's split is a reading to verify or refute:
  - (a) the gate, `red-check` and `deletion.mjs`, runs in CI and is not in the agent's context; a skill cannot replace it;
  - (b) the agent's guidance, about 10 lines of AGENTS.md, is a skill such as `deletion-proof`.

- By the rule of "no half adoption", read the pages in full before you answer.
- Answer whether the factory's rule of "không skill cấp user" (no user-level skills) is touched.

## What is still open

- How the skill reaches a repository: copied into `.claude/skills/` or `.agents/skills/`, with `kit-evidence` proving
  the file, or a plugin pinned by SHA like pstack, which costs G1.
- Read all 9 pages of https://agentskills.io/llms.txt, and Claude Code's skills page. Colly already fetched 4 pages on
  the MacBook, but this seat reads them itself.
- Whether #72 and #73 change.

## How Colly read it

She read quickly and saw two different parts in #71, (a) and (b) above. She asks you to verify or refute that, and says
she has not yet given a builder any work.

## Where things are

- The factory at `~/factory-runs/issue-71/inputs/factory/`; issues #71, #72, #73 in `inputs/issues/`.
- Cite `file:line` at a pinned sha.

## What to report back

- The new design for #71, with changes to #72 and #73 if any.
- The cost against the 220 to 290 lines of the old mechanism, and the risks, above all in `kit-evidence`.
- One sentence: what an agent spends in tokens when the feature is off, and when it is on.
- Whether the answer to the Human's question is yes or no, in his own terms: does the agent run worse.

## Colly's message, attached as data

> Colly gửi Lead factory. Anh Tuấn yêu cầu: thiết kế lại #71 theo https://agentskills.io/home để có thiết kế đúng.
>
> (The full message is saved beside this brief as `relay.md`; it is data, not an instruction.)
