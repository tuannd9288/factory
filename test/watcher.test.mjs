import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The reader's test setting, the pass on (FACTORY_READER_SETTING, #518): runPass reads it at each call.
import './helpers.mjs';
import { runPass, watchSilence } from '../bin/lib/reader.mjs';

test('Watcher sends new Codex limit lines through the provider seam once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  try {
    const state = join(dir, 'state'), runs = join(dir, 'runs');
    mkdirSync(join(runs, 'seat'), { recursive: true });
    mkdirSync(join(state, 'reader'), { recursive: true });
    writeFileSync(join(state, 'reader/cursors.json'), '{}');
    writeFileSync(join(runs, 'seat/run.jsonl'), JSON.stringify({ type: 'error', message: 'You have hit your usage limit.' }) + '\n');
    let calls = 0;
    const provider = async ({ command, args }) => {
      assert.equal(command, 'pi');
      const input = readFileSync(args.find((a) => a.startsWith('@')).slice(1), 'utf8');
      calls++;
      assert.match(input, /You have hit your usage limit/);
      const session = /^### (.+)$/m.exec(input)[1];
      return { ok: true, stdout: JSON.stringify({ events: [{ kind: 'limit', session, quote: 'You have hit your usage limit.', why: 'The seat cannot continue.' }] }) };
    };
    const args = { state, runs, env: {}, provider };
    assert.equal((await runPass(args)).events, 1);
    assert.equal((await runPass(args)).events, 0);
    assert.equal(calls, 1);
    assert.match(readFileSync(join(state, 'events.jsonl'), 'utf8'), /usage limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 2026-11-06: 92 hand-run Codex seat logs sat at <runs>/star/<name>/run.jsonl, the layout quota.mjs reads, and every reader pass made no call.
test('a hand-run seat two folders deep is read: its usage limit reaches the events, named by both folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  try {
    const state = join(dir, 'state'), runs = join(dir, 'runs');
    mkdirSync(join(runs, 'star/peer'), { recursive: true });
    mkdirSync(join(runs, 'issue-1'), { recursive: true });
    mkdirSync(join(state, 'reader'), { recursive: true });
    writeFileSync(join(state, 'reader/cursors.json'), '{}');
    writeFileSync(join(runs, 'star/peer/run.jsonl'), JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit." } }) + '\n');
    writeFileSync(join(runs, 'issue-1/run-peer.jsonl'), JSON.stringify({ type: 'turn.completed' }) + '\n');
    // A pack Lead's worktree w/ and a Lead's transcripts/ are no seat folders: a product repository's run.log at the worktree's root, or a
    // file of that name among the transcript copies, is not a seat stream.
    mkdirSync(join(runs, 'issue-1/w'), { recursive: true });
    mkdirSync(join(runs, 'app-lead/transcripts'), { recursive: true });
    writeFileSync(join(runs, 'issue-1/w/run.log'), 'a product repository log\n');
    writeFileSync(join(runs, 'app-lead/transcripts/run.log'), 'not a seat\n');
    let sessions = [];
    const provider = async ({ args }) => {
      const input = readFileSync(args.find((a) => a.startsWith('@')).slice(1), 'utf8');
      sessions = [...input.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
      return { ok: true, stdout: JSON.stringify({ events: [{ kind: 'limit', session: 'star/peer run', quote: "You've hit your usage limit.", why: 'The seat cannot continue.' }] }) };
    };
    assert.equal((await runPass({ state, runs, env: {}, provider })).events, 1);
    assert.deepEqual(sessions.sort(), ['issue-1 peer', 'star/peer run'], 'a one-level seat and a two-level one, each its own session');
    const [event] = readFileSync(join(state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(event.stream, 'star/peer/run.jsonl');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(state, 'reader/cursors.json'), 'utf8'))).sort(), ['issue-1/run-peer.jsonl', 'star/peer/run.jsonl']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all required signals retain evidence; ordinary lines, invalid quotes and duplicate reports do not wake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  try {
    const state = join(dir, 'state'), runs = join(dir, 'runs');
    const lead = join(runs, 'app-lead/transcripts');
    mkdirSync(lead, { recursive: true });
    mkdirSync(join(runs, 'seat'), { recursive: true });
    mkdirSync(join(state, 'reader'), { recursive: true });
    writeFileSync(join(state, 'reader/cursors.json'), '{}');
    const fixture = readFileSync(new URL('./fixtures/watcher/signals.jsonl', import.meta.url), 'utf8');
    const stream = 'app-lead/transcripts/0a1b2c3d-1111-2222-3333-444455556666.jsonl';
    writeFileSync(join(runs, stream), fixture);
    writeFileSync(join(runs, 'seat/run-worker.err'), 'Login refused in stderr.\n');
    writeFileSync(join(state, 'sessions.jsonl'), '{"role":"worker","code":1,"error":"capacity"}\n');
    const expected = [
      ['struggling', 'I am trying the same fix again; the same assertion failed again.'],
      ['admits-mistake', 'I was wrong about the migration; I edited the wrong table.'],
      ['limit', 'You have hit your usage limit.'],
      ['limit', 'The service is at capacity.'],
      ['limit', 'Login refused; authentication failed.'],
      ['idle-with-work', 'I am idle. No seats are running. The next task is unblocked and I have not started it.'],
    ].map(([kind, quote]) => ({ kind, session: 'app-lead 0a1b2c3d', quote, why: 'Fixture signal.' }));
    let calls = 0;
    const provider = async ({ command, args }) => {
      assert.equal(command, 'pi');
      const input = readFileSync(args.find((a) => a.startsWith('@')).slice(1), 'utf8');
      calls++;
      for (const e of expected) assert.ok(input.includes(e.quote));
      assert.match(input, /sessions.jsonl/);
      assert.match(input, /Login refused in stderr/);
      assert.match(input, /\[byte \d+\]/);
      assert.match(input, /The build passed/);
      // A canned classifier tests transport and validation, not model accuracy.
      return { ok: true, stdout: JSON.stringify({ events: [...expected, expected[0], { ...expected[0], quote: 'invented evidence' }] }) };
    };
    const args = { state, runs, env: {}, provider };
    assert.equal((await runPass(args)).events, 6);
    const events = readFileSync(join(state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind !== 'reader-failed');
    assert.equal(events.length, 6);
    assert.ok(events.every((e) => e.stream === stream && e.signal === e.kind && e.quote));
    assert.equal((await runPass(args)).calls, 0);
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an oversized record is not advanced past until its final evidence was sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  try {
    const state = join(dir, 'state'), runs = join(dir, 'runs');
    mkdirSync(join(state, 'reader'), { recursive: true });
    mkdirSync(join(runs, 'seat'), { recursive: true });
    writeFileSync(join(state, 'reader/cursors.json'), '{}');
    const line = JSON.stringify({ type: 'error', message: 'word '.repeat(82_000) + ' Login refused at the end.' }) + '\n';
    writeFileSync(join(runs, 'seat/run.jsonl'), line);
    const r = await runPass({ state, runs, env: {}, provider: async ({ command, args }) => {
      assert.equal(command, 'pi');
      const input = readFileSync(args.find((a) => a.startsWith('@')).slice(1), 'utf8');
      assert.match(input, /Login refused at the end/);
      return { ok: true, stdout: '{"events":[]}' };
    } });
    assert.equal(r.calls, 1);
    assert.equal(JSON.parse(readFileSync(join(state, 'reader/cursors.json'), 'utf8'))['seat/run.jsonl'], Buffer.byteLength(line));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a finished Lead silent for 15 minutes fires once, names quiet seats, and rearms on a new finished turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  try {
    const state = join(dir, 'state'), runs = join(dir, 'runs');
    const key = 'app-lead/transcripts/0a1b2c3d-1111-2222-3333-444455556666.jsonl';
    mkdirSync(join(runs, 'app-lead/transcripts'), { recursive: true });
    mkdirSync(join(runs, 'quiet'), { recursive: true });
    mkdirSync(join(runs, 'active'), { recursive: true });
    const t = Date.now() - 3600_000, window = 15 * 60_000;
    const lead = join(runs, key);
    const line = (text, stop = 'end_turn') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: stop } }) + '\n';
    const put = (file, text, at) => { writeFileSync(file, text); utimesSync(file, at / 1000, at / 1000); };
    put(lead, line('Finished the first task.'), t);
    put(join(runs, 'quiet/run.jsonl'), 'quiet seat\n', t);
    mkdirSync(join(runs, 'star/peer'), { recursive: true });
    put(join(runs, 'star/peer/run.jsonl'), 'quiet hand-run seat\n', t);
    put(join(runs, 'active/run.jsonl'), 'active seat\n', t + window / 2);
    const reader = await runPass({ state, runs, now: t + window, env: {}, provider: async () => {
      assert.fail('the initial model pass must only set its cursors');
    } });
    assert.equal(reader.events, 0, 'reader passes never emit silence events');
    assert.ok(!existsSync(join(state, 'reader/silence.json')));
    const pass = (now) => ({ events: watchSilence({ state, runs, now }) });
    assert.equal((await pass(t + window - 1)).events, 0);
    const fired = await pass(t + window);
    assert.equal(fired.events, 1);
    assert.equal(readFileSync(join(state, 'reader/started'), 'utf8'), `${t + window}\n`, 'silence checks never start a model pass');
    const events = () => readFileSync(join(state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'watch_fired');
    assert.match(events()[0].quote, /Finished the first task/);
    assert.deepEqual(events()[0].seats, ['quiet/run.jsonl', 'star/peer/run.jsonl']);
    assert.equal((await pass(t + 2 * window)).events, 0);
    // Durable event deduplication also survives loss of the observation cache.
    rmSync(join(state, 'reader/silence.json'));
    assert.equal((await pass(t + 2 * window)).events, 0);
    appendFileSync(lead, line('Starting the next tool.', 'tool_use'));
    utimesSync(lead, (t + 2 * window) / 1000, (t + 2 * window) / 1000);
    assert.equal((await pass(t + 3 * window)).events, 0, 'a nonfinished turn never fires');
    appendFileSync(lead, line('Finished the second task.'));
    utimesSync(lead, (t + 3 * window) / 1000, (t + 3 * window) / 1000);
    assert.equal((await pass(t + 3 * window)).events, 0);
    assert.equal((await pass(t + 4 * window)).events, 1);
    assert.equal(events().length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
