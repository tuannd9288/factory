# The research eval (#92, sublayer 4b)

Do the research session's helper agents pay for themselves? Ten tasks over run folders already on disk, a grader that is
plain code, and a runner for two arms. Arm A is the researcher as it runs today. Arm B is the same brief and preset with the
helper tools denied (`bin/seat --deny Agent --deny Task --deny Workflow`).

| File | What it is |
|---|---|
| `tasks/*.json` | one task each: sources, the narrow folders a session may read (`readable`), 5 facts with a pattern, a citation pattern and the place each was read, and one question the disk cannot answer |
| `keys.mjs` | loads the tasks, checks their shape, re-reads every fact on disk (`verifyTask`), writes a task's brief |
| `grade.mjs` | scores a report against a key: one point for each fact, one for the line "says what it could not read" |
| `paths.mjs` | the path check: which paths in a session's log lie outside the folders it was given |
| `run.mjs` | the runner |

## What the eval does not show

- **The web.** Both arms deny `WebFetch` and `WebSearch`. This departs from #92's "A, as today", which has the web. It keeps the
  helpers the only difference, keeps the unanswerable question (stars, downloads, open issues) unanswerable, and keeps the keys
  stable. The cost: the 13 helpers of #58, #68, #68b and #70 mostly worked on the web, and this eval measures helpers on
  research over files on disk. A null result here says nothing about helpers in web research. The runner prints this note with
  its results and keeps it in `research-eval-<set>.json`.
- **The mix.** 7 of the 10 tasks are narrow lookups (a commit, a version, a `file:line`). Helpers have little room on them, which
  biases the eval against the helpers. Known limit; it is raised again when the Human weighs the 40 runs.
- **The turn limit.** A session has 80 turns, not the 300 of today's research. A helper's turns do not count against its
  parent's. The runner prints how each run ended, so that `error_max_turns` reads as a cut and not as a low score.

## Commands

Re-read every key on disk (no session, no credit):

    node --input-type=module -e "import {loadTasks,verifyTask} from './probes/research-eval/keys.mjs'; for (const t of loadTasks()) console.log(t.id, JSON.stringify(verifyTask(t, process.env.HOME + '/factory-runs')))"

Print the plan, starting nothing (`--run` is where the results go and `--work` the folder under which each session's empty work
folder is made; neither may hold the factory checkout, a task key or another session's log):

    node probes/research-eval/run.mjs --set probe --run <results folder> --work <work folder>

Start the probe:

    node probes/research-eval/run.mjs --set probe --run <results folder> --work <work folder> --go

The probe is what fits in $24: the researcher runs on seat 2 only, never on seat 1, which holds a token. Its job is to prove the
harness and to measure what one session costs, not to compare the arms. With the researcher preset's $15 budget the ceiling
below lets a second session start only when the first cost $9 or less, so expect one A/B pair at most. A larger probe, and the
40-run set (10 tasks, both arms, 2 runs: `--set full --go --limit-usd <dollars>`), are for the Human to fund once he has the
measured cost of a session.

## Limits and stops

- **The limit is a ceiling.** The default is $24. A session counts at `PRESETS.researcher.budget` (`bin/lib/seat.mjs`) until it
  ends, and none starts when the spend so far plus that budget would pass the limit (exit 3). The $15 is the preset's request to
  claude (`--max-budget-usd`), not a proven limit on a subscription seat (`bin/lib/seat.mjs:36-37`). A session whose result has no
  cost counts at that budget too.
- **Arm B must be without helpers.** The runner stops (exit 4) when a B session has no init event, lists a helper tool, started a
  helper, or has an event with a `parent_tool_use_id`. Arm A counts `Workflow` calls among its helpers.
- **One model.** The runner keeps each run's model and stops (exit 6) when it changes within a set.
- **Keys first.** With `--go` it checks the shape of every task of the set and re-reads every fact on disk before it starts a
  session, and refuses on any problem (exit 2). `--skip-key-check` is for the tests, which hold none of the sources; the runner
  then prints "keys not checked" and records `keyCheck: false` in `research-eval-<set>.json`.
- **The grader's hedges.** An answer scores nothing when it holds "or", a question mark, a word of doubt (`maybe`, `probably`,
  `likely`, `possibly`, `perhaps`, `think`, `guess`, `between`, `either`, and `about` before a figure), or, for a fact with one value
  (a hash, a date, a version, a count), a second value of the same shape joined to another by a list mark (`,`, `/`, a dash,
  brackets, "to", "and", "or"); a year that begins a date is no count. A fact whose right answer holds an "or" gives that phrase as `orIsAnswer`,
  and only the phrase is let through. Known limit: a number written in words ("two from 355029d") fails `round4-review` F5, and a
  figure in words passes the unreadable question's check. A second value joined by `;`, `|`, `&` or "vs" still scores, and a hedge
  after the dash, in the answer's citation, is not looked for.
- **A stuck session.** No record in 45 minutes is a stop (exit 5).

## What a session can read

Each session has a run folder of its own, `<runs folder>/re-<set>-<tag>/`, one level under the runs folder so that `bin/seat`
still counts it, holding only its brief and its own log; and an empty work folder of its own. It may read its task's
`readable` folders only, the narrowest that hold its sources, so the notes and reports of the run folders (which state answers)
are out of reach. For `round4-review` the readable folders are `issue-17/rev4` and `issue-17/w17`; `rev4` holds the review whose
text is the source of three facts (and its logs), so that task cannot be narrower. Both arms deny `Read` of
`probes/research-eval/` in the checkout.

The runner does not prevent a session from reading outside these folders: the researcher preset grants plain `Read`, `Grep` and
`Glob`, which allow every path, and an enumerated deny list would leave open whatever it does not name. It detects it after each
run and refuses to score that run (`paths.mjs`):

- **What it reads.** The session's own `run-<tag>.jsonl`, before the report is graded. Every path in every tool input: the
  `file_path`, `path` and `notebook_path` fields; a `pattern` or `glob` that is absolute or holds `..`; and, in a `command`, every
  word that is absolute, starts with `~` or holds `..`. `Write` and `Edit` are included, since a note left outside the folders
  is how one arm could reach the other. A call that Claude Code refused never ran: the CLI lists it in the result event's
  `permission_denials` by its `tool_use_id`, and the check leaves it out. A log with no result event keeps every call. The
  probe's first two runs (2026-10-26) were invalid only on refused calls.
- **One allow rule for a shell command: a word is placeable only when it is plain text.** The `command` is read quote by quote.
  Single-quoted text is literal and is checked as written. A word whose unquoted part holds any shell expansion cannot be
  placed, so it counts as outside: a `$` in any form (`$VAR`, `${…}`, `$(…)`, `$'…'`, `$"…"`), a backslash, a brace, or a
  backtick. Double-quoted text is read as the shell reads it: only a `$` or a backtick there makes the word unplaceable; a
  backslash escapes only `$`, a backtick, `"`, `\` and a newline, and braces and other backslashes are text, so
  `grep -n "a\|b"` is plain (the probe's first run, 2026-10-26, was invalid on such a regex until this reading). A bare `cd` and `cd -` are outside too, since the next relative path cannot be placed. The cost is
  accepted: an unquoted regex with a backslash, or an inline script with braces, makes the run invalid and prints its path. The
  words split on whitespace and on `; | & < >` outside quotes.
- **How it places a path.** A relative path resolves against the session's work folder, `~` is `HOME`, `..` is normalised, and when
  the path exists its symlinks are resolved, so a link inside a readable folder that leads out counts as outside. A glob is placed
  at the folder before its first wildcard (a glob is not one of the expansions above, and its matches are not followed, so a
  match that is a link leading out is not seen). `/dev/null` is not counted.
- **Inside** is under the session's run folder, its work folder or one of its task's `readable` folders. The readable folders
  count as inside because the runner gives them to the session for its task. A path it cannot place (`$HOME/x`, a command
  substitution, `/**`) counts as outside, and so does a session with no log.
- **What follows.** An invalid run is not scored. It is listed with each outside path in what the runner prints and in `results`
  of `research-eval-<set>.json` (`invalid`), and the other arm's run of the same task and repetition is not compared with it, so
  a pair with an invalid arm gives no comparison. Its cost and tokens still count.
- **What it does not do.** It is evidence of where a session read, not a sandbox: it prevents nothing, and no reader of a shell
  command is complete. It sees only the paths the log shows, and a command built only to evade it can still pass (a known
  limit, not a finding to fix): `git show main:probes/research-eval/tasks/<task>.json` names no path outside the folders. It may
  flag a read that is legitimate, such as a file that Claude Code itself saves under the profile for a long tool result, or a `Grep` regex that starts with `/`
  or holds `..` (`pattern` is read as a path for `Grep` as for `Glob`; 1 of 714 `Grep` calls in the old logs). A relative word
  that neither starts with `/` or `~` nor holds `..` is not collected, so after a `cd` into a readable folder a relative path
  through a link that leads out is not seen. Inside double quotes the shell drops a backslash-newline, and the check keeps the
  newline, so `cat "\<newline>/etc/hosts"` is not collected; only a command built to evade reaches it.
- **The guard.** Before any session starts, with or without `--go`, the runner refuses the set (exit 7, naming the task and the
  folder) when a task's readable folder is, holds or sits in a run or work folder of the plan, a `probes/research-eval/tasks`
  folder (this checkout's, `~/WORKSPACES`'s or `issue-92/w92`'s), `issue-92` (the reports), or is or holds the runs folder itself,
  after `..` and symlinks are resolved, so that "inside" can never reach an answer.
- **The stop.** The first invalid run stops the set (exit 8, which no other stop uses): the runner starts no further session,
  prints the tag and each outside path, and still writes `research-eval-<set>.json` for the runs so far, the invalid one listed.
- **If a probe run is flagged,** that is the dated failure that justifies a fail-closed eval preset in `bin/seat`, as its own
  issue (Colly, 2026-10-26).

A test with a fake claude shows each case: a path inside, another session's log, a `~` path, a `..` out of the work folder, a link
inside a readable folder that leads out, and `$HOME/x`.

## The decision rule

Written before the full set runs, and not to be changed by what the numbers turn out to be. The first three bullets are #92's;
the rest are the worker's additions (the Lead's review may change them), and change no keep-or-drop outcome.

- Keep the helpers only if arm B scores lower: the mean score of arm B's 20 runs below arm A's 20.
- Read every task that flipped before deciding. A mean can hide one task that fell.
- Compare cost and wall time as well: the cost and the minutes of a run in A against one in B, both printed by the runner.
- Worker's addition: a task flips when its mean points differ between the arms by a point or more (the runner prints the list).
- Worker's addition: this rule sets no margin. When B scores lower, the Human weighs the gain against the cost. If B scores the
  same or higher, the helpers did not pay for themselves on these tasks.
- Worker's addition: the probe decides nothing. It shows that the runner works, what a run costs, the estimate for the full set,
  and whether arm A used helpers at all (`helpers` above 0). If A's runs used none, the comparison is empty and the Lead
  reports that before any more spend.
