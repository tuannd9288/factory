// The overview page (#369): its view model and HTML (bin/lib/page.mjs) and the command that prints them (bin/lib/page-cli.mjs), all on
// a hand-built snapshot. Nothing here listens on a port, runs ps or reaches GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const PID = 48213;

const group = (number, o = {}) => ({
  number, title: `issue ${number}`, done: false, active: true, team: 'alpha', step: 'PR open', waiting: '–', sessions: [],
  pr: { number: number + 100, title: `pr ${number}`, checks: { verify: '✓', review: '…' } }, ...o,
});

const lead = (o = {}) => ({
  name: 'lead-alpha', role: 'lead', team: 'alpha', state: 'waiting', repo: 'o/app', pane: 'p1', waitNote: 'permission', live: true, folder: 'f',
  cost: null, estCost: null, stateAt: null, startedAt: null, lastAt: NOW, ctx: null, turns: null, tokensIn: null, tokensOut: null,
  harness: 'claude', seat: null, cwd: '/Users/factory/secret/place', branch: null, pid: PID, command: '/Users/factory/bin/claude --resume secret-token', ...o,
});

/** A snapshot as top.mjs's snapshot() returns it, with the fields that must not leave the host in it. */
const snap = (o = {}) => ({
  now: NOW, load: [1.234, 1, 1], cores: 8,
  sessions: [lead()],
  repos: [{
    repo: 'o/app', other: [], ghStatus: null,
    groups: [group(1), group(2, { waiting: 'the Human', title: 'Needs <b>you</b>' }), group(3, { done: true }), group(4, { active: false, pr: null, step: 'unclaimed' })],
  }],
  github: { ok: true, error: null, at: NOW - 30_000 },
  queue: { lastSweep: '2026-11-03T11:59:00Z', queueFailed: false, failed: [{ file: 'queue-checkout.failed', text: '2026-11-03T10:00:00.000Z behind main' }] },
  events: [{ kind: 'waiting-on-human', text: 'a thing waits', url: 'https://github.com/o/app/pull/9' }],
  accounts: [{ letter: 'A', name: 'secretaccount', five_hour: { use: 0.25, resetsAt: NOW / 1000 + 3600 }, seven_day: null, users: ['app-alpha'] }],
  today: { merged: 2, cost: [['A', 1.5]], waitedMs: 600_000 },
  ...o,
});

const { viewOf, pageOf } = await import('../bin/lib/page.mjs');
const { main } = await import('../bin/lib/page-cli.mjs');
const { waitsOf, render } = await import('../bin/lib/top.mjs');

test('viewOf puts what waits on the Human first, and holds no command line, pid, home path or account name', () => {
  const view = viewOf(snap());
  assert.deepEqual(Object.keys(view).slice(0, 5), ['at', 'readAt', 'github', 'queue', 'waits']);
  assert.deepEqual(view.waits.map((w) => w.verb), ['approve', 'answer', 'answer', 'alert']);
  assert.equal(view.waits[0].url, 'https://github.com/o/app/pull/102');
  const text = JSON.stringify(view);
  for (const secret of [String(PID), 'secret-token', '/Users/factory', 'secretaccount', 'claude --resume']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(view.accounts, [{ letter: 'A', fiveHour: { percent: 25, resets: '13:00' }, sevenDay: null, teams: ['app-alpha'] }]);
  // Open issues with something going on are listed, the one on the Human first; a done issue is not, and a quiet one is only counted.
  const [repo] = view.repos;
  assert.deepEqual(repo.issues.map((i) => i.number), [2, 1]);
  assert.equal(repo.older, 1);
});

test('viewOf keeps a home path out of a string a log or a folder gave', () => {
  const view = viewOf(snap({ queue: { lastSweep: null, queueFailed: false, failed: [{ file: '/Users/factory/x/queue.failed', text: 'bad\x1b[31m' }] } }));
  const alert = view.waits.find((w) => w.verb === 'alert');
  assert.ok(!/\/Users\/|\x1b/.test(alert.text), alert.text);
});

test('pageOf escapes a title with a script in it, and links only to GitHub', () => {
  const view = viewOf(snap({ repos: [{ repo: 'o/app', other: [], ghStatus: null, groups: [group(1, { title: '<script>alert(1)</script>' })] }], events: [{ kind: 'x', text: 'see', url: 'javascript:alert(1)' }] }));
  const html = pageOf(view);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="[^"]+">/);
  assert.ok(!/<script|src=|@import|https?:\/\/(?!github\.com)/.test(html), 'nothing from elsewhere');
});

/** Runs the command with an injected snapshot and collects what it wrote and what it said on failure. */
async function run(argv) {
  const out = { code: null, stdout: '', stderr: '' };
  out.code = await main(argv, { snapshot: async () => snap(), write: (t) => (out.stdout += t), fail: (t) => (out.stderr += `${t}\n`) });
  return out;
}

test('view prints the view model of the snapshot as JSON', async () => {
  const r = await run(['view']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), viewOf(snap()));
});

test('html prints the page of the snapshot', async () => {
  const r = await run(['html']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, pageOf(viewOf(snap())));
});

test('an unknown verb, no verb or an extra argument exits non-zero with the usage line and prints nothing else', async () => {
  for (const argv of [['serve'], [], ['view', 'x']]) {
    const r = await run(argv);
    assert.notEqual(r.code, 0, argv.join(' '));
    assert.match(r.stderr, /^usage: factory-page /);
    assert.equal(r.stdout, '');
  }
});

test('render prints what waitsOf lists, as it printed it before', () => {
  const input = snap();
  const rows = waitsOf(input);
  const out = render(input, { width: 300 });
  for (const w of rows) assert.ok(out.includes(`  ${w.verb.padEnd(7)}  ${w.text}${w.url ? `  ${w.url}` : ''}`), w.verb);
  assert.ok(out.indexOf('Waiting on you') < out.indexOf(`  ${rows[0].verb.padEnd(7)}  `));
});
