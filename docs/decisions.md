# Decisions

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
  Fixes come from failures in real use; no probe programme runs, and no work stops at a usage % (29–31/10).
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
  (2026-11-02 20:16:33 +07, review 5737110797). Only he moves it, on his login, asked before each move: `bin/onboard-owner --merge`, which Colly runs; each move appears in Colly’s brief and wakes Colly.
  "Làm ngay trong release 1", "1–2 tự merge (Recommended)" and "Thử thật lúc team đang chạy
  (Recommended)" are his answers; the factory's own repository is unchanged. Sources:
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6568029635 (09:51 to about 10:00),
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6568380227 (10:11 and 10:21) and
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6569698590 (12:14:34).
- **agent-desk and Claude Code, 2026-10-21 and 2026-10-27.** agent-desk stays parked. Every lead, worker and reviewer
  of the factory's own team runs through Claude Code, apart from pstack's other-family steps, which D2 sends to Codex
  (the live verifier's entry below); another team may bring its own harness (#131). The instruction file is for any
  harness, and `ship` and the live verifier are the pstack team's, in `packs/pstack/` (#132). On 2026-11-05 (#375, 07:46
  +07, relayed by Colly and the factory-repo session) the Human allowed Peers to run on Codex (GPT-6 Astra) for parallel
  release-1 work, with each brief reviewed by the Lead. Sources: `1b319ee`;
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
- **Language, 2026-10-25 and 2026-11-04.** The workspace's code and docs are English; UI text depends on the project. His words,
  from the chat he relayed on #98: "Không dùng tiếng việt ở workspaces, chỉ giải thích tau bằng tiếng việt, thuật ngữ,
  code,status ... tiếng anh. Các repo trong workspace thì codebase này kia cũng tiếng anh theo chuẩn quốc tế, UI Text,...
  thì tuỳ vào dự án." A quote keeps his words. The one exception, from 2026-11-04: a tier-3 pull request's body opens with
  a short Vietnamese summary for him, `**Tóm tắt cho anh**` and its lines (Anh quyết, Đề xuất, Rủi ro), which is the
  repository's only Vietnamese. His "1. ok theo đề xuất." (about 12:05 +07, relayed by Colly) answers Colly's question:
  "(a) Tiếng Việt, 3 dòng như mẫu trên, thay khung tiếng Anh. Đây là ngoại lệ duy nhất của luật 'repo chỉ tiếng Anh',
  vì khung này chỉ để mày đọc." Then, the same day at 15:15 +07, relayed by Colly and the factory-repo session: "Đồng
  thời phần tóm tắt cho anh viết gọn TLTR kiểu đấy đi, có nên song ngữ không?" and "Song ngữ chỉ cho TLTR ấy"; and on
  INN-16 at 16:30:11 +07 (09:30:11Z): "theo đề xuất", his choice A. So the summary is two blocks, the Vietnamese one
  and, after it, `**TL;DR**` with the same lines in English (You decide, Recommendation, Risk), each line one
  sentence, the order the same as on an INN item; a fourth line, "Nếu không trả lời" / "If no answer", appears only
  when silence has a consequence. Only these two blocks are bilingual, and the Vietnamese block alone is the
  repository's Vietnamese.
  English is plain, and speaks in features rather than mechanics (31/10, 02/11).
  Sources: https://github.com/tuannd9288/factory/issues/98, https://github.com/tuannd9288/factory/issues/386 and
  https://github.com/tuannd9288/factory/issues/411.
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
  neither `ARCHITECTURE.md` nor `docs/` is required (K2; INN-23 A, 2026-11-04 23:37:50 +07, #422: a repository's product
  description is pstack's Feature Map, files in the repository, one short file per feature, from the user's side,
  updated in the same pull request as the code; flow diagrams are drawn only for a complex flow; Linear Documents hold
  only writing he reads; the rule reaches every repository in release 1 (#428), the Feature Map after it (#422)); the Gate block states the gate's obligations directly, and
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
  factory-repo session, #351 ("A trước đã") and #369 ("trả lời i–vi: theo đề xuất", his answer vi); and on 2026-11-03,
  relayed by Colly and the factory-repo session, #373, #374 and #352 ("Đồng thời cho xử lý luôn phần dùng Linear đi"); and
  on 2026-11-03, relayed by the factory-repo session, #370 ("trả lời i–vi: theo đề xuất", about 14:30 +07, whose (iii) is
  that the sweep wakes a Lead and the Lead keeps no watchers; and "A", about 23:15 +07, relayed by Colly: one sweep on each
  Mac, the local inbox-socket wake, the cloud station after release 1); and, relayed by Colly and the factory-repo
  session, #375 ("đề xuất 1: làm ngay sau #370", on 2026-11-03 about 23:00 +07, and "Chốt giải pháp B Linear, tập trung
  xử lý các việc để chạy trên Linear.", on 2026-11-04 at 14:16 +07) and #399 ("Về cái sweep thì triển khai luôn đi, chứ
  sao chờ?", on 2026-11-04 at 14:06 +07, 07:06:31Z: the sweep becomes a daemon, the piggery way). He parked #369 on
  2026-11-04 ("5 ok.", 14:47 +07). Relayed by Colly and the factory-repo session, #408 leaves the freeze with his words
  on the ADLC page, 2026-11-04 at 14:41 +07, 07:41:26Z: "Về ADLC thì tau thấy 1 và 2 có thể sau, 3 thì nên làm luôn
  trong bản 1? Mày thấy sao?" and Colly agreed. Items 1 and 2 (#371's probe, managed settings) stay in Triage; item 3
  is #408: a reviewer finding of one kind on two merged pull requests is listed in the weekly digest for an enforcer.
  Sources:
  https://github.com/tuannd9288/factory/issues/131#issuecomment-6460556380,
  https://github.com/tuannd9288/factory/issues/203#issuecomment-6561931880,
  https://github.com/tuannd9288/factory/issues/271, https://github.com/tuannd9288/factory/issues/286,
  https://github.com/tuannd9288/factory/issues/256#issuecomment-6567815272,
  https://github.com/tuannd9288/factory/issues/330#issuecomment-6567816736,
  https://github.com/tuannd9288/factory/issues/333#issuecomment-6568029635 and
  https://github.com/tuannd9288/factory/issues/335#issuecomment-6568390675 and
  https://github.com/tuannd9288/factory/issues/351#issuecomment-6594728569 and
  https://github.com/tuannd9288/factory/issues/369 and
  https://github.com/tuannd9288/factory/issues/373#issuecomment-6607020300 and
  https://github.com/tuannd9288/factory/issues/370#issuecomment-6609218324 (his "A") and
  https://github.com/tuannd9288/factory/issues/375 (its body and comments) and
  https://github.com/tuannd9288/factory/issues/399 (its body) and
  https://github.com/tuannd9288/factory/issues/408 (its body).
- **`gh api`, 2026-11-02.** Agents may use `gh api` to read. A write through it (changing settings, branch rules,
  variables, deleting) still needs his approval. Nothing in settings blocks it. The factory-repo session's reading of
  which is which: a read is a GET or a GraphQL query, and a REST read with parameters passes `-X GET`, since `-f` and
  `-F` turn a call into a POST; a write is a REST POST, PUT, PATCH or DELETE, or a GraphQL mutation. A seat stays denied
  every `gh` (`Bash(gh:*)` in `bin/lib/seat.mjs`), which is #343's open question 1. His words: "Nới: đọc tự do
  (Recommended)". Source: his answer 2026-11-02 15:09:43, relayed by the factory-repo session (#343).
- **Linear, 2026-11-03.** Linear is his own surface: he decides, takes notes and asks questions there. GitHub stays the
  record (1b) until the entry below, and his answers reach it as a comment on the issue that names the relay (#352),
  for a repository still on GitHub. Colly sets up Linear and its own Linear access; nothing in the factory reads Linear
  until #404, #405 and #407 land (the entry below). H9 holds for Linear (its entry below). The per-repository tracker
  switch his second quote asks for is #375, which the entry below decides. His words: "Ok. Dùng Linear" (about
  20:20 +07) and "Thay vì bỏ github hiện tại tại sao không thiết kế để có thể on/off Linear hoặc Github, kiểu nếu dùng
  github không dùng Linear cũng được, mà dùng Linear thì không cần Github. Đồng thời cho xử lý luôn phần dùng Linear đi."
  (about 21:45 +07). Source: https://github.com/tuannd9288/factory/issues/373#issuecomment-6607020300, relayed by
  Colly and the factory-repo session.
- **Linear, 2026-11-04.** He chose B: Linear is the tracker. For a repository on Linear, the issue, its status, its
  holder, its labels, its comments and his answers live in Linear, and his comment on the issue is the record, with no
  relay. "GitHub" in his words means GitHub Issues as the tracker only: code, pull requests, checks, the App's statuses,
  the merge and the claim ref stay on GitHub. The GitHub-Issues path is off by default, nothing new is built for it, and
  there is no per-repository switch. Once every repository the factory runs is on Linear, the last commit that has the
  path is tagged (as `before-271` was) and the path is cut in one pull request he approves. The order: the factory
  repository first, with 7 days of real use, then zalo-gateway, factory-probe and the scratch repositories. Nothing is
  deleted: open issues move to FAC, each with a "moved to FAC-n" line, and the closed GitHub issues stay as a read-only
  archive. #369 is parked, since Linear's Project page and Inbox replace it. The Lead's decisions: one Linear team for
  each repository, the factory's being `FAC` while `INN` stays his team for decisions (the reasons are in #375's body);
  and, while repositories move, one list names those on Linear, which only grows and which the cut removes: it is
  `$FACTORY_STATE/linear/repos.json`, written by `factory linear onboard`. None is on Linear yet; #406 adds the
  factory. Nothing in the factory reads Linear until #404, #405 and #407 land. FAC's labels and statuses are researched
  and proposed in #406, and nothing is created in Linear before his word. The credential rule for 1b and the one shared
  Factory app are decided in the entry below (#403). Waiting on him: how Linear's events reach the Macs (#375,
  decision 7: both research passes are done, and a recommendation goes to him). His words: "B theo đề xuất." (14:13
  +07); "Chốt giải pháp B Linear, tập trung xử lý các việc để chạy trên Linear. Còn
  Github thì off mặc định, chỉ khi nào cần thì phát triển tiếp hoặc mày xem đề xuất là tag cái phần github rồi gỡ hẵn
  chỉ dùng B Linear, khi nào cần xây lại github thì lấy lại nếu cần, để code gọn?" (14:16); "Ok, tag rồi gỡ" (14:28);
  "OK không xoá issue." (14:43); "5 ok." (14:47). Sources:
  https://github.com/tuannd9288/factory/issues/375 (its body and comments) and
  https://github.com/tuannd9288/factory/issues/402, relayed by Colly and the factory-repo session.
  Built work closes; where Linear now does a job, the code that did it is tagged and removed (04/11).
  Every Linear label has a written purpose (04/11).
- **The Factory app's Linear key, 2026-11-04.** The credential rule for sublayer 1b (#403): the factory's code reaches
  Linear only as its own app "Factory", never under his login, and the token store (`bin/lib/token.mjs`, #311's route)
  may hold the app's client id, its client secret and the access token minted from them, in `tokens/linear-app/`, and
  nothing else of Linear's. There is one shared app, and each team's writes show its own name (INN-13, "ok", 16:26:50
  +07, 09:26:50Z). His words on INN-14, relayed by Colly and the factory-repo session: "theo đề xuất" (16:27:24 +07,
  09:27:24Z). Source: https://github.com/tuannd9288/factory/issues/403 (its comment of 09:39:28Z).
- **Effectiveness, 2026-11-04.** The daemon of #399 is held to beat piggery. Its store was picked on effectiveness, and
  adding a technology did not count against the pick: SQLite through `node:sqlite`, with the measurements on #399. His
  words, relayed by Colly and the factory-repo session: "Đảm bảo bộ não thiết kế phải hoạt
  động tối ưu hơn piggery nha" (12:51 +07, 05:51:53Z), and, on the store, "Cái nào hiệu quả, quan trọng là hiệu quả, còn
  thêm công nghệ hay gì không quan trọng. Hiệu quả, tối ưu." (14:28 +07, 07:28:56Z). Source:
  https://github.com/tuannd9288/factory/issues/399.
  Data leaving the machine, needing a server or costing money is a warning, never a reason to reject; use what exists before building (21/10, 03/11).
- **The Watcher's freeze, 2026-11-07.** On INN-39 he ticked box 3, which read "3. Đóng băng Watcher (bộ đọc log cho
  Colly): không mở rộng thêm, cắt khi model đọc thẳng được (đề xuất)" (14:43:52 +07, 07:43:52Z). He then accepted the
  independent review's amendment, which replaces the box's end condition with "until the Human revisits its scope on
  evidence": "Theo đề xuất của mày và Advisor đi" (15:15:36 +07, 08:15:36Z). What holds: the Watcher's detector is
  frozen, its kinds (`KINDS` and `watch_fired` in `bin/lib/reader.mjs`) and its sides (`SIDES`, `bin/lib/reader.json`),
  until the Human revisits its scope on evidence. The Watcher stays on by default, as he decided on 2026-11-06. Its
  switch's own notice, `reader-off`, is outside the freeze. Sources: INN-39 for the box, and the supervising session's
  relay for 15:15:36.

