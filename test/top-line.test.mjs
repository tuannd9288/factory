// `factory top --line` and `--brief` (#365): the status line and the start hook's text, from fixture folders and a fake gh on PATH. The
// fake gh logs each call, so the tests count how often GitHub is read across separate snapshots (each stands for one process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TZ = 'UTC';

const top = () => import('../bin/lib/top.mjs');
const NOW = Date.parse('2026-10-31T12:00:00Z');
const REPO = 'tuannd9288/factory';

/** A state folder with events, a failed alert, a Lead at a permission prompt, one open tier-3 pull request and a fake gh. */
function world({ waits = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'top-line-'));
  const [runs, state, bin, fx] = ['runs', 'state', 'bin', 'fx'].map((d) => join(root, d));
  for (const d of [runs, state, bin, fx, join(root, 'WORKSPACES/factory/.gate/bin')]) mkdirSync(d, { recursive: true });
  const ev = (seq, type, text) => `${JSON.stringify({ seq, at: `2026-10-31T11:0${seq}:00Z`, type, kind: 'waiting-on-human', key: `k${seq}`, text })}\n`;
  writeFileSync(join(state, 'events.jsonl'), ev(1, 'start', 'first') + ev(2, 'clear', 'first') + ev(3, 'start', 'third'));
  writeFileSync(join(state, 'events.cursor'), '1\n');
  const check = (name, conclusion, status = 'COMPLETED') => ({ name, status, conclusion, completedAt: '2026-10-31T11:00:00Z' });
  writeFileSync(join(fx, 'issues.json'), JSON.stringify([{ number: 7, title: 'Seven', state: 'OPEN' }, { number: 8, title: 'Eight', state: 'OPEN' }]));
  writeFileSync(join(fx, 'prs.json'), JSON.stringify(waits ? [{ number: 20, title: 'Seven pr', state: 'OPEN', headRefName: 'issue-7', body: 'Issue: #7\nTeam: alpha', labels: [{ name: 'tier-3' }], mergedAt: null, statusCheckRollup: [check('verify', 'SUCCESS'), check('tier', 'FAILURE')] }] : []));
  if (waits) {
    writeFileSync(join(state, 'digest.failed'), '2026-10-31T09:00:00Z digest failed\n');
    mkdirSync(join(runs, 'factory-alpha'), { recursive: true });
    writeFileSync(join(runs, 'factory-alpha/state.json'), JSON.stringify({ event: 'Notification', type: 'permission_prompt', at: new Date(NOW - 5000).toISOString() }));
  }
  const log = join(root, 'gh.log');
  const gh = (body) => {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\n${body}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
  };
  const good = `case "$1 $2" in\n"issue list") cat '${fx}/issues.json';;\n"pr list") cat '${fx}/prs.json';;\n*) exit 1;;\nesac`;
  gh(good);
  const opts = {
    runs, state, now: NOW, repos: [REPO], clones: new Map([[REPO, join(root, 'WORKSPACES/factory')]]), live: () => false,
    processes: () => (waits ? [{ pid: 1, ageMs: 600_000, command: 'claude --name factory-alpha' }] : []),
    branchOf: () => null, originOf: () => null, load: [0, 0, 0], cores: 4, agentProfiles: join(root, 'profiles'), shared: true,
    claims: async () => new Map([[7, { state: 'claimed', team: 'alpha' }], [8, { state: 'claimed', team: 'beta' }]]),
  };
  return { state, opts, calls: () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }, breakGh: () => gh('echo "HTTP 403 rate limit" >&2; exit 1'), slowGh: (secs) => gh(`sleep ${secs}; ${good}`) };
}

/** One snapshot as a fresh process takes it: no memory cache, with PATH holding the fake gh. */
async function take(w, extra = {}) {
  const { snapshot } = await top();
  const dir = join(w.state, '..', 'bin');
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try {
    return await snapshot({ ...w.opts, ...extra });
  } finally {
    process.env.PATH = before;
  }
}

test('--line counts what waits, the Leads waiting, the alerts and the teams at work', async () => {
  const { lineOf } = await top();
  const line = lineOf(await take(world()), { width: 200 });
  assert.equal(line, '1 to approve · 1 Lead waiting · 1 alert · 1 team working');
});

test('--line says so when nothing waits, and leaves out a part that is zero', async () => {
  const { lineOf } = await top();
  assert.equal(lineOf(await take(world({ waits: false })), { width: 80 }), 'Nothing waits on you');
});

test('--line drops whole parts from the right to fit its width, and never cuts a word', async () => {
  const { lineOf } = await top();
  const snap = await take(world());
  assert.equal(lineOf(snap, { width: 30 }), '1 to approve · 1 Lead waiting');
  assert.equal(lineOf(snap, { width: 20 }), '1 to approve');
  for (const w of [5, 12, 40, 55]) assert.ok([...lineOf(snap, { width: w })].length <= w);
});

test('--line shows ? for the pull requests when GitHub cannot be read and nothing is cached, and does not throw', async () => {
  const { lineOf } = await top();
  const w = world();
  w.breakGh();
  const line = lineOf(await take(w), { width: 200 });
  assert.match(line, /^\? to approve · 1 Lead waiting/);
});

test('--brief prints what waits, the teams with their issues, the start events, and ends with the highest seq', async () => {
  const { briefOf } = await top();
  const text = await briefOf(await take(world()));
  const lines = text.split('\n');
  assert.equal(lines.at(-1), 'seq 3');
  assert.ok(lines.length <= 32);
  assert.ok(lines.includes('Waiting on you'));
  assert.ok(lines.some((l) => l.includes(`${REPO}#20 Seven pr`)));
  assert.ok(lines.includes('Teams'));
  assert.ok(lines.some((l) => /factory alpha: Lead waiting; #7 Seven/.test(l)));
  assert.ok(lines.some((l) => /factory beta: no Lead running; #8 Eight/.test(l)));
  assert.ok(lines.some((l) => l.includes('#1 ') && l.includes('first')));
  assert.ok(lines.some((l) => l.includes('#3 ') && l.includes('third')));
  assert.ok(!lines.some((l) => l.includes('#2 ')), 'a clear line is no start event');
});

test('--brief --after <seq> prints only the start events after it, leaves the cursor alone, and still ends with the highest seq', async () => {
  const { briefOf } = await top();
  const w = world();
  const text = await briefOf(await take(w), { after: 1 });
  assert.ok(text.includes('third') && !text.includes('first'));
  assert.equal(text.split('\n').at(-1), 'seq 3');
  assert.equal(readFileSync(join(w.state, 'events.cursor'), 'utf8'), '1\n');
  const none = await briefOf(await take(w), { after: 3 });
  assert.match(none, /No events after seq 3\nseq 3$/);
});

test('--brief with no events file ends with seq 0, and a long block ends with a line saying how many more', async () => {
  const { briefOf } = await top();
  const w = world({ waits: false });
  writeFileSync(join(w.state, 'events.jsonl'), '');
  assert.match(await briefOf(await take(w)), /No events yet\nseq 0$/);
  for (let i = 0; i < 14; i += 1) writeFileSync(join(w.state, `x${i}.failed`), `2026-10-31T09:00:00Z failed ${i}\n`);
  const lines = (await briefOf(await take(w))).split('\n');
  assert.equal(lines.filter((l) => l.startsWith('  alert')).length, 8);
  assert.ok(lines.some((l) => /^ {2}… \d+ more waiting$/.test(l)));
});

test('--brief cuts a long events block, says how many come after, and its seq is the last event printed so the Monitor delivers the rest', async () => {
  const { briefOf } = await top();
  const w = world({ waits: false });
  const ev = (seq) => `${JSON.stringify({ seq, at: '2026-10-31T11:00:00Z', type: 'start', kind: 'waiting-on-human', key: `k${seq}`, text: `event ${seq}` })}\n`;
  writeFileSync(join(w.state, 'events.jsonl'), Array.from({ length: 12 }, (_, i) => ev(i + 1)).join(''));
  const lines = (await briefOf(await take(w), { after: 0 })).split('\n');
  const printed = lines.filter((l) => /^ {2}#\d+ /.test(l)).map((l) => Number(/#(\d+)/.exec(l)[1]));
  assert.deepEqual(printed, [1, 2, 3, 4, 5, 6], 'in seq order, oldest first');
  assert.ok(lines.includes('  … 6 more start events after seq 6'));
  assert.equal(lines.at(-1), 'seq 6');
  // Not cut: seven events fit, and seq is the highest.
  writeFileSync(join(w.state, 'events.jsonl'), Array.from({ length: 7 }, (_, i) => ev(i + 1)).join(''));
  const whole = (await briefOf(await take(w), { after: 0 })).split('\n');
  assert.equal(whole.filter((l) => /^ {2}#\d+ /.test(l)).length, 7);
  assert.ok(!whole.some((l) => l.includes('more start events')));
  assert.equal(whole.at(-1), 'seq 7');
});

test('past its deadline a mode prints from the shared cache, or ? with none, and a slow gh never delays it (#365)', async () => {
  const { textOf } = await top();
  const slow = (w) => w.slowGh(3);
  const run = async (w, extra) => {
    const before = process.env.PATH;
    process.env.PATH = `${join(w.state, '..', 'bin')}:${before}`;
    try {
      const t0 = Date.now();
      const r = await textOf('line', { width: 200, deadlineMs: 300, opts: { ...w.opts, ...extra } });
      return { ...r, ms: Date.now() - t0 };
    } finally {
      process.env.PATH = before;
    }
  };
  const bare = world();
  slow(bare);
  const none = await run(bare);
  assert.equal(none.late, true);
  assert.ok(none.ms < 2500, `took ${none.ms} ms`);
  assert.match(none.text, /^\? to approve/);
  const cached = world();
  await take(cached);
  slow(cached);
  const old = await run(cached, { now: NOW + 600_000 });
  assert.equal(old.late, true);
  assert.ok(old.ms < 2500, `took ${old.ms} ms`);
  assert.equal(old.text.split(' · ')[0], '1 to approve', 'a cache older than the minute stands in');
});

test('two runs within a minute read GitHub once, a run after the minute reads it again, and a failed read keeps the last good one', async () => {
  const { lineOf } = await top();
  const w = world();
  await take(w);
  const first = w.calls();
  assert.ok(first > 0);
  await take(w, { now: NOW + 30_000 });
  assert.equal(w.calls(), first, 'a second process within the minute reuses the file');
  await take(w, { now: NOW + 61_000 });
  assert.equal(w.calls(), first * 2);
  w.breakGh();
  const snap = await take(w, { now: NOW + 130_000 });
  assert.equal(snap.github.ok, false);
  assert.equal(lineOf(snap, { width: 200 }).split(' · ')[0], '1 to approve', 'the last good read stands in');
});
