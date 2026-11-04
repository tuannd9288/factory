// The view model of the overview (#369): what `factory top` knows, as plain data a page can read once the Human picks where it lives.
// viewOf(snapshot) is a pure function and knows no host. The view model is all that leaves the machine, so it holds no process command
// line, pid, environment, token path or home path, and an account by its letter alone. Every string is stripped of control characters, a
// home path in one is cut to `~`, and a URL is kept only if it points to https://github.com/.
import { age, issueStateOf, local, waitsOf } from './top.mjs';

const tidy = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\/Users\/[^/\s]+/g, '~');
const tidyDeep = (v) => (typeof v === 'string' ? tidy(v) : Array.isArray(v) ? v.map(tidyDeep) : v && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidyDeep(x)])) : v);
const ghUrl = (url) => (/^https:\/\/github\.com\/[\w./#-]*$/.test(url ?? '') ? url : '');

const TONES = ['you', 'bad', 'work', 'idle', 'done'];

const windowOf = (w, now) => (w ? { percent: Math.round(w.use * 1000) / 10, resets: w.resetsAt == null ? null : w.resetsAt * 1000 <= now ? 'reset since' : local(w.resetsAt * 1000, now) } : null);

/** The view model of one snapshot, as plain data (JSON-safe). */
export function viewOf(input) {
  const snap = { ...input, sessions: tidyDeep(input.sessions), repos: tidyDeep(input.repos), queue: tidyDeep(input.queue), events: tidyDeep(input.events ?? []) };
  const { now, sessions, queue, github } = snap;
  const count = (st) => sessions.filter((s) => s.state === st).length;
  const repos = snap.repos.map((r) => {
    const open = r.groups.filter((g) => !g.done);
    const issues = open.filter((g) => g.active).map((g) => {
      const st = issueStateOf(g);
      return {
        number: g.number, title: g.title, url: ghUrl(`https://github.com/${r.repo}/issues/${g.number}`), state: st.word, tone: TONES[st.rank],
        team: g.unknown ? null : g.team, step: g.step, waitsOn: g.waiting === '–' ? null : g.waiting,
        pr: g.pr ? { number: g.pr.number, title: g.pr.title, url: ghUrl(`https://github.com/${r.repo}/pull/${g.pr.number}`), checks: Object.entries(g.pr.checks).map(([name, mark]) => ({ name, mark })) } : null,
        rank: st.rank,
      };
    }).sort((a, b) => a.rank - b.rank || a.number - b.number).map(({ rank, ...issue }) => issue);
    const st = r.ghStatus;
    return {
      repo: r.repo, url: ghUrl(`https://github.com/${r.repo}`), issues, older: open.length - issues.length,
      note: st ? `GitHub read failed at ${local(st.failedAt, now)}, ${st.goodAt ? `showing the read of ${local(st.goodAt, now)}` : 'nothing read yet'}` : null,
    };
  }).filter((r) => r.issues.length || r.note);
  return {
    at: now,
    readAt: local(now, now),
    github: { ok: Boolean(github.ok), error: github.ok ? null : tidy(String(github.error ?? '').split('\n')[0]), age: age(now - github.at) },
    queue: { text: queue.lastSweep ? `${queue.queueFailed ? 'failed, last ok' : 'ok'} ${local(Date.parse(queue.lastSweep), now)}` : '?', alerts: queue.failed.length },
    waits: waitsOf(snap).map((w) => ({ ...w, url: ghUrl(w.url) })),
    repos,
    accounts: input.accounts.map((a) => ({ letter: tidy(a.letter), fiveHour: windowOf(a.five_hour, now), sevenDay: windowOf(a.seven_day, now), teams: tidyDeep(a.users) })),
    today: { merged: input.today.merged, cost: input.today.cost, waited: age(input.today.waitedMs) },
    load: { one: Math.round(input.load[0] * 10) / 10, cores: input.cores, working: count('working'), idle: count('idle'), waiting: count('waiting') },
  };
}
