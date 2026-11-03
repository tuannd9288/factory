// The overview page (#369): what `factory top` knows, as one read-only HTML page. Two pure functions, which know nothing of HTTP, a port or
// the host that serves them (bin/factory-page does): viewOf(snapshot) is the view model, and pageOf(view) is the HTML.
// The view model is all that leaves the machine, so it holds only what the page shows: no process command line, pid, environment, token
// path or home path, and an account by its letter alone. Every string is stripped of control characters, and a home path in one is
// cut to `~`; pageOf escapes every string as HTML.
import { age, issueStateOf, local, waitsOf } from './top.mjs';

const tidy = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\/Users\/[^/\s]+/g, '~');
const tidyDeep = (v) => (typeof v === 'string' ? tidy(v) : Array.isArray(v) ? v.map(tidyDeep) : v && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidyDeep(x)])) : v);

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
        number: g.number, title: g.title, url: `https://github.com/${r.repo}/issues/${g.number}`, state: st.word, tone: TONES[st.rank],
        team: g.unknown ? null : g.team, step: g.step, waitsOn: g.waiting === '–' ? null : g.waiting,
        pr: g.pr ? { number: g.pr.number, title: g.pr.title, url: `https://github.com/${r.repo}/pull/${g.pr.number}`, checks: Object.entries(g.pr.checks).map(([name, mark]) => ({ name, mark })) } : null,
        rank: st.rank,
      };
    }).sort((a, b) => a.rank - b.rank || a.number - b.number).map(({ rank, ...issue }) => issue);
    const st = r.ghStatus;
    return {
      repo: r.repo, url: `https://github.com/${r.repo}`, issues, older: open.length - issues.length,
      note: st ? `GitHub read failed at ${local(st.failedAt, now)}, ${st.goodAt ? `showing the read of ${local(st.goodAt, now)}` : 'nothing read yet'}` : null,
    };
  }).filter((r) => r.issues.length || r.note);
  return {
    at: now,
    readAt: local(now, now),
    github: { ok: Boolean(github.ok), error: github.ok ? null : tidy(String(github.error ?? '').split('\n')[0]), age: age(now - github.at) },
    queue: { text: queue.lastSweep ? `${queue.queueFailed ? 'failed, last ok' : 'ok'} ${local(Date.parse(queue.lastSweep), now)}` : '?', alerts: queue.failed.length },
    waits: waitsOf(snap),
    repos,
    accounts: input.accounts.map((a) => ({ letter: tidy(a.letter), fiveHour: windowOf(a.five_hour, now), sevenDay: windowOf(a.seven_day, now), teams: tidyDeep(a.users) })),
    today: { merged: input.today.merged, cost: input.today.cost, waited: age(input.today.waitedMs) },
    load: { one: Math.round(input.load[0] * 10) / 10, cores: input.cores, working: count('working'), idle: count('idle'), waiting: count('waiting') },
  };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// A link is made only to GitHub; any other address shows as text.
const link = (url, text) => (/^https:\/\/github\.com\/[\w./#-]*$/.test(url ?? '') ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--dim:#656d76;--line:#d8dee4;--you:#9a6700;--bad:#cf222e;--work:#1a7f37;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--line:#30363d;--you:#d29922;--bad:#f85149;--work:#3fb950;--link:#58a6ff}}
body{margin:0;padding:12px max(12px,env(safe-area-inset-right)) 24px max(12px,env(safe-area-inset-left));background:var(--bg);color:var(--fg);font:16px/1.4 -apple-system,system-ui,sans-serif;max-width:46rem;margin-inline:auto}
h1{font-size:1.25rem;margin:.2rem 0}h2{font-size:1.05rem;margin:1.4rem 0 .4rem;border-bottom:1px solid var(--line);padding-bottom:.2rem}h3{font-size:1rem;margin:1rem 0 .3rem}
a{color:var(--link)}ul{list-style:none;margin:0;padding:0}li{padding:.45rem 0;border-bottom:1px solid var(--line)}
.dim{color:var(--dim);font-size:.875rem}.you{color:var(--you);font-weight:600}.bad{color:var(--bad);font-weight:600}.work{color:var(--work)}.idle,.done{color:var(--dim)}
.tag{font-size:.8125rem;margin-right:.4rem}p{margin:.3rem 0}
`;

const list = (items) => `<ul>${items.join('')}</ul>`;

const waitRow = (w) => `<li><span class="tag you">${esc(w.verb)}</span>${w.url ? link(w.url, w.text) : esc(w.text)}</li>`;

const issueRow = (i) => {
  const checks = i.pr ? ` · ${i.pr.checks.map((c) => `${esc(c.name)} ${esc(c.mark)}`).join(' ')}` : '';
  const meta = [`team ${i.team ?? 'none'}`, i.step, i.waitsOn ? `waits on ${i.waitsOn}` : null].filter(Boolean).map(esc).join(' · ');
  return `<li><span class="tag ${esc(i.tone)}">${esc(i.state)}</span>${link(i.url, `#${i.number} ${i.title}`)}<div class="dim">${meta}${i.pr ? ` · ${link(i.pr.url, `PR #${i.pr.number}`)}${checks}` : ' · no PR'}</div></li>`;
};

const repoBlock = (r) => `<h3>${link(r.url, r.repo)}</h3>${r.note ? `<p class="bad">${esc(r.note)}</p>` : ''}${r.issues.length ? list(r.issues.map(issueRow)) : ''}${r.older ? `<p class="dim">${r.older} older, nothing going on</p>` : ''}`;

const windowText = (label, w) => (w ? `${label} ${w.percent}%${w.resets ? `, resets ${w.resets}` : ''}` : `${label} ?`);

const accountRow = (a) => `<li><b>${esc(a.letter)}</b> · ${esc(windowText('5h', a.fiveHour))} · ${esc(windowText('7d', a.sevenDay))}<div class="dim">${a.teams.length ? esc(a.teams.join(', ')) : 'no team'}</div></li>`;

/** The page as an HTML document, from a view model. Inline style, no script, nothing fetched from elsewhere. */
export function pageOf(view) {
  const t = view.today;
  const l = view.load;
  const cost = t.cost.length ? t.cost.map(([letter, usd]) => `$${usd.toFixed(2)} on account ${letter}`).join(', ') : 'nothing yet';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Factory">
<title>Factory</title>
<style>${CSS}</style></head><body>
<h1>Factory</h1>
<p class="dim">Read ${esc(view.readAt)}; ${view.github.ok ? `GitHub read ${esc(view.github.age)} before` : `<span class="bad">GitHub failed (${esc(view.github.error)}), last read ${esc(view.github.age)} before</span>`}; queue ${esc(view.queue.text)}, ${view.queue.alerts} alert${view.queue.alerts === 1 ? '' : 's'}</p>
<h2>${view.waits.length ? 'Waiting on you' : 'Nothing waits on you'}</h2>
${view.waits.length ? list(view.waits.map(waitRow)) : ''}
<h2>Repositories</h2>
${view.repos.length ? view.repos.map(repoBlock).join('\n') : '<p class="dim">Nothing going on.</p>'}
<h2>Accounts</h2>
${view.accounts.length ? list(view.accounts.map(accountRow)) : '<p class="dim">No account.</p>'}
<h2>Today</h2>
<p>${t.merged} pull request${t.merged === 1 ? '' : 's'} merged; workers and reviewers cost ${esc(cost)}; waited on you ${esc(t.waited)}</p>
<p class="dim">Mac mini load ${l.one} of ${l.cores} cores · ${l.working} working · ${l.idle} idle · ${l.waiting} waiting</p>
</body></html>
`;
}
