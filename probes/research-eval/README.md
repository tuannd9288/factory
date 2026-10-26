# The research eval (#92, sublayer 4b)

Do the research session's helper agents pay for themselves? Ten tasks over run folders already on disk, a grader that is
plain code, and a runner for two arms. Arm A is the researcher as it runs today. Arm B is the same brief and preset with the
helper tools denied (`bin/seat --deny Agent --deny Task --deny Workflow`).

| File | What it is |
|---|---|
| `tasks/*.json` | one task each: sources, the narrow folders a session may read (`readable`), 5 facts with a pattern, a citation pattern and the place each was read, and one question the disk cannot answer |
| `keys.mjs` | loads the tasks, checks their shape, re-reads every fact on disk (`verifyTask`), writes a task's brief |
| `grade.mjs` | scores a report against a key: one point for each fact, one for the line "says what it could not read" |
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

The probe is what fits in $24: the researcher runs on seat 2 only, which is shared with Kizuna labs. Its job is to prove the
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
  session, and refuses on any problem (exit 2).
- **A stuck session.** No record in 45 minutes is a stop (exit 5).

## What a session can read

Each session has a run folder of its own, `<runs folder>/re-<set>-<tag>/`, one level under the runs folder so that `bin/seat`
still counts it, holding only its brief and its own log; and an empty work folder of its own. It may read its task's
`readable` folders only, the narrowest that hold its sources, so the notes and reports of the run folders (which state answers)
are out of reach. For `round4-review` the readable folders are `issue-17/rev4` and `issue-17/w17`; `rev4` holds the review whose
text is the source of three facts (and its logs), so that task cannot be narrower. Both arms deny `Read` of
`probes/research-eval/` in the checkout.

Still open, and not closed by a deny rule: `ls ~/factory-runs` shows the names of the other sessions' folders, and
`git -C <checkout> show main:probes/research-eval/tasks/<task>.json` reads a key through git, as `AGENTS.md` records for seat 1.
A test with a fake claude shows that no folder a session may read holds another session's log or a task file.

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
