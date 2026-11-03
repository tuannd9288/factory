// The overview page (#369): its view model and HTML (bin/lib/page.mjs), its handler and cache (bin/lib/page-server.mjs) and its job, all on
// a hand-built snapshot and an injected clock. Nothing here listens on a port, runs ps or reaches GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const { handlerOf, pagePlist } = await import('../bin/lib/page-server.mjs');
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

/** A fake response that records what the handler wrote. */
function ask(handler, method, url) {
  const out = { status: null, headers: null, body: null };
  const res = { writeHead: (status, headers) => Object.assign(out, { status, headers }), end: (body) => (out.body = body ?? '') };
  return Promise.resolve(handler({ method, url }, res)).then(() => out);
}

test('the handler answers / with the page, /view.json with the view, HEAD without a body, 404 for another path and 405 for POST', async () => {
  const handler = handlerOf({ snapshot: async () => snap(), now: () => NOW });
  const page = await ask(handler, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /^<!doctype html>/);
  const json = await ask(handler, 'GET', '/view.json?x=1');
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body), viewOf(snap()));
  const head = await ask(handler, 'HEAD', '/');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(page.body));
  assert.equal((await ask(handler, 'GET', '/snapshot.json')).status, 404);
  const post = await ask(handler, 'POST', '/');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('the snapshot is read once within a minute, again after it, and once for requests that arrive during a read', async () => {
  let t = NOW;
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const handler = handlerOf({ snapshot: async () => { calls += 1; await gate; return snap(); }, now: () => t });
  const first = [ask(handler, 'GET', '/'), ask(handler, 'GET', '/view.json')];
  release();
  await Promise.all(first);
  assert.equal(calls, 1, 'two requests during one read share it');
  t = NOW + 59_000;
  await ask(handler, 'GET', '/');
  assert.equal(calls, 1, 'within a minute the last read is shared');
  t = NOW + 60_000;
  await ask(handler, 'GET', '/');
  assert.equal(calls, 2, 'after a minute it is read again');
});

test('a snapshot that fails gives 503 and is tried again at the next request', async () => {
  let calls = 0;
  const handler = handlerOf({ snapshot: async () => { calls += 1; if (calls === 1) throw new Error('boom\nsecret detail'); return snap(); }, now: () => NOW });
  const bad = await ask(handler, 'GET', '/');
  assert.equal(bad.status, 503);
  assert.ok(!bad.body.includes('secret'));
  assert.equal((await ask(handler, 'GET', '/')).status, 200);
});

test('plist --daemon names the job, its log and serve, and keeps it alive with no interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'page-plist-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const text = pagePlist({ env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir }, daemon: true });
    assert.match(text, /<string>io\.github\.tuannd9288\.factory\.page<\/string>/);
    assert.match(text, /<string>serve<\/string>/);
    assert.ok(text.includes(`<string>${join(dir, 'Library/Logs/factory/page.log')}</string>`));
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.ok(!text.includes('StartInterval'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render prints what waitsOf lists, as it printed it before', () => {
  const input = snap();
  const rows = waitsOf(input);
  const out = render(input, { width: 300 });
  for (const w of rows) assert.ok(out.includes(`  ${w.verb.padEnd(7)}  ${w.text}${w.url ? `  ${w.url}` : ''}`), w.verb);
  assert.ok(out.indexOf('Waiting on you') < out.indexOf(`  ${rows[0].verb.padEnd(7)}  `));
});
