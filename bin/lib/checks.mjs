// What counts as a failed check, and which red tier the queue re-runs, in one place for the merge queue (bin/lib/queue.mjs: pickUpdate, switchDue) and the wake on a Lead's
// news (bin/lib/news-wake.mjs). A pull request is the queue's own shape: `checks` (Actions) and `apps` (another App's, like Entire Gates #155),
// each by name with a `state`.

/** The conclusions of an Actions check run that mean it failed. */
export const RED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

const ENTIRE = 'Entire Gates';

/** The tier jobs to re-run, alone, so no reviewer runs again for a click: a failed tier check on a pull request that
 * someone other than its author approved on the head commit after that check started, so an approval landing while
 * the job ran is not lost, or (#155) whose Entire Gates check, of an App other than Actions, concluded after it
 * started. The tier check itself decides whether the approver may approve, and what Entire's conclusion means; it
 * pins Entire's App, so a copy of that name only costs one re-run. */
export function pickReruns(prs) {
  return prs
    .filter((p) => RED.has(p.checks.tier?.state) && p.checks.tier.jobId)
    .filter(
      (p) =>
        p.approvals.some((a) => a.login !== p.author && a.oid === p.head && a.at > p.checks.tier.startedAt) ||
        (Boolean(p.apps?.[ENTIRE]?.completedAt) && p.apps[ENTIRE].completedAt > p.checks.tier.startedAt),
    )
    .map((p) => ({ number: p.number, jobId: p.checks.tier.jobId }));
}

/** Whether the required check `name` of `p` failed: an Actions check by its conclusion; another App's by anything but success while it is
 * done (Entire is neutral while it blocks). A check that is missing or still running has not failed. */
export function failedCheck(p, name) {
  if (p.checks[name]) return RED.has(p.checks[name].state);
  return Boolean(p.apps?.[name]) && !['SUCCESS', 'PENDING'].includes(p.apps[name].state);
}
