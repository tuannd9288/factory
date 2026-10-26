# The research eval (#92, sublayer 4b)

Do the research session's helper agents pay for themselves? Ten tasks over run folders already on disk, a grader that is
plain code, and a runner for two arms. Arm A is the researcher as it runs today. Arm B is the same brief and preset with the
Agent tool denied (`bin/seat --deny Agent --deny Task`). Both arms deny `WebFetch` and `WebSearch`: the tasks are answered
from disk, and a fetched page could answer what the disk cannot.

| File | What it is |
|---|---|
| `tasks/*.json` | one task each: sources, 5 facts with a pattern, a citation pattern and the place each was read, and one question the disk cannot answer |
| `keys.mjs` | loads the tasks, checks their shape, re-reads every fact on disk (`verifyTask`), writes a task's brief |
| `grade.mjs` | scores a report against a key: one point for each fact, one for the line "says what it could not read" |
| `run.mjs` | the runner |

## Commands

Re-read every key on disk (no session, no credit):

    node --input-type=module -e "import {loadTasks,verifyTask} from './probes/research-eval/keys.mjs'; for (const t of loadTasks()) console.log(t.id, JSON.stringify(verifyTask(t, process.env.HOME + '/factory-runs')))"

Print the plan, starting nothing:

    node probes/research-eval/run.mjs --set probe --run <run folder> --work <work folder>

Start the probe (2 tasks, both arms, 1 run: four sessions on the researcher's seat, one at a time):

    node probes/research-eval/run.mjs --set probe --run <run folder> --work <work folder> --go

The full set (10 tasks, both arms, 2 runs: 40 sessions) needs `--set full --go --limit-usd <dollars>`. The probe's limit is
$24 and stops it after the run that takes the spend past it. A session is capped at $15 by the preset, so the spend can pass
the limit by at most one session. The runner also stops, with exit 4, when an arm B session still has the Agent tool.

## The decision rule

Written before the full set runs, and not to be changed by what the numbers turn out to be.

- Keep the helpers only if arm B scores lower: the mean score of arm B's 20 runs below arm A's 20.
- Read every task that flipped before deciding. A task flips when its mean points differ between the arms by a point or more
  (the runner prints the list). A mean can hide one task that fell.
- Compare cost and wall time as well: the cost and the minutes of a run in A against one in B, both printed by the runner.
  This rule sets no margin. When B scores lower, the Human weighs the gain against the cost.
- If B scores the same or higher, the helpers did not pay for themselves on these tasks.
- The probe decides nothing. It shows that the runner works, what a run costs, the estimate for the full set, and whether
  arm A used helpers at all (`helpers` above 0). If A's runs used none, the comparison is empty and the Lead reports that
  before any more spend.
