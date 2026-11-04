# The factory

This repository (`tuannd9288/factory`) is the root of the Human's software factory. On the Mac mini it is cloned
in the agents' own macOS account, `factory` (#24), as `~/WORKSPACES`; each repository in the factory is a subfolder
there, cloned from GitHub and ignored by this root's git. That account holds the agents' gh login (`tuan9288-agent`
alone), their profiles and their Herdr; the Human reaches it with `ssh factory@<the Mac mini>`. His own account keeps
his SSH keys and gh login behind its home, which is `drwx------` on the Mac mini. The clone is outside `~/Desktop`,
which macOS privacy controls (TCC) close to launchd jobs that were not granted access; not tested here. This file
covers the factory's rules and taking a repository in. Inside a repository, that repository's own `AGENTS.md` governs.

## Decisions

Each line below gives the Human's decisions on one matter, with their dates and sources, and says what holds now; the
lines run by the date each matter was first decided. A quote keeps his words and his language. A decision he later
replaced is no longer stated here; its source link stays, and git keeps the old line. The WORKSPACES map is
https://claude.ai/artifact/XAUqXMKx1vXJT5bKDGAY1x, which he settled on 2026-10-25, relayed by Colly.

- **Use what exists first, 2026-10-18.** Use a ready-made product first; build only when it falls short. Source:
  agent-desk issue #269, as the map's "Đã quyết" block records it.
- **First product repository, 2026-10-20.** It is not docparse or tuanhub-notifier: "đang ổn, không cần". Source:
  the live copy of the page "Môi trường repo cho agent", decision 3, as the map records it.
- **Merging, 2026-10-21 to 2026-11-02.** A reversible change in tier 1 or 2 merges by rule once the repository's
  gate is green on its head commit; the Human keeps tier 3, a change stuck after three rounds, and every deploy (K1,
  2026-10-21: "Triển khai theo đề xuất đi"). A pull request auto-merges once the four checks are green on its head
  commit, and tier 3 still waits for his approval (#203, which he approved "theo đề xuất" on 2026-10-30). Attack 12
  and the 20 seeded + 20 clean probes re-run when real use calls for them (#153; the Human, 2026-10-29: "ok, đưa về
  Triage, và theo dõi thực tế factory triển khai có hiệu quả hơn là đi xử lý cái vấn đề có thể không xảy ra không?").
  The pack's Lead arms auto-merge through `scripts/ship` (#163, #304). Sources:
  https://github.com/tuannd9288/factory/issues/203 (area 4) and https://github.com/tuannd9288/factory/issues/153; the
  bar of 2026-10-21 is `probes/plan.md` at the tag `before-271`. **The merge switch, 2026-11-02 (#333).** Each repository
  has a switch with three positions, "toàn bộ" (`all`: every pull request merges by itself once its checks are green,
  tier 3 included), "1–2" (tier 1 and 2 do, tier 3 waits for him) and "mọi PR chờ" (`none`: every pull request waits for
  him); a repository taken in starts at "1–2", and zalo-gateway keeps its present setting, GitHub's "Allow auto-merge"
  off, until he moves it. It is the two review parameters of the `factory-gate` ruleset ("Luật review của GitHub
  (Recommended)", 12:14:34), so GitHub holds it and a move applies at once to the open pull requests, which the queue
  follows by re-running a tier-3 `tier` whose recorded position and the one in force differ in a way that changes its
  verdict. At `all` the code also lets a `needs-human` pull request merge once its checks are green: his choice on #354
  (2026-11-02 20:16:33 +07, review 5737110797). Only he moves it, on his login, asked before each move: `bin/onboard-owner --merge`, which Colly runs; each move shows in `factory top` and wakes Colly.
  "Làm ngay trong release 1", "1–2 tự merge (Recommended)" and "Thử thật lúc team đang chạy
  (Recommended)" are his answers; the factory's own repository is unchanged. Sources:
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6568029635 (09:51 to about 10:00),
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6568380227 (10:11 and 10:21) and
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6569698590 (12:14:34).
- **agent-desk and Claude Code, 2026-10-21 and 2026-10-27.** agent-desk stays parked. Every lead, worker and reviewer
  of the factory's own team runs through Claude Code, apart from pstack's other-family steps, which D2 sends to Codex
  (the live verifier's entry below); another team may bring its own harness (#131). The instruction file is for any
  harness, and `ship` and the live verifier are the pstack team's, in `packs/pstack/` (#132). Sources: `1b319ee`;
  https://github.com/tuannd9288/factory/issues/131 (its body, Limits) and
  https://github.com/tuannd9288/factory/issues/132 (its body).
- **seatwork, 2026-10-21.** seatwork may be used freely, its code and its text alike. Source: the page "Factory của
  anh", p:372, as the map records it (the page's wording: "seatwork dùng thoải mái, cả mã lẫn chữ").
- **One thin core, a folder for each way of working, 2026-10-22 and 2026-10-27.** The core is the environment, the
  gate and the ledger. A way of working is a folder in `packs/` that a team copies into its repository; the kit lays
  none (#131, #132; 2026-10-27), and only the pstack pack is built now. There is no piggery pack (T1 off), OTel stays
  off (T2 off, as the map records it), and only the Human can bypass the tag ruleset. The Human agreed to all eight
  decisions on the 2026-10-22 page as it recommended them. Sources:
  https://github.com/tuannd9288/factory/issues/2#issuecomment-6337959043 (the page:
  https://github.com/tuannd9288/factory/issues/2#issuecomment-6336996220), and for 2026-10-27
  https://github.com/tuannd9288/factory/issues/131 (its body, Limits) and
  https://github.com/tuannd9288/factory/issues/132 (its body).
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
  Note (the Lead, 2026-11-01, #203): in the code that is one call per head commit, as H3 says; a push makes a new
  head, and each head gets its own call (`kit/.gate/bin/review`).
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
- **Control surfaces (#68), 2026-10-25 to 2026-10-31.** The factory runs on Ghostty and Herdr until it is finished,
  and Rex and Paseo are rolled out after that. His words to Colly in chat, relayed by Colly: "trước mắt cứ chạy với
  ghostty + herdr cho hoàn thành cái factory rồi triển khai rex và paseo" (2026-10-29), and "nếu đang bị mở rộng ra thì
  dừng lại, dùng Herdr TUI hoặc APP đã" (2026-10-31; the Lead's translation: "if it is widening, stop, and use Herdr's
  TUI or app for now"). Then K1 = C, which holds on his own check (still waiting on him): Rex replaces Ghostty, and
  Herdr for the interactive sessions on the MacBook, and Herdr keeps the factory's sessions on the Mac mini; if a
  Claude Code session at a permission prompt in an unfocused tab shows no blocked mark in the tab header and the
  session picker, K1 becomes B. K3: keep Paseo's usage plugin as it is. K2 = B: layer 1e and contract H9 are added.
  T3 = on (#78's body): Remote Control for Colly's and the Lead's interactive sessions, beside Paseo, following
  whichever account the session runs on. On 2026-10-26 the Human deferred it until he moves to an account that can use
  it: "Tài khoản này tau không dùng được /remote-control delay sau được không Hoặc tau chuyển tài khoản khác khi
  tiện?" (https://github.com/tuannd9288/factory/issues/78#issuecomment-6400797388). Sources:
  https://github.com/tuannd9288/factory/issues/68#issuecomment-6393212307 (K3),
  https://github.com/tuannd9288/factory/issues/68#issuecomment-6394536120 (K1, K2; T3 was pending there),
  https://github.com/tuannd9288/factory/issues/78 (T3 on) and
  https://github.com/tuannd9288/factory/issues/203#issuecomment-6560905773 (2026-10-29 and 2026-10-31).
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
  keeps a tail the repository owns, while `kit-update` keeps updating the kit's
  head, and the end of `.github/CODEOWNERS` follows. Sources:
  https://github.com/tuannd9288/factory/issues/71#issuecomment-6395151620 and
  https://github.com/tuannd9288/factory/issues/72#issuecomment-6395151814.
- **The order of the gaps, 2026-10-25.** "Theo thứ tự này (Recommended)": 0c (in progress), then 1b, then 3c, then 4a;
  0d follows #75 and #77; 2c comes last. Source: his answer in Colly's session, relayed by Colly, in the map's report
  §0 and https://github.com/tuannd9288/factory/issues/81.
- **The live verifier, 2026-10-25 and 2026-10-30.** The verifier stays (#25). He approved #182's D1 and D2 as
  proposed, "D1 và D2 theo đề xuất", relayed by Colly. D2, in Colly's words: "pstack's other-family steps run on Codex
  through a factory script on `codex exec`, like `scripts/live-verify`, on the verifier's Codex profile." So the
  verifier's steps run on its Codex profile; that step from D2 to the verifier is Colly's, in closing #95 as superseded,
  on the Human's approval of the cleanup that #203 records ("theo đề xuất", 2026-10-30). Sources:
  https://github.com/tuannd9288/factory/issues/182#issuecomment-6513127448,
  https://github.com/tuannd9288/factory/issues/95#issuecomment-6525022374,
  https://github.com/tuannd9288/factory/issues/203 (area 4), and for 2026-10-25
  https://github.com/tuannd9288/factory/issues/79#issuecomment-6398968431.
- **The instruction layer (#131, #132), 2026-10-27.** On #131: "Viết từ A (Recommended)"; that evening,
  "Ok, cho các đội triển khai đi, song song nếu được." ("Ok, let the teams carry it out, in parallel where possible",
  Colly's translation). On #132's instruction layer he answered the three questions of the decision page
  (https://claude.ai/artifact/SLNEk1B5nTict8swrmbBqD) with "Theo đề xuất của mày",
  and so took Colly's recommendations: the composed root `AGENTS.md` stays at most 150 lines and gains a 32 KiB cap (K1);
  neither `ARCHITECTURE.md` nor `docs/` is required (K2); the Gate block states the gate's obligations directly, and
  `CLAUDE.md` is `@AGENTS.md`, an addendum allowed, or a relative symlink to `AGENTS.md` (K3). He had asked for it after the
  review: "Cho Astra review lại rồi đề xuất cho đúng thiết kế". Its pack and harness parts are in the two entries of
  2026-10-21 and 2026-10-22 above. 2a and H4 stay as they are, and so does "Cho file một phần đuôi của repo
  (Recommended)" of 2026-10-25: the kit owns a smaller head, one marked `## Gate` block, and the repository owns the
  tail, with its own headings. Sources: https://github.com/tuannd9288/factory/issues/131#issuecomment-6436306027 (the
  choice of A), https://github.com/tuannd9288/factory/issues/131#issuecomment-6445068794 and
  https://github.com/tuannd9288/factory/issues/132#issuecomment-6445063962 (the questions and K1 to K3), and
  https://github.com/tuannd9288/factory/issues/131#issuecomment-6446708922 (the evening words), all relayed by Colly.
- **Scope freeze, 2026-10-28.** "Duyệt, đóng băng như đề xuất": until #131 closes, only its path is worked, and the
  issues it lists wait in Triage. An issue leaves the freeze only on his later words on it: #203 (its cleanup, approved
  "theo đề xuất" on 2026-10-30; and on 2026-11-02, "#203 sao không triển khai luôn?", relayed by Colly), #271 (his
  words of 2026-10-31 in its body), #286 (his words of 2026-11-01 in its body), and on 2026-11-02, relayed by the
  factory-repo session, #256 and #330 ("#256 lệnh kiểm (Recommended), #330 test chập chờn (Recommended)"), #333
  ("Làm ngay trong release 1") and #335 ("Vá ngay, trước công tắc (Recommended)"); and on 2026-11-03, relayed by the
  factory-repo session, #351 ("A trước đã"); and on 2026-11-03, relayed by Colly and the factory-repo session, #373, #374
  and #352 ("Đồng thời cho xử lý luôn phần dùng Linear đi"); and on 2026-11-03, relayed by the factory-repo session, #370
  ("trả lời i–vi: theo đề xuất", about 14:30 +07, whose (iii) is that the sweep wakes a Lead and the Lead keeps no watchers; and
  "A", about 23:15 +07, relayed by Colly: one sweep on each Mac, the local inbox-socket wake, the cloud station after release 1).
  Sources:
  https://github.com/tuannd9288/factory/issues/131#issuecomment-6460556380,
  https://github.com/tuannd9288/factory/issues/203#issuecomment-6561931880,
  https://github.com/tuannd9288/factory/issues/271, https://github.com/tuannd9288/factory/issues/286,
  https://github.com/tuannd9288/factory/issues/256#issuecomment-6567815272,
  https://github.com/tuannd9288/factory/issues/330#issuecomment-6567816736,
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6568029635 and
  https://github.com/tuannd9288/factory/issues/335#issuecomment-6568390675 and
  https://github.com/tuannd9288/factory/issues/351#issuecomment-6594728569 and
  https://github.com/tuannd9288/factory/issues/373#issuecomment-6607020300 and
  https://github.com/tuannd9288/factory/issues/370#issuecomment-6609218324 (his "A").
- **`gh api`, 2026-11-02.** Agents may use `gh api` to read. A write through it (changing settings, branch rules,
  variables, deleting) still needs his approval. Nothing in settings blocks it. The factory-repo session's reading of
  which is which: a read is a GET or a GraphQL query, and a REST read with parameters passes `-X GET`, since `-f` and
  `-F` turn a call into a POST; a write is a REST POST, PUT, PATCH or DELETE, or a GraphQL mutation. A seat stays denied
  every `gh` (`Bash(gh:*)` in `bin/lib/seat.mjs`), which is #343's open question 1. His words: "Nới: đọc tự do
  (Recommended)". Source: his answer 2026-11-02 15:09:43, relayed by the factory-repo session (#343).
- **Linear, 2026-11-03.** Linear is his own surface: he decides, takes notes and asks questions there. GitHub stays the
  record (1b), and his answers reach it as a comment on the issue that names the relay (#352). Colly sets up Linear and
  its own Linear access; nothing in the factory reads Linear. H9 holds for Linear (its entry below). The per-repository
  tracker switch his second quote asks for is #375, and nothing about it is decided. His words: "Ok. Dùng Linear" (about
  20:20 +07) and "Thay vì bỏ github hiện tại tại sao không thiết kế để có thể on/off Linear hoặc Github, kiểu nếu dùng
  github không dùng Linear cũng được, mà dùng Linear thì không cần Github. Đồng thời cho xử lý luôn phần dùng Linear đi."
  (about 21:45 +07). Source: https://github.com/tuannd9288/factory/issues/373#issuecomment-6607020300, relayed by
  Colly and the factory-repo session.

## Tiers

The change sets the tier, by the paths it touches (`.gate/bin/tier`), never the author.

| Tier | Trigger | Must be true to merge | The Human |
|---|---|---|---|
| 1 | no tier-2 or tier-3 path | `verify`, `review`, `verdict`, `tier` green on the head commit; `verdict` passes at once | none |
| 2 | a `.gate/load-bearing` path, a dependency manifest, a deleted test file, or an added proof for a dropped test (`gate-allow test-deleted:` or `gate-allow assertions-removed:`) | the same, with `verdict` judged by the reviewer | reads it in the weekly digest and on the deploy page |
| 3 | a path or `key` line in `.gate/protected` (the gate, `AGENTS.md`, `.claude/`, test and lint configuration), the label `needs-human`, the reviewer's raise (C3), or, where Entire reviews, a `No-red:` line | tier 2 and his approval of the head commit, or of one whose patch the head carries unchanged, which `tier` checks; unless the repository's merge switch is at `all` (#333) | approves from the summary |

A tier never drops within a pull request: every label `tier-N` or `needs-human` it ever had raises it, even once
removed.

Where a repository picks Entire as its reviewer (`GATE_REVIEWER: 'entire'` in `gate-trusted.yml`, #155), the required
checks are `verify`, `tier` and `Entire Gates`, set by `bin/onboard-owner`; `review` and `verdict` are not among them.

Agents open pull requests under their own GitHub account, never the Human's. GitHub refuses an author's approval of
his own pull request, and its code-owner rule asks nothing of an author who owns the code: on the scratch repository
a tier-3 pull request opened from the Human's account merged with no approval (2026-10-21). So the `tier` check
itself requires, on tier 3, an approval of the head commit by a code owner who is not the author, and while it waits for
that approval it requests the code owners' review on GitHub, so the pull request shows in their review queue (#374).

## What the Human keeps

- Tier 3 approvals, `needs-human` pull requests (stuck after three rounds), and every deploy. Where a repository's merge
  switch is at `all` (#333), a tier-3 pull request needs no approval of his (a `needs-human` one too, as the code does:
  his choice on #354, 2026-11-02 20:16:33 +07, review 5737110797); a deploy is still his.
- His one approval, per repository, of what `bin/onboard-owner` would change (the agents' account, rulesets, the
  `reviewer` environment, "Allow auto-merge"), which Colly then applies on his login; and the reviewer's secret, where a
  repository uses the kit's Claude reviewer.
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

- **0a Environment** [S2, OA1]: the `factory` account, `~/WORKSPACES`, the worktrees: under a repository's
  `.claude/worktrees/`, and a pack Lead's under `~/factory-runs/<repo>-<n>/w` (`packs/pstack/lead.md`).
- **0b Tools & permissions** [A5, A2]: the deny rules, the permission mode, the agents' `gh` login.
- **0c Model configuration** [MODELCFG]: which model a role runs on; one profile for each repository; the factory's
  own runs use one config folder per seat, `~/.agent-profiles/seats/<n>/claude`, which `bin/seat` picks, and the token
  of the team's account (#311).
- **0d Harness & session** [A2]: the loop that runs Claude Code: `bin/seat` for every unattended role, and
  `packs/pstack/bin/lead` for a team's Lead.
- **1a Issues** [GH2]: where work comes in: one issue labelled `task`.
- **1b System of record** [OA1, UAC]: where work is recorded: issues, pull requests, the ledger.
- **1c Orchestrator-workers** [A1]: a lead gives each task to a worker.
- **1d Monitoring** [GH1]: `bin/factory-queue`, `bin/factory-alerts`, `bin/factory top`, the ledger's canary.
- **1e Surfaces** [GH2, #68]: the Human's own screens: Ghostty with the Herdr TUI or app until the factory is finished, then
  Rex on the MacBook (K1 = C, pending his check) and Paseo's app (Control surfaces, in Decisions), and Remote Control (T3,
  pending); and, now, Linear, where he decides, takes notes and asks (Linear, in Decisions; #373). Herdr's server and
  Paseo's daemon stay in 0d.
- **2a Context** [SP2, OA1]: what a session reads: the repository's `AGENTS.md`, at most 150 lines and 32 KiB composed.
- **2b Skills & plugins** [A5]: the pack and its plugin (pstack), pinned for each repository, and the modules (#70) a
  repository lists in `.gate/modules`, each bringing its own skill.
- **2c Verification** [SP3]: what a worker runs before the pull request: `.gate/bin/verify --fast`, the tests of the part changed, `red-check`; the full suite runs on CI (#281).
- **3a Required status checks** [GH3]: `verify`, `review`, `verdict` and `tier`, green on the head commit; where Entire
  reviews, `verify`, `tier` and `Entire Gates` (#155).
- **3b Risk tiers** [A8]: tier 1, 2 or 3, set by the paths a change touches.
- **3c Merge & rollback** [A8]: a merge commit through auto-merge, the merge queue, a revert pull request.
- **4a Observability & cost** [SH, U1]: the ledger's cost for each task and the weekly digest.
- **4b Evals** [A8]: the pack's attacks (`packs/pstack/attacks.md`); the gate's attacks and the 20 seeded + 20 clean
  probes, at the tag `before-271`, which re-run when real use calls for them (#153).

A sublayer may change anything inside it while its contracts hold; a change to a contract is tier 3 (as is every change
here). A contract is named by its code. Its sentence states the factory's rule; the rule's source is the Human's
decisions (#58, #79, #68, #132) and the map. A "Prior art" line quotes an organization that does the same.

- **H1**: Work enters through one issue. Checked by: `tier` (`check` in `kit/.gate/bin/lib/claim.mjs`): the body names
  one open issue and its claim, or says `Issue: none` and closes no issue of the repository.
  Prior art [GH2]: "You can start work from the agents panel, a conversation, or an issue or pull request on GitHub.com."
- **H2**: Work leaves through one pull request that carries its evidence.
  Checked by: `tier` and `verify-trusted`, which read the body's `Issue:`, `Claim:` and `Team:` lines, and `review`,
  which reads the body; `kit/.github/pull_request_template.md` asks for the rest.
  Prior art [A8]: "Require CI, and add "Testing", "Risk" and "How to revert" to your PR template."
- **H3**: A verdict binds exactly one commit.
  Checked by: `kit/.gate/bin/lib/approval.mjs:1-10`, the row "Tier 3 lands only with the Human's approval of the head commit…" in `kit/.gate/enforced-rules.md`, `kit/.gate/bin/review:31` (one reviewer call per head).
  Prior art [A8]: "An approval covers one specific commit."
- **H4**: Knowledge is files in the repository, changed by pull request.
  Checked by: `kit/.gate/protected:14` (`AGENTS.md` is tier 3), `kit/.gate/bin/lib/instructions.mjs` (150 lines and 32 KiB, run by `verify` and, on the candidate's git objects, by `verify-trusted`).
  Prior art [OA1]: "Repository-local, versioned artifacts (e.g., code, markdown, schemas, executable plans) are all it can see."
- **H5**: A way of working is a folder in `packs/` that a team copies into its repository; the kit lays none (#132).
  Checked by: none yet; `packs/pstack/test/pstack.test.mjs` checks only the pack's pin.
  Prior art [SH]: "A profile is data: a system prompt, a set of skills, a set of extensions, a sandbox policy, model defaults."
- **H6**: Tools are commands; permissions live outside the instructions.
  Checked by: the deny rules `bin/seat` and `packs/pstack/bin/lead` give each session (`denyOf` in `bin/lib/seat.mjs`
  and in `packs/pstack/bin/lead.mjs`), and their tests; the kit's `kit/.claude/settings.json` binds Claude Code only (#134).
  Prior art [A5]: "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic and guarantee the action happens."
- **H7**: Model choice lives outside the way of working. Checked by: none yet (#62 and #63 do part of it).
  Prior art [SD3]: "The `model_stylesheet` graph attribute provides CSS-like rules for setting default LLM configuration on nodes."
- **H8**: An improvement comes back as ordinary work.
  Checked by: `.github/CODEOWNERS:4`.
  Prior art [F1]: "When patterns cross a threshold, it files Linear tickets automatically."
- **H9**: A surface is only a window. Five rules (#68; surfaces page §5.2): (1) a surface never starts or owns the
  factory's unattended sessions; 0d does; (2) the record of a task stays on GitHub (1b) and in 0d's panes, and a surface
  keeps no sole copy; (3) the factory's own code in this sublayer reads no credential (#58 K2; this binds the factory's
  code, not the Human's own tools, and K3 keeps Paseo's usage plugin as it is); (4) only a person answers a permission
  prompt, so agents do not type into another pane: the seats and the Lead are denied all of `herdr`, its
  `agent send-keys` and `pane send-keys` with it (`bin/lib/seat.mjs`, `packs/pstack/bin/lead.mjs`); the kit's deny
  rules bind Claude Code only and hold no such rule (#76, closed 2026-10-30); `rex` is denied nowhere yet (#267); (5)
  with every surface stopped, the factory still runs. It holds for Linear, his surface for deciding, notes and questions
  (#373): Linear starts none of the factory's sessions, and its coding sessions, Loops and "open in coding tool" stay
  off (1); it keeps no sole copy, and a decision of his counts once it is relayed to the GitHub issue (2); the factory's
  own code in this sublayer reads no Linear credential, whether a tracker may read Linear is #375's to settle, and
  Colly's own Linear access is Colly's, outside the factory's code (3).
  Checked by: none yet. The check will be a test that stops every surface process and shows that a
  `bin/factory-queue` sweep (the merge queue) and a `bin/seat` run on a fake `claude` still pass.
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
- The weekly digest is `bin/factory-ledger --post tuannd9288/better-factory --last-week`: it posts even when the canary
  (`--check`) finds a field missing or stale, saying so in one line. `--post` refuses a repository that is not
  `PRIVATE`, since the digest lists private repositories' tasks (#209). `bin/factory-ledger plist --daemon --repo
  owner/name...` prints its job, `io.github.tuannd9288.factory.digest`: Monday 09:00 on the Mac mini's clock, as the
  agents' account, for the 7 days that end the day before. The Human installs it with the queue's, with
  one `sudo install` for the two.
- Do not test the wording of a prompt, rule, template or skill; the rule lives in the prompt or AGENTS.md, and review
  reads it. A test that reads text stays only when a program in this repository reads those bytes: a parser, a hash a
  script compares, or a file `onboard` or `kit-update` writes (#112).
- The Human (2026-10-29, #171), to every reviewer: "Rate each bug from 1 to 10 on how often it would happen and how bad it
  would be. If the two scores multiplied are below 5, just file it as an issue and leave the code alone." To every writer:
  "Do not design for rare or future cases nobody asked about." Claude Code reads this file in a project with no
  `CLAUDE.md`, as every factory worktree is. The kit's Gate block holds both; its reviewer reports such a bug in
  `forIssue`, which never blocks, and the Lead files the issue.
- The factory's own Lead on the MacBook starts with `factory lead factory --here`, reads and writes GitHub with `factory gh`
  (on the Mac mini, under the agents' login), and pushes from the factory host; its commits carry the agents' name. The
  Human's own `gh` login there is not touched: the factory-repo session uses it to approve for him (#349; the Human,
  2026-11-02 19:38:59, relayed by the factory-repo session: "1,2,4 theo đề xuất"). The pack's Lead on the Mac mini is not changed.

| Path | What it is |
|---|---|
| `kit/` | The core every repository receives through one pull request when it joins: gate, hooks, templates, deny rules, and the Gate block (`kit/.gate/gate-section.md`) that `bin/onboard` puts into the repository's own `AGENTS.md` |
| `packs/` | A way of working, one folder each (`packs/pstack/`), that a team copies into its repository: scripts, `.gate/driver.json`, the pin, the prose for its `AGENTS.md` (`section.md`, its sources in `yields.md`), rows for `.gate/enforced-rules.md`, `INSTALL.md`, NOTICE, tests and attacks, the Human's `skills/repo-refresh/`; nothing composes it; `packs/pstack/bin/` and `lead.md` stay in the factory and are not copied |
| `modules/` | What only a repository that turns it on receives, one folder each (`modules/deletion-proof/`): `kit/` at repository paths (its skill included), `test/`; `bin/lib/module.mjs`, `bin/onboard --module`, `bin/kit-update --module` / `--no-module` |
| `bin/onboard-owner` | The admin step of taking a repository in (account, rulesets, `reviewer` environment), which Colly runs on the Human's login after his one approval |
| `bin/onboard` | Clone, profile, kit, verify, the kit pull request |
| `bin/onboard-doctor` | Reads one repository taken in and prints one line per check, green or red, and changes nothing; Colly runs it on the Human's login, from a commit on `main`; the "Take <repo> in" issue closes on its output |
| `bin/kit-update` | The onboarded repository's counterpart of onboard: brings its clone up to a factory commit, with evidence, in a pull request from `factory/kit-<sha7>` |
| `bin/kit-evidence` | Proves the kit pull request's files are the kit at one factory commit, by git object |
| `bin/rulesets/` | The rulesets `bin/onboard-owner` sets besides the kit's gate |
| `bin/factory-ledger` | The ledger (one row per task) and the weekly digest; `--check` is its canary on Claude Code's session format; the header says what it charges a task from |
| `bin/factory` | The one command for the Human's agent accounts (`factory` on his PATH): the table of profiles, accounts and quota, and `login`, `store`, `use` and `logout`, which only the Human runs (#177, #178); its header has the rest |
| `bin/factory top` | The read-only view of every session and repository (#174, #286); the header of `bin/lib/top.mjs` has the rest |
| `bin/factory lead` | `factory lead <repo> [--team <name>] [--new] [--dry-run]` (#166, #196): starts the pstack Lead of one team of a repository, resuming that team's newest earlier session; the headers of `bin/factory` and `packs/pstack/bin/lead` have the rest. `factory lead <repo> [--team <name>] --here [-- <claude arguments>]` (#349) is the MacBook's own Lead, with no `gh` login and no git credential of the Human's; a push to GitHub over HTTPS fails, and git over ssh is off |
| `bin/factory gh` | `factory gh <gh arguments>` (#349): on the MacBook, `gh` on the Mac mini under the agents' login, by ssh; on the Mac mini, `gh` itself; the header of `bin/factory` says what it refuses |
| `bin/install-factory` | The Human's step that puts `factory` on the PATH from each machine's installed copy of the factory (#390): `$FACTORY_CHECKOUT`, `~/WORKSPACES` on the Mac mini, `${XDG_DATA_HOME:-~/.local/share}/factory/checkout` on the MacBook (`installedRoot`), outside the folders macOS refuses a launchd job and never set by a dev clone's branch or edits, which change nothing that runs. Run from a clone that is not that copy, it clones the copy (main only, an empty `credential.helper`) or brings it to `origin/main` by `followMain`'s rules, then runs the copy's own `bin/install-factory`, which makes `~/.local/bin/factory` a symlink to the copy's `bin/factory` and replaces only a symlink whose target ends in `/bin/factory`; on the MacBook it also writes the relay's LaunchAgent, loads it anew and runs `bin/factory-relay check`. His one line after a change here is `~/.local/share/factory/checkout/bin/install-factory` when the copy exists, else `bin/install-factory` from any clone; it can be run again |
| `bin/factory-queue` | The merge queue: updates one auto-merge PR at a time when `main` moves, and re-runs the tier check after the Human approves |
| `bin/lib/wake.mjs` | The wake line and its post to a Lead's inbox socket (#351); `factory wake` and the sweep use it |
| `bin/lib/comment-wake.mjs` | The sweep's wake on new comments (#351): the added fields of the queue's query, the cursor, the `comment` event |
| `bin/factory-events` | What the sweep tells Colly (#309): the `start` lines of `$FACTORY_STATE/events.jsonl` after its cursor; `--follow` moves the cursor and follows the file; the header has the ssh command |
| `bin/factory-relay` | The MacBook's relay of a Lead's news (#370): `run` is one pass that reads the Mac mini's news lines by ssh and posts those it could not deliver into the socket file of the Lead that runs there; `plist` prints its LaunchAgent (his own user, every 60 s), which runs from the installed copy, since macOS refuses a launchd job `~/Desktop`, `~/Documents` and `~/Downloads`; each `run` pass first brings that copy to `origin/main`, as the Mac mini's sweep does for `~/WORKSPACES`; `check` fails when a path of the job or of the installed plist sits under those folders or the loaded job's last exit code is not 0, says, in the job's environment, whether ssh and the read of the news work, sets the first cursor and relays nothing; the header of `bin/lib/relay.mjs` has the rest |
| `bin/factory-reader` | The stream reader's pass (#339): `bin/factory-reader` reads what the Leads and the seats wrote since the last pass and tells Colly, through the events file, what code cannot see; `--try <file> [--side pi\|codex]` sends one stream file once and prints the answer and the quote check, writing nothing; the sweep starts a pass every 15 minutes |
| `bin/lib/reader.mjs` | The reader's code: the reduction to the assistant's text and the tool names, the two commands, the cursors, the quote check; the header has the rest |
| `bin/lib/reader.json` | The reader's setting, changed by pull request: the side (`pi` with Antigravity, or `codex`) and, for each side, its model and effort |
| `bin/lib/streams.mjs` | Finds the two kinds of stream the reader reads, a seat's `run-<tag>.jsonl` and a Lead's `transcripts/<session>.jsonl` |
| `bin/lib/redact.mjs` | The one redaction: the events' patterns (#309) and seatwork's, used by `bin/lib/events.mjs` and the reader |
| `bin/brief-check` | Compares a brief with the relay it came from, with no model call: every double-quoted span of the relay must be in the brief's own body, above the attached message; `bin/brief-template.md` is the brief's seven fields and that attachment |
| `scripts/verify` | This repository's own checks: the kit's tests in `test/*.test.mjs`, each pack's in `packs/*/test/`, and the budget of the kit's Gate block (26 lines, 3072 bytes), which leaves every repository room under the 150 lines and 32 KiB of its composed `AGENTS.md` |
| `test/` | The kit's tests; each check is shown failing on a bad input. The parked probe programme and `factory-sublayers` are at the tag `before-271` (#153, #271) |
| `NOTICE` | What was taken from other projects, with the commit |

## Taking a repository in

Six steps, run by Colly and a team:

1. The Human says "take <repo> in". Colly opens the issue "Take <repo> in"; its acceptance is the lines
   `bin/onboard-doctor` prints.
2. Colly runs `bin/onboard-owner` without `--apply`, from the factory's clone on the MacBook, on the Human's `gh`
   login, and sends him the changes it prints. He approves once; Colly runs it with `--apply`. For a private
   repository, Colly also takes the runner's registration token (the Human's standing exception, 2026-10-29), never
   printed. The agents' account accepts the invitation itself. The gate's settings (the reviewer and three runners)
   are no repository variables, which change without a pull request: `bin/onboard` fills them into the kit's
   workflows in step 3, from the options the issue names, and a later change is a pull request (#335).
3. A team claims the issue and runs `bin/onboard <repo-url>` with the settings the issue names (`--reviewer`, and
   `--runner`, `--pr-runner`, `--trusted-runner` off GitHub-hosted Ubuntu). The kit pull request carries its evidence
   (`bin/kit-evidence`), whose `settings` lines name all four. Until `main` holds the kit, its `verify` is red (code
   127), and the bootstrap rule requires no check (`bin/onboard`'s own note in the kit pull request body). He
   approves it as tier 3 from its "Summary for the Human" (`kit/.github/pull_request_template.md`).
4. When it merges, Colly runs `--apply` the second time (`factory-gate` in, `factory-bootstrap` out). The Human's
   approval of the kit pull request covers it. The merge queue then sweeps the repository with nothing more from
   him, and no `sudo` install for each new repository (#211). The queue job's one install is his, together with the
   other daemons after #203 (#209).
5. The team sweeps the repository (#20) with the Human's `repo-refresh` skill (#19) in audit mode, then opens one
   pull request per area through the gate.
6. When `bin/onboard-doctor` prints every line green, Colly closes the issue.

His part is the two approvals, and pasting the reviewer's secret where the repository uses the kit's Claude reviewer;
Entire needs none (#155).

What step 2 sets and reads back is in the header of `bin/onboard-owner`; what step 3 does, file by file, is in the header of
`bin/onboard`. Use `bin/onboard` once, for a repository that has no kit yet, and `bin/kit-update` for every later move of an
onboarded repository to a newer factory commit; its refusals, what it replaces and the gate's judgment of its pull request are in
the header of `bin/kit-update`.

Then the repository's session fills `.gate/config.sh` (test command, fast checks, its own checks with proofs),
and proposes `.gate/load-bearing`. The Human logs into the profile in a new pane opened in the repository
(`echo $CLAUDE_CONFIG_DIR`, then `claude`).

The queue's job, its install, its lock and its checkout rules are in `bin/factory-queue`'s header. A rollback is a revert pull
request through the gate. Only when the gate itself is broken does the Human turn the ruleset off, after taking auto-merge off
every open pull request, since with the ruleset off each would land unjudged. The queue leaves a tier-3 pull request behind
`main` until the Human approved it, then updates it once; his approval holds on the updated head, whose patch is unchanged
(`git patch-id`), so he is asked once. `tuannd9288/factory` itself is not swept; its Lead merges `main` into a branch that fell
behind. GitHub kept the Human's approval of #323 through such a merge, whose patch was unchanged (2026-11-02, head `7d7c78f`).

Claude Code updates itself on the stable channel; nothing in the factory pins the version its sessions run (the canary,
#24, is at the tag `before-271`). The gate's reviewer on CI pins its own, 2.1.308
(`kit/.gate/bin/reviewer/package.json`, `kit/.gate/bin/lib/reviewer.json`). The digest's job is in `bin/factory-ledger`'s header,
and the alerts hook's in `bin/factory-alerts`'s.

The queue's sweep also writes `$FACTORY_STATE/events.jsonl` (#309): one line when one of six conditions begins (a required check
that never started, something that waits on the Human, a Lead at a dialog, an account out of quota, the sweep's own `gh` refused,
a repository's merge switch moved)
and one when it ends. Colly wakes only on a `start` line, from `bin/factory-events --follow` over ssh; its header has the command,
and `bin/lib/events.mjs` the conditions. Without `--follow` it only looks; to look, use `factory top`. When the Monitor ends, Colly
starts it again with `--after <the last seq Colly saw>`; a new session, which knows no seq, leaves `--after` out. The sweep also writes
a one-time `comment` start line, like the reader's and no condition, when it wakes a Lead (#351); six more kinds of the same sort tell a
Lead's news (#370, `bin/lib/news-wake.mjs`): `seat-ended`, `seat-no-result`, `checks-red`, `checks-green`, `conflict` and `merged`, each
waking the Lead of its seat or pull request on this host (Colly's Monitor leaves them out; `bin/factory-events --news` prints only them),
and a `check-not-started` start wakes that pull request's Lead as well. The sweep reads every repository that has a team row for these
wakes alone, the factory's own too (its Lead is `factory-<team>`, found by the pull request's `Team:` line). A news line carries its Lead and
the delivery as data (`lead`, `woke`, `why`); the MacBook's relay (`bin/factory-relay`, a LaunchAgent under his own user, run from the MacBook's
installed copy, which each of its passes first brings to `origin/main`; #390) reads them by ssh and delivers the news to the Leads that run there,
those the Mac mini could not wake for want of a live Lead.

A message for a Lead is a comment on its issue, then `factory wake <repo> --team <team> --issue <n>`: one line into the Lead's Claude
Code inbox socket, which says to re-read the issue and carries nothing else. Nobody types into a pane (H9 rule 4). The Lead's hook records
the socket's path at every start (`packs/pstack/bin/transcript-copy.mjs`; `bin/lib/socket-hook.mjs` for `factory lead factory --here`),
never the token. The sweep does the same for a new comment, by a login other than its own, on an issue whose claim is held
(`bin/lib/comment-wake.mjs`, with no `gh` call of its own unless the claim refs it reads, the first 100, miss the holder). Known limit: `tuannd9288/factory` is not swept, so only `factory wake` reaches its own Lead.

The live verifier's Codex profile and its login are in `packs/pstack/INSTALL.md`, "The live verifier's login". What unattended runs
need, and how `bin/seat` picks the team, the account and the seat, sets the permission mode and the grants, and handles the
researcher and its known limits, are in the header of `bin/seat`. The worker's and the reviewer's Bash runs in Claude Code's
sandbox, which denies reading the credential folders, allows no network and allows writes to the work folder, the run folder,
the temporary folder, each `--add-dir` and Claude Code's own session temporary folder (#183).

What a session may read under a profile is nothing: the deny list holds `Read(~/.agent-profiles/**)` whole (#185). Claude
Code caches a plugin under the profile's `CLAUDE_CONFIG_DIR`, so the cache is moved out: each profile has its own plugin
root, `~/.local/share/factory/plugins/<path of the profile's config dir under ~/.agent-profiles>`, mode 700, which
`bin/seat` and `packs/pstack/bin/lead` set as `CLAUDE_CODE_PLUGIN_CACHE_DIR`. Both install the work folder's enabled
plugins into it before the session (`bin/lib/plugins.mjs`), through a throwaway config folder of their own under
`~/.local/share/factory/plugin-install/`, so no profile's folder is touched. The marketplace comes only from the
factory's own pin, `packs/pstack/settings.json` of the checkout that runs, never from the work folder, which may be a
candidate branch and would otherwise re-point the root every later session on the profile shares. The work folder decides
only whether to install: its `.claude/settings.json` must enable the pin's `pstack@<name>` and no other plugin, and declare
no marketplace but the pin, with the pin's own source; anything else (an older pin included: take the kit update), a
name that is not plain letters, digits, dot, dash and underscore, stops the start before any folder is made or any `claude`
call is run, and so does a failed install. A session reads its own earlier transcripts from copies outside every profile: a
seat's `run-<tag>.jsonl` in its run folder, and a Lead's `~/factory-runs/<repo>-<team>/transcripts/`, which a Stop and
SessionEnd hook of the launcher (`packs/pstack/bin/transcript-copy.mjs`) fills with the one transcript its input names.
The hook runs it with the `node` that `PATH` names when `lead` starts (`/opt/homebrew/bin/node`, a link `brew upgrade`
keeps, not its Cellar path), and `lead` refuses to start with none. Only the Lead reads those copies: every seat role is
denied `Read(~/factory-runs/*/transcripts/**)` (only a Lead's folder has a `transcripts/`).

A pack is a folder a team copies; the kit lays none (#132). What `packs/pstack/` holds and how it is copied are at the opening of
`packs/pstack/INSTALL.md`. The pstack Lead's start (`factory lead <repo>`), its resume and `--dry-run`, its login and the Herdr notes
are in the header of `packs/pstack/bin/lead`.

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

The pstack pin, its install per repository, what was found on Claude Code 2.1.308 and the parts of pstack the factory does not
use are in `packs/pstack/INSTALL.md`.
