// The quota windows (#63, K2 option B): what Claude Code itself reports, and nothing else. Source 1 is the rate_limit_event of
// a stream-json log, source 3 the status line's rate_limits (probes/results.md, #62). Nothing here reads a credential, a
// profile or the network; a window that was not reported is null, never a guess.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One window as { use, resetsAt }, use a fraction 0 to 1; null when the report holds no number for it. */
const windowOf = (use, resetsAt) => (num(use) === null ? null : { use, resetsAt: num(resetsAt) });

/** The windows of a rate_limit_info (source 1: utilization is a fraction). A window is rejected only by `status`: the
 * recorded events carry overageStatus "rejected" while status is "allowed", and that is the extra usage, not the window. */
export function windowsOf(info) {
  const w = info?.unifiedWindows ?? {};
  return {
    five_hour: windowOf(w.five_hour?.utilization, w.five_hour?.resetsAt),
    seven_day: windowOf(w.seven_day?.utilization, w.seven_day?.resetsAt),
    status: info?.status ?? null,
    type: info?.rateLimitType ?? null,
    rejected: info?.status === 'rejected',
  };
}

/** The windows of one status-line record (source 3): used_percentage is a percentage by its name, so it is divided by 100.
 * Only 0 has been seen (#62), so that scale is not yet measured above 0. null for a record that has no rate_limits, as the
 * ones before the first API response do. */
export function statusLineWindows(record) {
  const r = record?.rate_limits;
  if (!r || typeof r !== 'object') return null;
  const pct = (w) => (num(w?.used_percentage) === null ? null : windowOf(w.used_percentage / 100, w.resets_at));
  return { five_hour: pct(r.five_hour), seven_day: pct(r.seven_day), status: null, type: null, rejected: false };
}
