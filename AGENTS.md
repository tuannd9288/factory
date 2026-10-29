# The factory

This repository (`tuannd9288/factory`) is the root of the Human's software factory. On the Mac mini it is cloned
in the agents' own macOS account, `factory` (#24), as `~/WORKSPACES`; each repository in the factory is a subfolder
there, cloned from GitHub and ignored by this root's git. That account holds the agents' gh login (`tuan9288-agent`
alone), their profiles and their Herdr; the Human reaches it with `ssh factory@<the Mac mini>`. His own account keeps
his SSH keys and gh login behind its home, `drwx------` on the Mac mini (Colly's measure, 2026-10-24); the probe's
`#24 file` lines must show both files refused. The clone is outside `~/Desktop`, which macOS privacy controls (TCC)
close to launchd jobs that were not granted access; not tested here. This file covers the factory's rules and taking a repository in. Inside a repository, that
repository's own `AGENTS.md` governs.

## Decisions

- **K1, 2026-10-21 (the Human: "Triển khai theo đề xuất đi").** A reversible change in tier 1 or 2 merges by rule
  once the repository's gate is green on its head commit. The Human keeps tier 3, a change stuck after three
  rounds, and every deploy.
- No change auto-merges in a repository until its gate has passed the attacks and the 20 seeded + 20 clean probes
  on a scratch repository against two bars (the Human, 2026-10-21): the mechanical bar, every mechanical defect
  caught; and the full-gate bar, with the real reviewer, at least 18/20 seeded caught, every load-bearing one caught,
  at most 1/20 clean blocked. `probes/plan.md` states both; `probes/results.md` has the first run's numbers.
- agent-desk stays parked. Every lead, worker and reviewer runs through Claude Code. (In this section since 2026-10-21,
  `1b319ee`.)

Each line below gives the Human's decision or decisions on one matter, its date and its source; the lines run by date.
A quote keeps his words and his language. The WORKSPACES map is
https://claude.ai/artifact/XAUqXMKx1vXJT5bKDGAY1x, which he settled on 2026-10-25, relayed by Colly.

- **Use what exists first, 2026-10-18.** Use a ready-made product first; build only when it falls short. Source:
  agent-desk issue #269, as the map's "Đã quyết" block records it.
- **First product repository, 2026-10-20.** It is not docparse or tuanhub-notifier: "đang ổn, không cần". Source:
  the live copy of the page "Môi trường repo cho agent", decision 3, as the map records it.
- **seatwork, 2026-10-21.** seatwork may be used freely, its code and its text alike. Source: the page "Factory của
  anh", p:372, as the map records it (the page's wording: "seatwork dùng thoải mái, cả mã lẫn chữ").
- **One thin core, a pack for each way of working, 2026-10-22.** The core is the environment, the gate and the ledger;
  a way of working is a pack that a repository chooses by one tier-3 line; only the pstack pack is built now. There
  is no piggery pack (T1 off), OTel stays off (T2 off, as the map records it), and only the Human can bypass
  the tag ruleset. The Human agreed to all eight decisions on the page as it recommended them. Source:
  https://github.com/tuannd9288/factory/issues/2#issuecomment-6337959043 (the page:
  https://github.com/tuannd9288/factory/issues/2#issuecomment-6336996220).
- **Cleanup of unused code, 2026-10-22.** C1, C2 and C3 all take option B; T1 and T2 on, T3 off; the Human approved
  all five as the page recommended. As the Lead's summary of the page puts it: one sweep of each repository when it
  joins, then the weekly digest counts again (C1); for a pull request that only deletes, a machine proof stands in for
  `No-red:` (C2); the reviewer may raise a tier, never lower one (C3); a cleanup pull request red twice is closed by
  its agent (T2). Source: https://github.com/tuannd9288/factory/issues/10#issuecomment-6341670200 (the summary:
  https://github.com/tuannd9288/factory/issues/10#issuecomment-6338917177).
- **The agents' macOS account, 2026-10-23.** The agents run in their own macOS account, `factory`. Source: #24's body,
  "approved by the Human on 2026-10-23" (https://github.com/tuannd9288/factory/issues/24); done as
  https://github.com/tuannd9288/factory/issues/24#issuecomment-6387379979 records.
- **Feature flags, 2026-10-24.** Not needed for now; revisit when real customers use a product daily. #16 and #21 are
  moved to Triage, "Để sau", as #10 c3 records. Source:
  https://github.com/tuannd9288/factory/issues/10#issuecomment-6372273891 (the Human, through Colly).
- **The gate's reviewer, 2026-10-24.** The reviewer is the sealed Opus 5.5 reviewer (option A), run as Claude Code
  headless and paid with a subscription token, not an API key. In #25 c2's words, "One reviewer call per pull
  request": `verdict` reads `review`'s result for the same head and base, and makes no second call. The gate and
  pstack's live verifier both stay for now; dropping one is decided only on the probe's numbers. Source:
  https://github.com/tuannd9288/factory/issues/25#issuecomment-6372755422 (reviewer and payment) and
  https://github.com/tuannd9288/factory/issues/25#issuecomment-6373226939 (one call; both layers stay).
- **Colly's scope, 2026-10-24.** Colly handles only the factory. The piggery teams of Kizuna and kizuna-labs report to
  the Human directly. Source: chat, as the map page records it in Vietnamese; this line is an English rendering, not
  his words.
- **Connection over custom, 2026-10-24.** "Hạn chế kiểu custom mà thay vào đấy là cách kết nối." Source: chat, as the
  map page records it.
- **Three new sources (#58), 2026-10-25.** K1 = D: keep the sublayers and take mechanisms from the three sources (the
  option is recorded in `inventory-factory.md` §A, row BN, which the map's §7 cites; no sentence in #58 or #62 to #68
  names it). K2 = B: read each profile's quota from what Claude Code itself reports (`rate_limit_event`, and the
  status line's `rate_limits`), never a credential; quota-axi is dropped, also as a fallback; if #62
  finds no source, stop and ask the Human. His words on K2: "B, bỏ quota-axi (Recommended)". T1 on: one state for each
  open task, computed in the sweep. T2 off: HumanLayer's phone plugin is not taken. Sources: the bodies of
  https://github.com/tuannd9288/factory/issues/62, /63 (K2), /64 (T1) and /68 (T2); his words:
  https://github.com/tuannd9288/factory/issues/63#issuecomment-6401665776.
- **Control surfaces (#68), 2026-10-25.** K3: keep Paseo's usage plugin as it is. K1 = C, which holds on his own check
  (still waiting on him): Rex replaces Ghostty, and Herdr for the interactive sessions on the MacBook, and Herdr keeps
  the factory's sessions on the Mac mini; if a Claude Code session at a permission prompt in an unfocused tab shows no
  blocked mark in the tab header and the session picker, K1 becomes B. K2 = B: layer 1e and contract H9 are added.
  T3 = on (#78's body): Remote Control for Colly's and the Lead's interactive sessions, beside Paseo, following
  whichever account the session runs on. On 2026-10-26 the Human deferred it until he moves to an account that can use
  it: "Tài khoản này tau không dùng được /remote-control delay sau được không Hoặc tau chuyển tài khoản khác khi
  tiện?" (https://github.com/tuannd9288/factory/issues/78#issuecomment-6400797388). Paseo stays. Sources:
  https://github.com/tuannd9288/factory/issues/68#issuecomment-6393212307 (K3),
  https://github.com/tuannd9288/factory/issues/68#issuecomment-6394536120 (K1, K2; T3 was pending there) and
  https://github.com/tuannd9288/factory/issues/78 (T3 on).
- **Evidence for a deletion-only pull request (#70), 2026-10-25.** K1 = (iv), in two steps: a module that each
  repository turns on, outside the `kit/` core. K2 = B: the proof refuses when the base holds a plugin config file that
  knip runs and it is not in `.gate/protected`. Decision (a) stands: no parser is added to the gate, and option (v) is
  not taken. No purchase: not JetBrains, not Qodana, not Graphite; semble stays a search tool. The file limits of (a)
  are dropped, "Đồng ý bỏ giới hạn (Recommended)": every file knip lists, `.jsx` and `.tsx` included, can carry the
  machine proof. Sources: https://github.com/tuannd9288/factory/issues/70#issuecomment-6394028120 (K2, (a), no
  purchase), https://github.com/tuannd9288/factory/issues/70#issuecomment-6395152044 (limits),
  https://github.com/tuannd9288/factory/issues/71#issuecomment-6395151620 (item 4) and #71's body (K1 = (iv)).
- **The module and the protected tail (#71, #72), 2026-10-25.** His labels: "S2: chỉ chép vào repo bật (Recommended)",
  so the module's skill is copied only into a repository that turns the module on; "Đồng ý (Recommended)", so two
  lines are added to `kit/.gate/bin/prove-check`; "Cho file một phần đuôi của repo (Recommended)", so `.gate/protected`
  keeps a tail the repository owns, as `AGENTS.md` has Layout and Facts, while `kit-update` keeps updating the kit's
  head, and the end of `.github/CODEOWNERS` follows. Sources:
  https://github.com/tuannd9288/factory/issues/71#issuecomment-6395151620 and
  https://github.com/tuannd9288/factory/issues/72#issuecomment-6395151814.
- **The order of the gaps, 2026-10-25.** "Theo thứ tự này (Recommended)": 0c (in progress), then 1b, then 3c, then 4a;
  0d follows #75 and #77; 2c comes last. Source: his answer in Colly's session, relayed by Colly, in the map's report
  §0 and https://github.com/tuannd9288/factory/issues/81.
- **The live verifier, decided 2026-10-25; not built yet.** It was open at the map (it runs on Codex, against the
  rule above, "Every lead, worker and reviewer runs through Claude Code."), and he decided it on #79's choice page:
  "Ô cài đặt, mặc định Claude (Recommended)". The verifier's model is a setting for each repository, Claude
  by default; Codex or both can be chosen; the verifier stays (#25). #95 builds it; until then it runs on Codex only,
  as "The live verifier" paragraph below says. Sources:
  https://github.com/tuannd9288/factory/issues/79#issuecomment-6398968431 and
  https://github.com/tuannd9288/factory/issues/95.
- **The instruction layer (#131, #132), 2026-10-27.** On #131: "Viết từ A (Recommended)" and "Làm F1–F2 ngay, F3 sau 1/11
  (Recommended)"; that evening, "Ok, cho các đội triển khai đi, song song nếu được." ("Ok, let the teams carry it out, in
  parallel where possible", Colly's translation), which replaced the wait for 1/11. On #132's instruction layer he answered
  the three questions of the decision page (https://claude.ai/artifact/SLNEk1B5nTict8swrmbBqD) with "Theo đề xuất của mày",
  and so took Colly's recommendations: the composed root `AGENTS.md` stays at most 150 lines and gains a 32 KiB cap (K1);
  neither `ARCHITECTURE.md` nor `docs/` is required (K2); the Gate block states the gate's obligations directly, and
  `CLAUDE.md` is `@AGENTS.md`, an addendum allowed, or a relative symlink to `AGENTS.md` (K3). He had asked for it after the
  review: "Cho Astra review lại rồi đề xuất cho đúng thiết kế". This revises two earlier decisions: the pack decision of
  2026-10-22 (a way of working is a folder a team copies, not a pack a repository chooses by `.gate/pack`) and the scope of
  "Every lead, worker and reviewer runs through Claude Code" (the instruction file is for any harness; `ship` and the
  live verifier are the pstack team's, in `packs/pstack/`). 2a and H4 stay as they are, and so does "Cho file một phần đuôi
  của repo (Recommended)" of 2026-10-25: the kit owns a smaller head, one marked `## Gate` block, and the repository owns the
  tail, with its own headings. Sources: https://github.com/tuannd9288/factory/issues/131#issuecomment-6445068794 and
  https://github.com/tuannd9288/factory/issues/132#issuecomment-6445063962 (the questions and K1 to K3), and
  https://github.com/tuannd9288/factory/issues/131#issuecomment-6446708922 (the evening words), all relayed by Colly.
- **No `gh api` without his approval.** His standing rule, undated; source: the map's "Đã quyết" block.

## Tiers

The change sets the tier, by the paths it touches (`.gate/bin/tier`), never the author.

| Tier | Trigger | Must be true to merge | The Human |
|---|---|---|---|
| 1 | no tier-2 or tier-3 path | `verify`, `review`, `verdict`, `tier` green on the head commit; `verdict` passes at once | none |
| 2 | a `.gate/load-bearing` path, or a dependency manifest | the same, with `verdict` judged by the reviewer | reads it in the weekly digest and on the deploy page |
| 3 | a path in `.gate/protected` (the gate, `AGENTS.md`, `.claude/`, test and lint configuration), or the label `needs-human` | tier 2 and his approval of the head commit, or of one whose patch the head carries unchanged, which `tier` checks | approves from the summary |

A tier never drops within a pull request: every label `tier-N` or `needs-human` it ever had raises it, even once
removed.

Agents open pull requests under their own GitHub account, never the Human's. GitHub refuses an author's approval of
his own pull request, and its code-owner rule asks nothing of an author who owns the code: on the scratch repository
a tier-3 pull request opened from the Human's account merged with no approval (2026-10-21). So the `tier` check
itself requires, on tier 3, an approval of the head commit by a code owner who is not the author.

## What the Human keeps

- Tier 3 approvals, `needs-human` pull requests (stuck after three rounds), and every deploy.
- Admin steps: running `bin/onboard-owner` (the agents' account, rulesets, the `reviewer` environment), the
  reviewer's secrets, registering the runner.
- Logging into a repository's profile and the verifier's Codex profile. An agent never logs in or switches accounts.

Everything else that can be undone, agents decide and report after.

## Layers, sublayers and contracts

The map the Human settled on 2026-10-25: five layers, 17 sublayers, nine contracts. "Layer" and
"sublayer" come from IEEE 802.3, 4.1.1 [IEEE], read in the draft amendment P802.3as/D0.1 (March 2005):
"The LLC sublayer and the MAC sublayer together are intended to have the same function as that described in the OSI model for the Data Link Layer alone."
Each name carries a source key; the keys, with their URLs and how fully each was read, are in
https://github.com/tuannd9288/factory/issues/80#issuecomment-6399460150. Every issue and proposal names its sublayer.

- **Layer 0 Substrate** [SH]: what every agent runs on.
- **Layer 1 Orchestration** [SD3, A1]: how work is given out and watched.
- **Layer 2 Workers** [F2]: what a worker reads, uses and runs before it opens a pull request.
- **Layer 3 Merge gates** [OA1]: what decides whether a change lands.
- **Layer 4 Observability & evals** [SH, U1, A8]: what shows cost and whether the factory improves.

- **0a Environment** [S2, OA1]: the `factory` account, `~/WORKSPACES`, the worktrees under `.claude/worktrees/`.
- **0b Tools & permissions** [A5, A2]: the deny rules, the permission mode, the agents' `gh` login.
- **0c Model configuration** [MODELCFG]: which model a role runs on; one profile for each repository; the factory's own runs use one profile per seat, `~/.agent-profiles/seats/<n>/claude`, which the launcher picks.
- **0d Harness & session** [A2]: the loop that runs Claude Code: `direnv exec`, `bin/claude-canary`.
- **1a Issues** [GH2]: where work comes in: one issue labelled `task`.
- **1b System of record** [OA1, UAC]: where work is recorded: issues, pull requests, the ledger.
- **1c Orchestrator-workers** [A1]: a lead gives each task to a worker.
- **1d Monitoring** [GH1]: `bin/factory-queue`, `bin/factory-alerts`, the ledger's canary.
- **1e Surfaces** [GH2, #68]: the Human's own screens: the Herdr TUI, Paseo's app, Rex on the MacBook (K1 = C, pending his
  check) and Remote Control (T3, pending). Herdr's server and Paseo's daemon stay in 0d.
- **2a Context** [SP2, OA1]: what a session reads: the repository's `AGENTS.md`, at most 150 lines and 32 KiB composed.
- **2b Skills & plugins** [A5]: the pack and its plugin (pstack), pinned for each repository, and the modules (#70) a
  repository lists in `.gate/modules`, each bringing its own skill.
- **2c Verification** [SP3]: what a worker runs before the pull request: `.gate/bin/verify`, `red-check`.
- **3a Required status checks** [GH3]: `verify`, `review`, `verdict` and `tier`, green on the head commit.
- **3b Risk tiers** [A8]: tier 1, 2 or 3, set by the paths a change touches.
- **3c Merge & rollback** [A8]: a merge commit through auto-merge, the merge queue, a revert pull request.
- **4a Observability & cost** [SH, U1]: the ledger's cost for each task and the weekly digest.
- **4b Evals** [A8]: the attacks and the 20 seeded + 20 clean probes.

A sublayer may change anything inside it while its contracts hold; a change to a contract is tier 3 (as is every change
here). A contract is named by its code. Its sentence states the factory's rule; the rule's source is the Human's
decisions (#58, #79, #68) and the map. A "Prior art" line quotes an organization that does the same.

- **H1**: Work enters through one issue. Checked by: `kit/.gate/gate-section.md` (the Gate block), `probes/pack-contract.md:36`.
  Prior art [GH2]: "You can start work from the agents panel, a conversation, or an issue or pull request on GitHub.com."
- **H2**: Work leaves through one pull request that carries its evidence.
  Checked by: `kit/.github/pull_request_template.md:1-9`, `probes/pack-contract.md:36`.
  Prior art [A8]: "Require CI, and add "Testing", "Risk" and "How to revert" to your PR template."
- **H3**: A verdict binds exactly one commit.
  Checked by: `kit/.gate/bin/lib/approval.mjs:1-10`, the row "Tier 3 lands only with the Human's approval of the head commit…" in `kit/.gate/enforced-rules.md`, `kit/.gate/bin/review:27` (one reviewer call per head).
  Prior art [A8]: "An approval covers one specific commit."
- **H4**: Knowledge is files in the repository, changed by pull request.
  Checked by: `kit/.gate/protected:14` (`AGENTS.md` is tier 3), `kit/.gate/bin/lib/instructions.mjs` (150 lines and 32 KiB, run by `verify` and, on the candidate's git objects, by `verify-trusted`).
  Prior art [OA1]: "Repository-local, versioned artifacts (e.g., code, markdown, schemas, executable plans) are all it can see."
- **H5**: A way of working is a pack of data.
  Checked by: `probes/pack-contract.md`, `probes/pack-probe.mjs`, `packs/pstack/test/pstack.test.mjs`.
  Prior art [SH]: "A profile is data: a system prompt, a set of skills, a set of extensions, a sandbox policy, model defaults."
- **H6**: Tools are commands; permissions live outside the instructions.
  Checked by: `kit/.claude/settings.json:3-28`, `probes/pack-contract.md:22`, `probes/pack-contract.md:62-76` (the `factory` account, #24).
  Prior art [A5]: "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic and guarantee the action happens."
- **H7**: Model choice lives outside the way of working. Checked by: none yet (#62 and #63 do part of it).
  Prior art [SD3]: "The `model_stylesheet` graph attribute provides CSS-like rules for setting default LLM configuration on nodes."
- **H8**: An improvement comes back as ordinary work.
  Checked by: `.github/CODEOWNERS:4`, `probes/score.mjs`, `probes/plan.md`.
  Prior art [F1]: "When patterns cross a threshold, it files Linear tickets automatically."
- **H9**: A surface is only a window. Five rules (#68; surfaces page §5.2): (1) a surface never starts or owns the
  factory's unattended sessions; 0d does; (2) the record of a task stays on GitHub (1b) and in 0d's panes, and a surface
  keeps no sole copy; (3) the factory's own code in this sublayer reads no credential (#58 K2; this binds the factory's
  code, not the Human's own tools, and K3 keeps Paseo's usage plugin as it is); (4) only a person answers a permission
  prompt, so agents do not type into another pane: `herdr agent send-keys`, `herdr pane send-keys`, `rex send` and
  `rex send-key` are denied, which is #76 and not yet in the kit's deny rules; (5) with every surface stopped, the
  factory still runs. Checked by: none yet. The check will be a test that stops every surface process and shows that a
  `bin/factory-queue` sweep (the merge queue) and a `probes/pack-probe.mjs` run (the pack probe) still pass.
  Prior art [OA2]: "The App Server's JSON-RPC surface is designed to be backward compatible, so older clients can talk to newer servers safely."

## This root

- No `CLAUDE.md` here. With one, Claude Code reads it and skips the `AGENTS.md` of every repository below
  (tested on Claude Code 2.1.304, 2026-10-20). Each repository's `CLAUDE.md` starts with the line `@AGENTS.md` (prose may
  follow) or is a relative symlink to `AGENTS.md`.
- Nothing in a repository points outside it: no links into `~/Desktop/TuanHub`, no user-level skills.
- This folder stays out of every sync between the Macs. Code moves only through GitHub.
- `.gitignore` admits only the factory's own files, so every repository folder is ignored.
- A change to `kit/` changes every repository's gate at its next kit pull request: it is tier 3 here.
- Before any brief, the Lead posts the Human's words verbatim, with their source, on the issue, in a comment marked
  "relayed by Colly"; the brief carries them, and `bin/brief-check <brief> <relay>` is the check (#90).
- The weekly digest is `bin/factory-ledger --post tuannd9288/factory`: it posts even when the canary (`--check`) finds a
  field missing or stale, saying so in one line. No job runs it yet; its schedule (launchd, as the agents' account) is
  the Human's to set up.
- Do not test the wording of a prompt, rule, template or skill; the rule lives in the prompt or AGENTS.md, and review
  reads it. A test that reads text stays only when a program in this repository reads those bytes: a parser, a hash a
  script compares, or a file `onboard` or `kit-update` writes (#112).
- The Human (2026-10-29, #171), to every reviewer: "Rate each bug from 1 to 10 on how often it would happen and how bad it
  would be. If the two scores multiplied are below 5, just file it as an issue and leave the code alone." To every writer:
  "Do not design for rare or future cases nobody asked about." Claude Code reads this file in a project with no
  `CLAUDE.md`, as every factory worktree is. The kit's Gate block holds both; its reviewer reports such a bug in
  `forIssue`, which never blocks, and the Lead files the issue.

| Path | What it is |
|---|---|
| `kit/` | The core every repository receives through one pull request when it joins: gate, hooks, templates, deny rules, and the Gate block (`kit/.gate/gate-section.md`) that `bin/onboard` puts into the repository's own `AGENTS.md` |
| `packs/` | A way of working, one folder each (`packs/pstack/`), that a team copies into its repository: scripts, `.gate/driver.json`, the pin, the prose for its `AGENTS.md` (`section.md`), rows for `.gate/enforced-rules.md`, `INSTALL.md`, NOTICE, tests and attacks; nothing composes it; `packs/pstack/bin/` and `lead.md` stay in the factory and are not copied |
| `modules/` | What only a repository that turns it on receives, one folder each (`modules/deletion-proof/`): `kit/` at repository paths (its skill included), `test/`; `bin/lib/module.mjs`, `bin/onboard --module`, `bin/kit-update --module` / `--no-module` |
| `bin/onboard-owner` | The Human's half of taking a repository in: account, rulesets, `reviewer` environment |
| `bin/onboard` | The agents' half: clone, profile, kit, verify, the kit pull request |
| `bin/kit-update` | The onboarded repository's counterpart of onboard: brings its clone up to a factory commit, with evidence, in a pull request from `factory/kit-<sha7>` |
| `bin/kit-evidence` | Proves the kit pull request's files are the kit at one factory commit, by git object |
| `bin/rulesets/` | The rulesets `bin/onboard-owner` sets besides the kit's gate |
| `bin/factory-ledger` | The ledger (one row per task) and the weekly digest; it charges an entry to a repository by its own profile, or by `cwd` under `<root>/<repo>` in `--profile-dir` folders; `--check` is its canary on Claude Code's session format |
| `bin/factory-queue` | The merge queue: updates one auto-merge PR at a time when `main` moves, and re-runs the tier check after the Human approves |
| `bin/brief-check` | Compares a brief with the relay it came from, with no model call: every double-quoted span of the relay must be in the brief's own body, above the attached message; `bin/brief-template.md` is the brief's seven fields and that attachment |
| `bin/factory-sublayers` | The sublayer check (#82): the 17 `sublayer-<code>` labels exist with their descriptions, and every open issue carries exactly one; the list is `bin/lib/sublayers.mjs`, the template `.github/ISSUE_TEMPLATE/task.md` |
| `probes/` | The gate's attacks and the 20 seeded + 20 clean probes on factory-scratch: plan, driver, results, `score.mjs` (scores the heads, costs per job, stops at the first unavailable reviewer); `probes/pack-contract.md` is what a way of working keeps, `probes/pack-probe.mjs` proves it |
| `scripts/verify` | This repository's own checks: the kit's tests in `test/`, each pack's in `packs/*/test/`, and the budget of the kit's Gate block (26 lines, 3072 bytes), which leaves every repository room under the 150 lines and 32 KiB of its composed `AGENTS.md` |
| `test/` | The kit's tests; each check is shown failing on a bad input |
| `NOTICE` | What was taken from other projects, with the commit |

## Taking a repository in

Two halves, the Human's first. From this clone, logged into `gh` as the repository's owner, he runs
`bin/onboard-owner <owner/repo> --id <id>`, reads the changes it prints, and runs it again with `--apply`. The id is
the repository's own (`gh api repos/<owner/repo> --jq .id`), so a typo or a renamed repository is refused. It invites
the agents' account (write), sets `factory-branches` (every branch: no rewrite), `factory-tags` (every tag: no create,
update or delete, but for a repository admin), `factory-claims` (`refs/heads/claim/**`: no deletion, no rewrite, no
bypass) and `factory-bootstrap` (`main`: a pull request, one approval of the
last push, merge commits only), creates the `reviewer` environment for `main`, and
reads it all back; it calls only `gh api`, never `git` and nothing the repository holds. A claim on an issue is the ref
`claim/<n>`, taken with `.gate/bin/claim`; `verify-trusted` checks the pull request body's `Team:` line, and `tier` its
`Issue:` and `Claim:` lines against that ref (`Session:` and `Cost:` inform only). Once the agents' account
has accepted the invitation, an agent runs `bin/onboard <repo-url>` from this root, logged into `gh` as that account.
It refuses any other login, and a `main` without the bootstrap pull request rule:

1. clones the repository into `<root>/<repo>`;
2. creates its profile `~/.agent-profiles/<owner>/<repo>/claude`, only now, and writes there a `settings.json` that
   turns off claude.ai's connectors and synced skills and plugins (a repository's settings cannot turn the syncs off),
   stays on the stable update channel and runs `bin/factory-alerts` at session start; a profile that exists is kept,
   and onboard prints every key for the Human to add. Nothing else edits the
   profile, which beyond that holds Claude Code's state only (a Codex profile joins when Codex does);
3. writes `.envrc` (`CLAUDE_CONFIG_DIR` pointing at the profile), adds it to `.git/info/exclude` and runs
   `direnv allow`; an `.envrc` the repository has is kept, and onboard prints the line to add to it. Either way
   `.claude/worktrees/` joins `.git/info/exclude`: Claude Code's worktrees go there, inside the repository, so they
   find its `.envrc`, and `git add -A` never stages one under the tier-3 `.claude/`;
4. lays the kit over it: `.gate/` (the commands in `.gate/bin/`, the hooks in `.gate/hooks/`, the Gate block
   `gate-section.md`, and `kit-commit`, the factory commit it came from), the gate workflows, the PR template, `CODEOWNERS`
   and the deny rules. The repository keeps its own `AGENTS.md` and `CLAUDE.md`: the kit puts one marked `## Gate` block
   at the start of `AGENTS.md`, after an optional title line, and writes the import `@AGENTS.md` as `CLAUDE.md` only where
   there is none (`kit/.gate/bin/lib/instructions.mjs`). An `AGENTS.md` that would be over 150 lines or 32 KiB with the
   block, a Gate marker that is malformed, CRLF or a byte-order mark, or a `CLAUDE.md` that neither starts with `@AGENTS.md` nor links to
   `AGENTS.md` refuses the run and removes the clone; the kit cuts and rewrites nothing. `--own <file>` is a complete
   `AGENTS.md` the repository prepared, used in place of the clone's and checked the same way. The kit ships no
   `scripts/verify` and no `.githooks/`, so the repository's own `scripts/`, helpers and
   hooks stay byte for byte. With its own `scripts/verify`, onboard ends the `.gate/config.sh` it lays with the adapter
   block (`bin/lib/adapter.mjs`): `GATE_NATIVE=scripts/verify`, `GATE_CHECKS="${GATE_CHECKS:+$GATE_CHECKS }native"` (it adds to the checks named above it), and `gate_fast() {
   .githooks/pre-commit; }` only when that hook exists and does not call `.gate/bin/verify`; a `.gate/config.sh` the
   repository has is kept. A `.claude/settings.json` the repository has gets the kit's deny lines inserted as text
   (`bin/lib/settings.mjs`) and nothing else changes; a shape it cannot take is refused and the clone removed; where
   there is none, the kit's own file is laid as it is, deny lines only, with no pin: the Human's rule that the pstack pin
   stays in the repository, one for each repository, keeps a pin that exists byte for byte, and a repository with none is
   not made to take one (a team brings it in its own pull request). Every other file the repository already has is kept.
   The kept and untouched lists go in the pull request, kept ones for its session to merge by hand;
5. runs the full `.gate/bin/verify`, which runs the repository's own verify as the `native` check, and only when it
   passes commits the kit and opens its pull request, authored by
   the agents' account. When it fails the kit stays staged on `factory/kit` for the repository's session to finish.
   The pull request carries `bin/kit-evidence`'s result: every managed file against the kit at the factory commit
   (contents, modes, symlinks), `CODEOWNERS` line by line, `AGENTS.md` as the repository's own text with the block
   inserted (an `--own` file's text in full) and `CLAUDE.md` as the repository's own, `.gate/kit-commit` as the factory
   commit, the files the repository kept, `.claude/settings.json` as merged (its bytes
   plus the kit's deny lines), `.gate/config.sh` as the kit's text plus the adapter block, the repository's own
   `scripts/` and `.githooks/` files as untouched, and nothing else changed, bound to that commit, the kit's tree, the repository's id, base and head. Onboard opens it only from a
   factory commit on `origin/main` whose `kit/` has no uncommitted, untracked or ignored file, since it lays the kit
   from the working tree.

Use `bin/onboard` once, for a repository that has no kit yet. Use `bin/kit-update <repo-url|name> [--no-pr]` for every
later move of an onboarded repository to a newer factory commit; onboard keeps every file the repository has, so it
cannot bring a stale kit file up to date. Kit-update works on the clone onboard made, under the same refusals
(a clean factory commit on `origin/main`, the agents' login, the pull request rule) and the same verify and evidence,
and does nothing when the clone is dirty or `factory/kit-<sha7>` exists. It adds a missing kit file, replaces a kit file
the repository holds as an older kit had it, replaces the Gate block of `AGENTS.md` and nothing else of it (the head and
the tail stay byte for byte, and so does `CLAUDE.md`), renders `CODEOWNERS` anew, writes `.gate/kit-commit`, inserts the
kit's new deny lines into a `settings.json` the repository has, removes a file the kit dropped when it is unchanged, and
keeps and names what the repository changed. An `AGENTS.md` with malformed Gate markers, one with no block that is not
the old kit's composition (a head, a pack section, then `## Layout` and `## Facts the code cannot tell`: it gets the block
in place of that head, keeps every byte from `## Layout` on, and loses `.gate/pack`), a `CLAUDE.md` that does not reach
it, or a result over 150 lines or 32 KiB stops it, to merge by hand. A `CODEOWNERS` the repository changed is kept (named
in the pull request), so the kit's newer lines do not reach it. It refuses a repository whose `.gate/kit-files` lists
`scripts/verify`: that is the old layout, where the kit shipped its commands in `scripts/` and replaced the repository's
hooks, and the Human is told to onboard it afresh. Its evidence names each updated file with the blob it had, and fails a
pull request that changes the repository's head or tail of `AGENTS.md`. The gate judges the block of such a pull request
too: `.gate/bin/verify-trusted` reads the candidate's git objects before it lays `main`'s protected files over them, and a
block, `.gate/gate-section.md` or `.gate/kit-commit` that differs from the base's passes only when the commit
`.gate/kit-commit` names is on the first-parent line of the main of `tuannd9288/factory` (public: it is fetched, and a
fetch that fails is red; onboard and kit-update ask the same of `origin/main`), holds that block, is not older than the
base's, and leaves the tail and `CLAUDE.md` as they were. A deliberate roll back of the kit is refused by that rule; it
waits until the factory's main has moved on. A block that main reverted later still passes while it is not older than the
base's. The variable `GATE_FACTORY_URL` is for tests and takes only an absolute local folder.

Then the repository's session fills `.gate/config.sh` (test command, fast checks, its own checks with proofs),
proposes `.gate/load-bearing`, and runs the probes. The Human approves the kit pull request (the bootstrap rule asks
for his approval), runs `bin/onboard-owner … --apply` again once it merged, which puts the kit's `factory-gate` in and
only then takes `factory-bootstrap` out, sets the reviewer's secrets in `reviewer`, and logs into the profile in a new
pane opened in the repository (`echo $CLAUDE_CONFIG_DIR`, then `claude`).

Run `bin/factory-queue sweep --repo <owner/repo>...` from launchd every minute, logged into `gh` as the agents'
account (it refuses the Human's): the ruleset requires a branch to be up to date, GitHub updates none by itself, and
without the queue every auto-merge pull request strands when another lands. Each run is one sweep under a lock; a
repository whose sweep failed keeps `~/.local/state/factory/queue-<owner>-<repo>.failed` until one succeeds; a run that
fails before its repository loop keeps `queue-run.failed` until a run gets past it; a clean sweep writes
`queue-<owner>-<repo>.ok`, and the weekly digest lists every such file. A sweep that holds the lock records its pid in
`queue.lock`: if the queue stops and that pid is not running, remove `~/.local/state/factory/queue.lock` by hand. A
rollback is a revert pull request through the gate. Only when the gate itself is broken does the Human turn the
ruleset off, after taking auto-merge off every open pull request, since with the ruleset off each would land unjudged.
The queue leaves a tier-3 pull request behind `main` until the Human approved it, then updates it once; his approval
holds on the updated head, whose patch is unchanged (`git patch-id`), so he is asked once.

`bin/factory-queue plist --repo <owner/repo>...` prints that job, `com.tuanhub.factory.queue`: every 60 s from this
clone, with the `gh` and `node` the shell finds, logging to `~/Library/Logs/factory/queue.log`. With `--daemon` it is
a LaunchDaemon run by the account that printed it, `factory`, with that account's `HOME`, and never `KeepAlive`: a
sweep exits after each run, so it would restart at once, in a loop. Before loading it, run `bin/factory-queue check`
with the same repositories from the same shell: it runs one sweep in the job's environment, makes the log's folder,
which launchd does not, and says whether the job is ready. `factory`'s gh login keeps its token in a file
(`gh auth login --insecure-storage`), since the keychain is locked over SSH and under launchd. The Human installs the
plist with `sudo install -o root -g wheel -m 644 <plist> /Library/LaunchDaemons/com.tuanhub.factory.queue.plist`,
loads it with `sudo launchctl bootstrap system <that path>` and stops it with
`sudo launchctl bootout system/com.tuanhub.factory.queue`. `tuannd9288/factory` itself
is not swept: its ruleset dismisses an approval on any push, so an update would ask the Human twice.

Claude Code updates itself on the stable channel, and a new version runs only after the pack probe passes on it
(#24). `bin/claude-canary run --repo <owner/repo>` finds the newest version in `~/.local/share/claude/versions`, runs
`probes/pack-probe.mjs --no-pr` on it, and only on a pass writes the launcher `~/.local/bin/claude` (a script that
`exec`s that version; Claude Code leaves a launcher of ours in place and keeps every installed version, per
code.claude.com/docs/en/setup), then removes versions older than the previous one. A failed version is rejected
(`claude-rejected`) until a newer one arrives and the launcher stays. `bin/claude-canary plist --daemon --repo
<owner/repo>` prints its LaunchDaemon, `com.tuanhub.factory.claude-canary`, every six hours, loaded like the queue's. Every
`*.failed` file in the state folder (`claude-canary.failed`, `queue-run.failed`, `queue-<owner>-<repo>.failed`) is told to
the Human at once, at the start of each Claude session in this account, by `bin/factory-alerts`, the SessionStart hook
in each profile's `settings.json`; `FACTORY_NO_ALERTS=1` silences it, and the probe and the canary set it. The hook in
the Supervisor's own settings on the MacBook is installed by Colly, not here.

The live verifier runs on one Codex profile for every repository, `~/.agent-profiles/verifier/codex`, which only
the Human logs in: `mkdir -p ~/.agent-profiles/verifier/codex`, then `CODEX_HOME=~/.agent-profiles/verifier/codex`
before Codex's own login command. Until he has, every live verdict is BLOCKED and nothing auto-merges.

Unattended runs (launchd, `herdr pane run`) start no shell and never load `.envrc`; run them as
`cd <root>/<repo> && direnv exec . claude -p "…" --permission-mode acceptEdits --allowedTools "Bash(git branch work-*)" "Bash(git add *)" …`.
`direnv exec DIR` loads DIR's `.envrc` but keeps the caller's directory (from `/` it printed `/`, 2026-10-22), so
without the `cd` Claude starts outside the repository: on the right profile, but without its deny rules and its
`AGENTS.md`. With no permission mode `claude -p` starts in `default` and denies every call that needs approval
(2.1.308, 2026-10-22: `git branch x` gave "This command requires approval"); name the mode and the exact commands the
run may use (code.claude.com/docs/en/permissions, fetched 2026-10-22). A rule matches the text before its first `*`
as written, so a blanket `git` or `gh` grant also allows `git -C . tag y` and `gh -R x pr merge`, and a
trailing `*` admits any arguments, a refspec included (`git push origin b:refs/tags/y`): grant a push with no `*`. A
deny rule still wins over a grant; a command holding a variable or `$(…)` is denied even under a matching grant
(2.1.308, grants-check): use `--body-file`, a plain `-m '…'`.
Every unattended session of a role (worker, the Lead's reviewer, researcher; not the gate's reviewer) starts through
`bin/seat <role> <brief> --run <folder> --work <folder>` (#91), run from the factory checkout, not through a
repository's `direnv exec`. It picks the seat, sets the role's model, grants, budget and report shape, loads seat 1's
token into the child's environment only, and records the session. Every session runs with
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so its commands, hooks and MCP servers get no credential from the environment, and
every role is denied `env` and `printenv` (#181). With the scrub set, Claude Code forces the `default` permission mode,
so bin/seat asks for it. Every role writes, edits and redirects output only in the session's own folders (run, work and
each `--add-dir`), through one `Edit` rule a folder, as `acceptEdits` limited it; the worker and the reviewer also get
the filesystem commands `acceptEdits` approved (`mv`, `cp`, `rm`, `rmdir`, `touch`, and the worker `sed`), and the
researcher none of them, so it cannot move or remove the folder `research-git` clones into (#188). The scrub also drops
`GH_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` there (probe, 2.1.308), so a `gh` started inside a command finds the `factory`
user's own login; `gh` itself stays denied. The researcher is denied `git` itself; its git is `bin/research-git`, named
in its brief by absolute path. It clones over https into `<run>/clones/<name>` and reads only those clones, by name,
with `log`, `show`, `diff-tree`, `ls-files`, `rev-parse`, `rev-list` and `blame`; it refuses each option that runs a
program or reads or writes a file the caller names, and runs git with no configuration but the clone's own. So a brief
that needs a repository's history gives its https URL and a pushed commit, never a path, the factory's own repository
included. Known limit: the token file sits on disk. Claude Code refuses `cat`, `grep` or `git -C` on a path outside the
session's folders (probe, 2.1.308), but the worker and the reviewer may run `node` and `git -c`, which read and write
any file the `factory` user can; seat 1's deny rule covers the `Read` tool only (#183 puts their commands in a sandbox).
So the researcher, which reads untrusted pages and can send them out, never runs on seat 1.

A pack is what the factory holds only for one way of working, and a team copies it; the kit lays none (#132). `packs/pstack/`
holds its scripts (`ship`, `live-verify`), `.gate/driver.json`, the pin (`settings.json`), the prose for the repository's
own `AGENTS.md` (`section.md`), two rows for `.gate/enforced-rules.md` and `INSTALL.md`, the steps; a repository that
chooses it copies them in its own tier-3 pull request. There is no `.gate/pack` and no `--pack`.
The Human starts a repository's pstack Lead, an interactive session, as `factory` with
`~/WORKSPACES/packs/pstack/bin/lead <repo>`, and resumes it with `--continue` (#163); `--dry-run` prints the folder,
the plugin plan and the command and runs nothing. It runs the repository's `.gate/bin/setup` first, installs the
plugins the repository's own settings enable with `--scope local`, so the committed pin stays byte for byte, and never
adds a pin; its role text is the pack's `lead.md`. It never logs in: on the first run the Human logs in to the
repository's profile and trusts the folder.

A module is what the factory holds only for the repositories that turn it on (#71): `modules/<name>/kit/` holds the
files it adds, at repository paths (a skill among them, at `.claude/skills/<name>/`), and `modules/<name>/test/` its
tests. The repository lists its modules in `.gate/modules`, one name a line (a tier-3 path; absent means none), and
`bin/onboard --module <name>` and `bin/kit-update --module <name>` / `--no-module <name>` write it. A module's files are copied only where it is on, never over a file the repository has (a conflict, not a
"kept"), and removed when it is turned off; `bin/kit-evidence` judges them against the module at the factory commit and
treats `.gate/modules` as generated. The kit's only part in a module is two hooks, both inert without it: `red-check` runs
`.gate/bin/lib/deletion.mjs` first on a source change with no test where the file exists, and `prove-check --all` also runs
the `red-check-*` fixtures on disk. No `AGENTS.md` changes with a module: its guidance is its skill. A session in this
factory lists `deletion-proof` among its skills, because Claude Code finds `.claude/skills` nested under `modules/`;
the skill's first step reports the proof as off here. The first module,
`deletion-proof` (step 1 of #17), proves a pull request whose only source change deletes whole files knip 6.42.1 listed
as unused; no repository turns it on until #72 (a repository's knip config must be in its `.gate/protected`) lands.

pstack, per repository: the pstack pack's `packs/pstack/settings.json` pins it through a `settings` marketplace named for the
commit (`pstack-f713f14`, a `git-subdir` source at the full SHA) and enables it at project scope. Once per repository
and profile, after the Human has opened `claude` in the repository and trusted the folder, install it from the
repository root with `claude plugin install pstack@pstack-f713f14 --scope project`. Never at user scope: no install
without `--scope project` (or `--scope local`, which `packs/pstack/bin/lead` uses), and never the `--marketplace` form,
which declares the marketplace in the profile's user settings. A new pin is a new marketplace name, in a tier-3 pull
request per repository; attack 23 checks that two pins share one profile without clashing. Found on Claude Code 2.1.308,
2026-10-22 (`probes/results.md`, attack 23):

- The install fails with `Plugin "pstack" not found in marketplace` in a folder the profile has not trusted (logged-in
  writer profile, untrusted `case1/a`). The pstack pack's `packs/pstack/settings.json` is in the order the installer writes: uninstalling
  and installing again in `case2/a` on the same profile left `git status` empty (a first install on a new profile was
  not tried). An uninstall rewrites `enabledPlugins` to `{}`.
- 53 of 54 pstack skills carry `disable-model-invocation`, so the model's own Skill call is refused; `setup-pstack`
  does not. The agents `pstack:poteto-agent` and `pstack:comment-sicko` have no guard: a model may spawn them, and with
  poteto-agent poteto-mode's playbook, in a run nobody typed (#8 decides whether to forbid that).
- `claude -p "/pstack:poteto-mode …"` starts the skill; a prompt that only names it does not. So an unattended prompt
  starts a skill explicitly with `/pstack:<skill>` at its start; without that the run follows the repository's `AGENTS.md`
  and whatever the model spawns.
- Two pins under two marketplace names share one profile, each folder loading its own.

pstack is a Cursor plugin; in Claude Code its texts run, and these parts do not, so the factory does not use them:

- `/setup-pstack`: it writes `~/.cursor/rules/pstack-models.mdc`, a Cursor rule for the whole machine that Claude
  Code never loads. Every role keeps its default model.
- Autopilot's owners and swarm of verifiers: Cursor cloud agents. Shipping's one verifier per pull request is taken,
  on the Codex CLI instead (`packs/pstack/scripts/live-verify`, `packs/pstack/section.md`); its verdict is no gate
  input, so the gate's reviewer (`review`, `verdict`) stays the only judge the merge waits for.
- The transcript readers (recall, reflect, session pickup, eval, show-me-your-work's audit): they read
  `~/.cursor/projects/<slug>/agent-transcripts/`, where Claude Code writes nothing. Adapted, they would read the
  Human's own profile, which the kit's deny rules refuse.
- `cursor-team-kit`'s `deslop`, `control-ui` and `control-cli`: they ship in another Cursor plugin, not in pstack.
