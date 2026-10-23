// How long one reviewer call may run inside a job that GitHub stops at a fixed time. The job's own start and length come
// from the workflow (GATE_JOB_START, in epoch seconds, and GATE_JOB_MINUTES, its timeout-minutes); a margin is kept for what
// follows the call, and a call that cannot get a useful time is not made, so the reviewer reports `unavailable: timeout`
// itself instead of the job being stopped with no result at all.
//   callBudget(...)  { minutes, retry } or null: minutes is the call's time, retry whether a second call would still get
//                    the five minutes it needs; null when less than a minute is left. With no start, only the cap.

export function callBudget({ now = Math.floor(Date.now() / 1000), start, jobMinutes, marginMinutes = 5, capMinutes = 25 }) {
  if (!Number.isFinite(start) || !jobMinutes) return { minutes: capMinutes, retry: true };
  const left = (start + jobMinutes * 60 - marginMinutes * 60 - now) / 60;
  if (left < 1) return null;
  return { minutes: Math.min(capMinutes, left), retry: left >= 5 };
}
