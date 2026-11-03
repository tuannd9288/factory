// The overview data (#369): its view model (bin/lib/view.mjs) and the command that prints it (bin/lib/view-cli.mjs), all on
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

const { viewOf } = await import('../bin/lib/view.mjs');
const { main } = await import('../bin/lib/view-cli.mjs');
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

test('viewOf keeps a URL only if it points to GitHub', () => {
  const view = viewOf(snap({ events: [{ kind: 'x', text: 'see', url: 'javascript:alert(1)' }, { kind: 'x', text: 'there', url: 'https://example.com/x' }, { kind: 'x', text: 'ok', url: 'https://github.com/o/app/pull/9' }] }));
  const urls = [...view.waits.map((w) => w.url), ...view.repos.flatMap((r) => [r.url, ...r.issues.flatMap((i) => [i.url, i.pr?.url])])].filter((u) => u !== undefined);
  assert.ok(urls.includes('https://github.com/o/app/pull/9'));
  for (const url of urls) assert.ok(url === '' || /^https:\/\/github\.com\//.test(url), url);
  assert.equal(view.waits.find((w) => w.text === 'see').url, '');
  assert.equal(view.waits.find((w) => w.text === 'there').url, '');
});

/** Runs the command with an injected snapshot and collects what it wrote and what it said on failure. */
async function run(argv) {
  const out = { code: null, stdout: '', stderr: '' };
  out.code = await main(argv, { snapshot: async () => snap(), write: (t) => (out.stdout += t), fail: (t) => (out.stderr += `${t}\n`) });
  return out;
}

test('with no argument the command prints the view model of the snapshot as JSON', async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), viewOf(snap()));
});

test('any argument exits 2 with the usage line and prints nothing else', async () => {
  for (const argv of [['view'], ['html'], ['--x', 'y']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /^usage: factory-view/);
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
