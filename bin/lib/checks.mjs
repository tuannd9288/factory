// What counts as a failed check, in one place for the merge queue (bin/lib/queue.mjs: pickUpdate, pickReruns, switchDue) and the wake on a Lead's
// news (bin/lib/news-wake.mjs). A pull request is the queue's own shape: `checks` (Actions) and `apps` (another App's, like Entire Gates #155),
// each by name with a `state`.

/** The conclusions of an Actions check run that mean it failed. */
export const RED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/** Whether the required check `name` of `p` failed: an Actions check by its conclusion; another App's by anything but success while it is
 * done (Entire is neutral while it blocks). A check that is missing or still running has not failed. */
export function failedCheck(p, name) {
  if (p.checks[name]) return RED.has(p.checks[name].state);
  return Boolean(p.apps?.[name]) && !['SUCCESS', 'PENDING'].includes(p.apps[name].state);
}
