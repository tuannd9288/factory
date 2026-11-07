# The factory

This repository (`tuannd9288/factory`) is the root of the Human's software factory. On the Mac mini it is cloned
in the agents' own macOS account, `factory` (#24), as `~/WORKSPACES`; each repository in the factory is a subfolder
there, cloned from GitHub and ignored by this root's git. That account holds the agents' gh login (`tuan9288-agent`
alone), their profiles and their Herdr; the Human reaches it with `ssh factory@<the Mac mini>`. His own account keeps
his SSH keys and gh login behind its home, which is `drwx------` on the Mac mini. The clone is outside `~/Desktop`,
which macOS privacy controls (TCC) close to launchd jobs that were not granted access; not tested here. This file
covers the factory's rules and taking a repository in. Inside a repository, that repository's own `AGENTS.md` governs.

## Rules for building the factory

His standing rules for building the factory, approved on INN-24 (A, 2026-11-05 13:52:46 +07); they are not copied into the kit or a pack.

- **Snags.** At a snag, a bug or a security finding, a reviewer FAIL included, do what a reference system does about it; if none has it, record it in Triage with the reason and park it (31/10, 01/11, 05/11).
- **Reference systems,** each at its pin, with a local copy under `data_mirror/data/repos/`: piggery `67c083e`, agent-orchestrator `9dc1c14`, pstack `4dd1d05` (`cursor-plugins`, the pin in `packs/pstack/settings.json`), zeroshot `0ad6653`, pi-herdsman `f2064d9`, dsh-superagent-prototype `8c32a9d`, paperclip `01d9a12`, warp-factory-examples `84e7c95`, seatworks `4c35563` (`seatworks-v3`), paseo-slp `a75c4db`, and Demonthorn's SLP articles; a system is added when he names one (05/11).
- **Default to pstack and SLP.** Where the factory differs, the difference is a switch whose default is pstack's way; it deviates only on his dated word (13/10, 16/10, 05/11).
- **Where the references agree.** Before proposing a switch, compare the reference systems: where only the factory differs and they all agree, take the common way with no switch, tagging the factory's divergent code and removing it; where only pstack differs, keep the common way; where they split, a switch whose default is pstack's way (05/11). A reference with no rule on the point does not count; where only pstack has a rule and it follows a public standard, take pstack's way (INN-29, 05/11).
- **Goals.** Every proposal names the goal it serves; review is the last layer (19/10, 21/10).
- **Exception lists.** A check that needs a list of exceptions is dropped and left to review (25/10).
- **No pauses.** Research, or a choice waiting on him, never pauses other work (31/10).
- **Every repository.** A feature is built for every repository the factory serves, not only the factory repository (31/10).
- **His choices.** Language, framework, database, hosting and large designs are his; agents propose (23/10).
- **His questions** test a proposal; they are not orders, and they do not reject it (30/10, 04/11).
- **Linear's own features** are used; one is dropped only with a recorded reason (03/11).
- **Licences.** Never ask him about a licence (30/10).
- **Installing.** A tool is installed the way its sibling tools are installed (02/11).
- Fixes come from failures in real use; no probe programme runs, and no work stops at a usage % (29–31/10).
- Built work closes; where Linear now does a job, the code that did it is tagged and removed (04/11).
- Every Linear label has a written purpose (04/11).
- Data leaving the machine, needing a server or costing money is a warning, never a reason to reject; use what exists before building (21/10, 03/11).
- English is plain, and speaks in features rather than mechanics (31/10, 02/11).
- A repository's product description is pstack's Feature Map, files in the repository, one short file per feature, from the user's side, updated in the same pull request as the code; flow diagrams are drawn only for a complex flow; Linear Documents hold only writing he reads; the rule reaches every repository in release 1 (#428), the Feature Map after it (#422) (INN-23 A, 2026-11-04 23:37:50 +07).

## Decisions

The Human's dated decisions, with their sources and his words, are in `docs/decisions.md`; read it before a change that touches one.

- **Use what exists first, 2026-10-18.**
- **First product repository, 2026-10-20.**
- **Merging, 2026-10-21 to 2026-11-02.**
- **agent-desk and Claude Code, 2026-10-21 and 2026-10-27.**
- **seatwork, 2026-10-21.**
- **One thin core, a folder for each way of working, 2026-10-22 and 2026-10-27.**
- **Cleanup of unused code, 2026-10-22.**
- **The agents' macOS account, 2026-10-23.**
- **Feature flags, 2026-10-24.**
- **The gate's reviewer, 2026-10-24.**
- **Colly's scope, 2026-10-24.**
- **Connection over custom, 2026-10-24.**
- **Three new sources (#58), 2026-10-25.**
- **Language, 2026-10-25 and 2026-11-04.**
- **Control surfaces (#68), 2026-10-25 to 2026-10-31.**
- **Evidence for a deletion-only pull request (#70), 2026-10-25.**
- **The module and the protected tail (#71, #72), 2026-10-25.**
- **The order of the gaps, 2026-10-25.**
- **The live verifier, 2026-10-25 and 2026-10-30.**
- **The instruction layer (#131, #132), 2026-10-27.**
- **Scope freeze, 2026-10-28.**
- **`gh api`, 2026-11-02.**
- **Linear, 2026-11-03.**
- **Linear, 2026-11-04.**
- **The Factory app's Linear key, 2026-11-04.**
- **Effectiveness, 2026-11-04.**

## Tiers

The change sets the tier, by the paths it touches (`.gate/bin/tier`), never the author.

| Tier | Trigger | Must be true to merge | The Human |
|---|---|---|---|
| 1 | no tier-2 or tier-3 path | `verify`, `review`, `verdict`, `tier` green on the head commit; `verdict` passes at once | none |
| 2 | a `.gate/load-bearing` path, a dependency manifest, a deleted test file, or an added proof for a dropped test (`gate-allow test-deleted:` or `gate-allow assertions-removed:`) | the same, with `verdict` judged by the reviewer | reads it in the weekly digest and on the deploy page |
| 3 | a path or `key` line in `.gate/protected` (the gate, `AGENTS.md`, `.claude/`, test and lint configuration), the label `needs-human`, the reviewer's raise (C3), or, where Entire reviews, a `No-red:` line | tier 2 and his approval of the head commit, or of one whose patch the head carries unchanged, which `tier` checks; unless the repository's merge switch is at `all` (#333) | approves from the Vietnamese summary |

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
  `reviewer` environment, "Allow auto-merge", the Actions event policy for `pull_request_target`), which Colly then
  applies on his login; and the reviewer's secret, where a repository uses the kit's Claude reviewer.
- Logging into the verifier's Codex profile. An agent never logs in or switches accounts.

Everything else that can be undone, agents decide and report after.

## Layers, sublayers and contracts

The map the Human settled on 2026-10-25: five layers, 17 sublayers, nine contracts. "Layer" and
"sublayer" come from IEEE 802.3, 4.1.1 [IEEE], read in the draft amendment P802.3as/D0.1 (March 2005):
"The LLC sublayer and the MAC sublayer together are intended to have the same function as that described in the OSI model for the Data Link Layer alone."
Each name carries a source key; the keys, with their URLs and how fully each was read, are in
https://github.com/tuannd9288/factory/issues/80#issuecomment-6399460150. Every issue and proposal names its sublayer.
Names are standard terms, never coined ones (25/10).

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
- **1b System of record** [OA1, UAC]: where work is recorded: issues, pull requests, the ledger. For a repository on
  Linear its issues are in Linear (Linear, 2026-11-04, in Decisions).
- **1c Orchestrator-workers** [A1]: a lead gives each task to a worker.
- **1d Monitoring** [GH1]: `bin/factory-queue`, `bin/factory top`, the ledger's canary.
- **1e Surfaces** [GH2, #68]: the Human's own screens: Ghostty with the Herdr TUI or app until the factory is finished, then
  Rex on the MacBook (K1 = C, pending his check) and Paseo's app (Control surfaces, in Decisions), and Remote Control (T3,
  pending); and, now, Linear, where he decides, takes notes and asks (Linear, in Decisions; #373), which for a
  repository on Linear is also that repository's record, in 1b. Herdr's server and Paseo's daemon stay in 0d.
- **2a Context** [SP2, OA1]: what a session reads: the repository's `AGENTS.md`, at most 150 lines and 32 KiB composed.
- **2b Skills & plugins** [A5]: the pack and its plugin (pstack), pinned for each repository, and the modules (#70) a
  repository lists in `.gate/modules`, each bringing its own skill.
- **2c Verification** [SP3]: what a worker runs before the pull request: `.gate/bin/verify --fast`, the tests of the part changed, `red-check`; the full suite runs on CI (#281).
- **3a Required status checks** [GH3]: `verify`, `review`, `verdict` and `tier`, green on the head commit; where Entire
  reviews, `verify`, `tier` and `Entire Gates` (#155).
- **3b Risk tiers** [A8]: tier 1, 2 or 3, set by the paths a change touches.
- **3c Merge & rollback** [A8]: a merge commit through auto-merge, the merge queue, a revert pull request.
- **4a Observability & cost** [SH, U1]: the ledger's cost for each task and the weekly digest.
- **4b Evals** [A8]: the pack's and the gate's attacks and the 20 seeded + 20 clean probes, at the tag `before-271`,
  which re-run when real use calls for them (#153); no probe programme runs (29–31/10).

A sublayer may change anything inside it while its contracts hold; a change to a contract is tier 3 (as is every change
here). A contract is named by its code. Its sentence states the factory's rule; the rule's source is the Human's
decisions (#58, #79, #68, #132) and the map. A "Prior art" line quotes an organization that does the same.

- **H1**: Work enters through one issue in the repository's tracker, Linear for a repository on Linear. Checked by:
  `tier` (`check` in `kit/.gate/bin/lib/claim.mjs`): the body names one open issue and its claim, or says `Issue: none`
  and closes no issue of the repository. It reads the issue on GitHub today; #407 makes it read Linear.
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
  factory's unattended sessions; 0d does; (2) the record of a task is in its repository's tracker (1b) and in 0d's
  panes, and a surface keeps no sole copy; (3) the factory's own code in this sublayer reads no credential (#58 K2;
  this binds the factory's code, not the Human's own tools, and K3 keeps Paseo's usage plugin as it is);
  (4) only a person answers a permission
  prompt, so agents do not type into another pane: the seats and the Lead are denied all of `herdr`, its
  `agent send-keys` and `pane send-keys` with it (`bin/lib/seat.mjs`, `packs/pstack/bin/lead.mjs`); the kit's deny
  rules bind Claude Code only and hold no such rule (#76, closed 2026-10-30); `rex` is denied nowhere yet (#267); (5)
  with every surface stopped, the factory still runs. For a repository on Linear, Linear is its 1b and not only a
  surface: with Linear down, that repository's issues cannot be read and a gated repository's `tier` cannot pass
  (#407). As his surface for deciding, notes and questions (#373), Linear starts none of the factory's sessions, and
  its coding sessions, Loops and "open in coding tool" stay off (1); his comment on a Linear issue is the record, with
  no relay, and for a repository still on GitHub a decision of his counts once it is relayed to the GitHub issue (2);
  Colly's own Linear access is Colly's, outside the factory's code, and the credential rule for 1b is in Decisions ("The
  Factory app's Linear key"): the factory's code reads Linear only through its own app, never under his login (3).
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
- The Lead keeps each of the Human's decisions on the issue, with its date and where he gave it. A brief is one direct
  order in the fields of `bin/brief-template.md` and quotes no one above its sender (#482, #486).
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
  under the agents' login and pushes, on the Mac mini, or on the MacBook itself once his `factory store` has put the agents'
  GitHub token there (#366); its commits carry the agents' name. The
  Human's own `gh` login there is not touched: the factory-repo session uses it to approve for him (#349; the Human,
  2026-11-02 19:38:59, relayed by the factory-repo session: "1,2,4 theo đề xuất"). The pack's Lead on the Mac mini is not changed.
- Every pull request of this repository waits on the Human, through `CODEOWNERS` `* @tuannd9288`, so each opens its body
  with the kit template's `**Tóm tắt cho anh**` block, in Vietnamese (Language, in Decisions), then its `**TL;DR**`
  block, the same lines in English; they are his only section, and the agents' detail is collapsed below them (#386,
  #411). Its title carries no issue number, which stays in the body.

| Path | What it is |
|---|---|
| `kit/` | The core every repository receives through one pull request when it joins: gate, hooks, templates, deny rules, and the Gate block (`kit/.gate/gate-section.md`) that `bin/onboard` puts into the repository's own `AGENTS.md` |
| `packs/` | A way of working, one folder each (`packs/pstack/`), that a team copies into its repository: scripts, the pin, the prose for its `AGENTS.md` (`section.md`, its sources in `yields.md`), rows for `.gate/enforced-rules.md`, `INSTALL.md`, NOTICE, tests, the Human's `skills/repo-refresh/`; nothing composes it; `packs/pstack/bin/` and `lead.md` stay in the factory and are not copied |
| `modules/` | What only a repository that turns it on receives, one folder each (`modules/deletion-proof/`): `kit/` at repository paths (its skill included), `test/`; `bin/lib/module.mjs`, `bin/onboard --module`, `bin/kit-update --module` / `--no-module` |
| `bin/onboard-owner` | The admin step of taking a repository in (account, rulesets, `reviewer` environment, Actions event policy), which Colly runs on the Human's login after his one approval; on the factory's own repository it sets the Actions event policy alone (#337) |
| `bin/onboard` | Clone, profile, kit, verify, the kit pull request |
| `bin/onboard-doctor` | Reads one repository taken in and prints one line per check, green or red, and changes nothing; Colly runs it on the Human's login, from a commit on `main`; the "Take <repo> in" issue closes on its output |
| `bin/kit-update` | The onboarded repository's counterpart of onboard: brings its clone up to a factory commit, with evidence, in a pull request from `factory/kit-<sha7>` |
| `bin/kit-evidence` | Proves the kit pull request's files are the kit at one factory commit, by git object |
| `bin/rulesets/` | The rulesets `bin/onboard-owner` sets besides the kit's gate |
| `bin/factory-ledger` | The ledger (one row per task) and the weekly digest; `--check` is its canary on Claude Code's session format; the header says what it charges a task from; for a repository on Linear (#406) a task is a team issue that left Triage, joined to its pull requests by `Issue: <KEY>` |
| `bin/factory-move` | `bin/factory-move <owner>/<repo> --team-key <KEY> --board <owner>/<number> [--apply] [--limit N] [--project <name> --in-project <n>,…]` (#406): moves a repository's open GitHub issues to its Linear team, once, as the Factory app; a dry run prints the plan, `--apply` writes, a map file lets a second run resume, and each GitHub issue gets "Moved to <KEY>" and is closed as not planned, never deleted; not a `factory linear` verb; the header of `bin/lib/move.mjs` has the rest |
| `bin/factory` | The one command for the Human's agent accounts (`factory` on his PATH): the table of profiles, accounts and quota, and `login`, `store`, `use` and `logout`, which only the Human runs (#177, #178); its header has the rest |
| `bin/factory top` | The read-only view of every session and repository (#174, #286); the header of `bin/lib/top.mjs` has the rest |
| `bin/factory lead` | `factory lead <repo> [--team <name>] [--new] [--dry-run]` (#166, #196): starts the pstack Lead of one team of a repository, resuming that team's newest earlier session; the headers of `bin/factory` and `packs/pstack/bin/lead` have the rest. `factory lead <repo> [--team <name>] --here [-- <claude arguments>]` (#349) is the MacBook's own Lead, with no `gh` login and no git credential of the Human's; with no agents' GitHub token on the MacBook a push to GitHub fails and git over ssh is off, and with one stored by his `factory store` the push runs on the MacBook itself (#366) |
| `bin/factory gh` | `factory gh <gh arguments>` (#349): on the MacBook, `gh` under the agents' login, on the Mac mini by ssh, or on the MacBook itself once his `factory store` has put the agents' GitHub token there (#366); on the Mac mini, `gh` itself; the header of `bin/factory` says what it refuses |
| `bin/factory linear` | `factory linear <verb>` (#404): a Lead's steps on a repository on Linear, as the Factory app: `take`, `release`, `accept`, `decline`, `duplicate`, `read`, `list`, `comment`, `ask`, `answered`, `create` and `onboard`, one JSON object out; on the MacBook it runs on the Mac mini by ssh, a body on stdin; `onboard` makes the repository's team (copied from FAC) and its Needs Human status and records it in `$FACTORY_STATE/linear/repos.json`, which `bin/lib/linear-repos.mjs` reads and which picks the Linear form of `packs/pstack/lead.md`; the header of `bin/lib/linear-cli.mjs` has the rest |
| `bin/install-factory` | The Human's step that puts `factory` on the PATH from each machine's installed copy of the factory (#390): `$FACTORY_CHECKOUT`, `~/WORKSPACES` on the Mac mini, `${XDG_DATA_HOME:-~/.local/share}/factory/checkout` on the MacBook (`installedRoot`), outside the folders macOS refuses a launchd job and never set by a dev clone's branch or edits, which change nothing that runs. Run from a clone that is not that copy, it clones the copy (main only, an empty `credential.helper`) or brings it to `origin/main` by `followMain`'s rules, then runs the copy's own `bin/install-factory`, which makes `~/.local/bin/factory` a symlink to the copy's `bin/factory` and replaces only a symlink whose target ends in `/bin/factory`; on the MacBook, run as its `factory` user, it also runs the checks of the relay's and the queue's LaunchDaemons, writes their plists and prints the one `sudo` line that installs them (#366). His one line after a change here is `~/.local/share/factory/checkout/bin/install-factory` when the copy exists, else `bin/install-factory` from any clone; it can be run again |
| `bin/factory-view` | The read-only data of `factory top`'s state as JSON, the view model alone (#369); a page will read it, and the page and its hosting wait for the Human's choice; the header says what it holds |
| `bin/factory-queue` | The merge queue: updates one auto-merge PR at a time when `main` moves, and re-runs the tier check after the Human approves. Its job's command, `sweep` with no repository, starts the daemon when nobody answers; `sweep --once` and `sweep --repo` run one pass in-process (#399) |
| `bin/factory-daemon` | The daemon (#399): runs the queue's pass every 60 s in a worker thread and takes a seat's end from `bin/seat` at once, on `$FACTORY_STATE/daemon.sock`, with its store at `factory.db` (`bin/lib/store.mjs`); only the 60 s job starts it, and the header of `bin/lib/daemon.mjs` has the design and the difference from piggery. It lives on a lease from the job's pings: `launchctl bootout` of the job stops it within about three minutes; to stop it at once, or before re-installing a changed plist, check that the pid in `$FACTORY_STATE/daemon.lock` is the daemon (`ps -p <pid> -o command=` ends in `bin/lib/daemon.mjs`; a stale lock can name a reused pid), then send it SIGTERM |
| `bin/lib/linear.mjs` | The only code that talks to Linear's API, as the Factory app (#403): one token source in `tokens/linear-app/` (client id and secret, the minted token with its expiry), minted under a lock with one fixed set of scopes and renewed 7 days ahead by the daemon's pass; an authentication failure re-reads, mints once and then raises `linear-auth-failed` (a request sends three times and mints twice at most), and any success clears it; writes pass `createAsUser`; `factory login linear-app client-id\|client-secret` stores the credentials; the header has the rest |
| `bin/lib/wake.mjs` | The wake line and its post to a Lead's inbox socket (#351); `factory wake` and the sweep use it |
| `bin/lib/comment-wake.mjs` | The sweep's wake on new comments (#351): the added fields of the queue's query, the cursor, the `comment` event |
| `bin/factory-events` | What the sweep tells Colly (#309): the `start` lines of `$FACTORY_STATE/events.jsonl` after its cursor; `--follow` moves the cursor and follows the file; the header has the ssh command |
| `bin/factory-relay` | The MacBook's relay of a Lead's news (#370): `run` is one pass that reads the Mac mini's news lines by ssh and posts those it could not deliver into the socket file of the Lead that runs there; `plist` prints its LaunchDaemon (the MacBook's `factory` user, every 60 s, with nobody logged in), which runs from the installed copy, since macOS refuses a launchd job `~/Desktop`, `~/Documents` and `~/Downloads`; each `run` pass first brings that copy to `origin/main`, as the Mac mini's sweep does for `~/WORKSPACES`; `check` fails when a path of the job or of the installed plist sits under those folders or the loaded job's last exit code is not 0, says, in the job's environment, whether ssh and the read of the news work, sets the first cursor and relays nothing; the header of `bin/lib/relay.mjs` has the rest |
| `bin/factory-reader` | The stream reader's pass (#339): `bin/factory-reader` reads what the Leads and the seats wrote since the last pass and tells Colly, through the events file, what code cannot see (a seat's `StructuredOutput` report included); `--try <file> [--side pi\|codex]` sends one stream file once and prints the answer and the quote check, writing nothing; the sweep starts a pass every 15 minutes |
| `bin/lib/reader.mjs` | The reader's code: the reduction to the assistant's text, the tool names and a seat's `StructuredOutput` report, the two commands, the cursors, the quote check; the header has the rest |
| `bin/lib/reader.json` | The reader's setting, changed by pull request: the side (`pi` with Antigravity, or `codex`) and, for each side, its model and effort |
| `bin/lib/streams.mjs` | Finds the two kinds of stream the reader reads, a seat's `run-<tag>.jsonl` and a Lead's `transcripts/<session>.jsonl` |
| `bin/lib/redact.mjs` | The one redaction: the events' patterns (#309) and seatwork's, used by `bin/lib/events.mjs` and the reader |
| `bin/brief-template.md` | A brief's six fields: what to build, why, the constraints checked, the assumptions open, what was decided, and what the receiver may challenge |
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
   approves it as tier 3 from its "Tóm tắt cho anh" (`kit/.github/pull_request_template.md`).
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
and proposes `.gate/load-bearing`.

The queue's job, its install, its lock and its checkout rules are in `bin/factory-queue`'s header. A rollback is a revert pull
request through the gate. Only when the gate itself is broken does the Human turn the ruleset off, after taking auto-merge off
every open pull request, since with the ruleset off each would land unjudged. The queue leaves a tier-3 pull request behind
`main` until the Human approved it, then updates it once; his approval holds on the updated head, whose patch is unchanged
(`git patch-id`), so he is asked once. `tuannd9288/factory` itself is not swept; its Lead merges `main` into a branch that fell
behind. GitHub kept the Human's approval of #323 through such a merge, whose patch was unchanged (2026-11-02, head `7d7c78f`).

Claude Code updates itself on the stable channel; nothing in the factory pins the version its sessions run (the canary,
#24, is at the tag `before-271`). The gate's reviewer on CI pins its own, 2.1.308
(`kit/.gate/bin/reviewer/package.json`, `kit/.gate/bin/lib/reviewer.json`). The digest's job is in `bin/factory-ledger`'s header.

The queue's sweep also writes `$FACTORY_STATE/events.jsonl` (#309): one line when one of eight conditions begins (a required check
that never started, something that waits on the Human, a Lead at a dialog, an account out of quota, an account Claude Code warns is
near its limit, the sweep's own `gh` refused,
a repository's merge switch moved, the Factory app's Linear token refused, raised by `bin/lib/linear.mjs`)
and one when it ends. Colly wakes only on a `start` line, from `bin/factory-events --follow` over ssh; its header has the command,
and `bin/lib/events.mjs` the conditions. Without `--follow` it only looks; to look, use `factory top`. When the Monitor ends, Colly
starts it again with `--after <the last seq Colly saw>`; a new session, which knows no seq, leaves `--after` out. The sweep also writes
a one-time `comment` start line, like the reader's and no condition, when it wakes a Lead (#351); six more kinds of the same sort tell a
Lead's news (#370, `bin/lib/news-wake.mjs`): `seat-ended`, `seat-no-result`, `checks-red`, `checks-green`, `conflict` and `merged`, each
waking the Lead of its seat or pull request on this host (Colly's Monitor leaves them out; `bin/factory-events --news` prints only them),
and a `check-not-started` start wakes that pull request's Lead as well. The sweep reads every repository that has a team row for these
wakes alone, the factory's own too (its Lead is `factory-<team>`, found by the pull request's `Team:` line). A news line carries its Lead and
the delivery as data (`lead`, `woke`, `why`); the MacBook's relay (`bin/factory-relay`, a LaunchDaemon of its `factory` user, run from the MacBook's
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
