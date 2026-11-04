// #339: the stream reader. Every 15 minutes the sweep starts one pass: it reads what the Leads and the seats wrote since the last pass,
// reduces it to the assistant's text and the tool names, sends it to one model the setting picks (pi or codex), checks the answer's
// quotes against what was sent, and writes the findings as lines in #309's events file. A fake `pi` and a fake `codex` on PATH stand in
// for the real ones in every test; every pass gets a state folder and a runs folder of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { factory } from './helpers.mjs';

process.env.TZ = 'UTC';

const reader = () => import('../bin/lib/reader.mjs');
const fixture = (name) => readFileSync(join(factory, 'test/fixtures/reader', name), 'utf8');
const LEAD_ID = '0a1b2c3d-1111-2222-3333-444455556666';
const T0 = Date.parse('2026-11-02T10:00:00Z');
const MIN = 60_000;

function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'reader-'));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = body(dir);
  } catch (error) {
    remove();
    throw error;
  }
  if (typeof result?.then !== 'function') {
    remove();
    return result;
  }
  return result.finally(remove);
}

const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const Q = process.env.Q;
const name = require('path').basename(process.argv[1]);
const argv = process.argv.slice(2);
const stdin = name === 'codex' ? fs.readFileSync(0, 'utf8') : '';
const at = argv.find((a) => a.startsWith('@'));
const input = at ? fs.readFileSync(at.slice(1), 'utf8') : stdin;
fs.appendFileSync(Q + '/calls.jsonl', JSON.stringify({ name, argv, cwd: process.cwd(), input, stdin }) + '\\n');
const n = fs.readFileSync(Q + '/calls.jsonl', 'utf8').split('\\n').filter(Boolean).length;
if (fs.existsSync(Q + '/tree')) {
  // A grandchild that holds our stdout and outlives us, as a model CLI's helper process might.
  const g = require('child_process').spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(Q + '/grandchild', String(g.pid));
  setInterval(() => {}, 1000);
}
else if (fs.existsSync(Q + '/orphan')) {
  // Exits at once; a grandchild in a session of its own keeps our stdout open, out of reach of a kill of our group.
  const g = require('child_process').spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  fs.writeFileSync(Q + '/grandchild', String(g.pid));
}
else if (fs.existsSync(Q + '/hang')) setInterval(() => {}, 1000);
else if (fs.existsSync(Q + '/answer-' + n + '.txt')) process.stdout.write(fs.readFileSync(Q + '/answer-' + n + '.txt', 'utf8'));
else if (fs.existsSync(Q + '/fail')) { process.stderr.write('boom ghp_abcdefghijklmnopqrstuvwxyz0123456789\\n'); process.exit(1); }
else process.stdout.write(fs.readFileSync(Q + '/answer.txt', 'utf8'));
`;

const DEFAULT = { side: 'pi', sides: { pi: { model: 'antigravity/gemini-3.8-flash', effort: 'high' }, codex: { model: 'gpt-6-luna', effort: 'high' } } };

/** A state folder, a runs folder, a fake pi and a fake codex that log every call to $Q/calls.jsonl and print $Q/answer.txt. */
function world(dir) {
  const [state, runs, bin, q] = ['state', 'runs', 'bin', 'q'].map((d) => join(dir, d));
  for (const d of [state, runs, bin, q]) mkdirSync(d);
  for (const n of ['pi', 'codex']) {
    writeFileSync(join(bin, n), FAKE);
    chmodSync(join(bin, n), 0o755);
  }
  const answer = (a) => writeFileSync(join(q, 'answer.txt'), typeof a === 'string' ? a : JSON.stringify(a));
  answer({ events: [] });
  const settingFile = join(dir, 'reader.json');
  const setting = (s) => writeFileSync(settingFile, JSON.stringify(s));
  setting(DEFAULT);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, Q: q };
  const calls = () => (existsSync(join(q, 'calls.jsonl')) ? readFileSync(join(q, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const pass = async (o = {}) => (await reader()).runPass({ state, runs, settingFile, home: '/h', env, ...o });
  const cursors = () => JSON.parse(readFileSync(join(state, 'reader/cursors.json'), 'utf8'));
  const events = () => (existsSync(join(state, 'events.jsonl')) ? readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const shape = () => events().map((l) => `${l.type} ${l.key}`);
  const seatFile = (folder = 'issue-333', tag = 'fix9') => join(runs, folder, `run-${tag}.jsonl`);
  const leadFile = (folder = 'app-lead', id = LEAD_ID) => join(runs, folder, 'transcripts', `${id}.jsonl`);
  const put = (file, text) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  return { state, runs, bin, q, answer, setting, settingFile, env, calls, pass, cursors, events, shape, seatFile, leadFile, put, flag: (n) => writeFileSync(join(q, n), ''), unflag: (n) => rmSync(join(q, n), { force: true }) };
}

const say = (text, extra = {}) => `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, ...extra })}\n`;
const user = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } })}\n`;

// ---- the reduction --------------------------------------------------------------------------------------------------------

test('the reduction of a seat stream keeps the assistant\'s text and the tool names, with tokens redacted, and nothing else', async () => {
  const { reduce } = await reader();
  const out = reduce(fixture('seat-stream.jsonl'));
  for (const kept of ['I will read the config first.', 'going in circles on the same flaky test', 'I made a mistake: I edited the wrong file', 'Read', 'Bash']) assert.ok(out.includes(kept), kept);
  for (const gone of ['THINKING-MARKER', 'TOOL-INPUT-MARKER', 'TOOL-OUTPUT-MARKER', 'TOOL-RESULT-MARKER', 'USER-TURN-MARKER', 'RESULT-MARKER', 'SUBAGENT-MARKER', 'HOOK-NAME-MARKER', 'npm test'])
    assert.ok(!out.includes(gone), `${gone} is in the reduction`);
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.match(out, /The deploy token is \[redacted\]/);
});

test('the reduction keeps the input of a StructuredOutput call, redacted, and no other tool\'s input or result', async () => {
  const { reduce } = await reader();
  const out = reduce(fixture('seat-report.jsonl'));
  for (const kept of ['[tool Read]', '[tool StructuredOutput]', 'I skipped the migration step because the fixture database was missing.', 'I ran the full suite once although the brief said not to.', 'The build script also ignores the retry flag.'])
    assert.ok(out.includes(kept), kept);
  for (const gone of ['REPORT-TOOL-INPUT-MARKER', 'REPORT-TOOL-OUTPUT-MARKER', 'REPORT-TOOL-RESULT-MARKER', 'REPORT-RESULT-MARKER', 'Structured output provided successfully'])
    assert.ok(!out.includes(gone), `${gone} is in the reduction`);
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.match(out, /deploy key \[redacted\] was pasted/);
  // The report follows its tool line, as compact JSON; a string input is taken as it is.
  assert.match(out, /\[tool StructuredOutput\]\n\{"status":"partial"/);
  const one = (input) => reduce(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input }] }, parent_tool_use_id: null })}\n`);
  assert.equal(one('plain report words'), '[tool StructuredOutput]\nplain report words');
  // Only that exact name: another tool's input stays out, and so does a subagent's call.
  const other = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutputX', input: { a: 'OTHER-INPUT-MARKER' } }] }, parent_tool_use_id: null });
  const sub = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { a: 'SUB-INPUT-MARKER' } }] }, parent_tool_use_id: 'toolu_9' });
  assert.equal(reduce(`${other}\n${sub}\n`), '[tool StructuredOutputX]');
});

test('a secret in a report string reaches the reduction redacted even when JSON escaping would hide it', async () => {
  const { reduce } = await reader();
  const out = reduce(fixture('seat-report.jsonl'));
  assert.ok(!out.includes('Ab12cd34'), 'a quoted value after a secret name');
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'), 'a token after a line break');
  assert.match(out, /the log said secret: \*\*\* near the top/);
  assert.match(out, /the log said\\n\*\*\* and went on/);
});

test('the reduction of a Lead copy drops the lines that are not the assistant\'s own, a subagent\'s included', async () => {
  const { reduce } = await reader();
  const out = reduce(fixture('lead-copy.jsonl'));
  for (const kept of ['I am now also refactoring the build script', 'Edit', 'trying the same fix a third time']) assert.ok(out.includes(kept), kept);
  for (const gone of ['LAST-PROMPT-MARKER', 'TITLE-MARKER', 'BLOB-MARKER', 'USER-MARKER', 'LEAD-THINKING-MARKER', 'LEAD-INPUT-MARKER', 'LEAD-OUTPUT-MARKER', 'SIDECHAIN-MARKER', 'ATTACHMENT-MARKER'])
    assert.ok(!out.includes(gone), `${gone} is in the reduction`);
});

test('a line that is not JSON reduces to nothing, and a secret of the forms seatwork knows is hidden', async () => {
  const { reduce } = await reader();
  assert.equal(reduce('not json\n{"type":"assistant"\n').trim(), '');
  const secrets = ['sk-ant-api03-abcdefghijklmnop1234', 'AKIAABCDEFGHIJKLMNOP', 'Authorization: Bearer abcdefghijklmnop12345', 'API_KEY=hunter2hunter2', 'postgres://user:pa55word@db.example/x'];
  const out = reduce(secrets.map((s) => say(`note ${s} end`)).join(''));
  for (const s of ['sk-ant-api03-abcdefghijklmnop1234', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnop12345', 'hunter2hunter2', 'pa55word']) assert.ok(!out.includes(s), s);
});

test('the redaction is one function: events.mjs uses it and keeps every pattern it had', async () => {
  const events = await import('../bin/lib/events.mjs');
  const { redact } = await import('../bin/lib/redact.mjs');
  assert.equal(events.redact, redact);
  assert.equal(redact('mail someone.private@example.com'), 'mail [account]');
  assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz'), '[redacted] and [redacted]');
  assert.equal(redact('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789'), '[redacted]');
  assert.equal(redact('plain words'), 'plain words');
});

// ---- the setting ----------------------------------------------------------------------------------------------------------

test('the setting file is the default: pi, antigravity/gemini-3.8-flash, high; codex is there as well', async () => {
  const { loadSetting, SETTING_FILE } = await reader();
  assert.equal(SETTING_FILE, join(factory, 'bin/lib/reader.json'));
  assert.deepEqual(JSON.parse(readFileSync(SETTING_FILE, 'utf8')), DEFAULT);
  assert.deepEqual(loadSetting(SETTING_FILE), { side: 'pi', model: 'antigravity/gemini-3.8-flash', effort: 'high' });
});

test('each side\'s command is built from the setting alone, exactly', async () => {
  const { commandOf } = await reader();
  const where = { input: 'THE INPUT', inputFile: '/s/reader/input.txt', schemaFile: '/s/reader/schema.json', empty: '/s/reader/empty', home: '/h' };
  const pi = commandOf({ side: 'pi', model: 'antigravity/gemini-3.8-flash', effort: 'high' }, where);
  assert.equal(pi.command, 'pi');
  assert.deepEqual(pi.args.slice(0, -1), [
    '-p', '--no-session', '--no-tools', '-nc', '-ne', '-e', '/h/.pi/agent/npm/node_modules/@heyhuynhgiabuu/pi-oauth-antigravity/dist/index.js',
    '--model', 'antigravity/gemini-3.8-flash', '--thinking', 'high', '@/s/reader/input.txt',
  ]);
  assert.equal(typeof pi.args.at(-1), 'string', 'the fixed prompt is the message');
  assert.ok(pi.args.at(-1).length > 0);
  assert.ok(!pi.args.at(-1).includes('THE INPUT'));
  assert.equal(pi.stdin, null);
  const codex = commandOf({ side: 'codex', model: 'gpt-6-luna', effort: 'xhigh' }, where);
  assert.equal(codex.command, 'codex');
  assert.deepEqual(codex.args, [
    'exec', '--ephemeral', '--skip-git-repo-check', '-C', '/s/reader/empty', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=xhigh', '--output-schema', '/s/reader/schema.json', '-',
  ]);
  assert.ok(codex.stdin.includes('THE INPUT'), 'codex gets the prompt and the input on stdin');
  assert.ok(codex.stdin.indexOf('THE INPUT') > 0, 'the prompt comes first');
});

test('a setting naming no known side, a missing model, an effort the side does not take or any other key is refused', async () => {
  const { loadSetting } = await reader();
  await withDir((dir) => {
    const file = join(dir, 'reader.json');
    const load = (s) => {
      writeFileSync(file, typeof s === 'string' ? s : JSON.stringify(s));
      return loadSetting(file);
    };
    const side = (over) => ({ ...DEFAULT, ...over });
    const piWith = (o) => side({ sides: { ...DEFAULT.sides, pi: { ...DEFAULT.sides.pi, ...o } } });
    const codexWith = (o) => side({ side: 'codex', sides: { ...DEFAULT.sides, codex: { ...DEFAULT.sides.codex, ...o } } });
    for (const [why, s] of Object.entries({
      'unknown side': side({ side: 'opencode' }),
      'side not an object key': { sides: DEFAULT.sides },
      'no model': piWith({ model: '' }),
      'model missing': { side: 'pi', sides: { pi: { effort: 'high' }, codex: DEFAULT.sides.codex } },
      'model that is an option': piWith({ model: '--dangerously' }),
      'pi effort': piWith({ effort: 'ultra' }),
      'codex effort off': codexWith({ effort: 'off' }),
      'codex effort max': codexWith({ effort: 'max' }),
      'extra key at the top': { ...DEFAULT, timeout: 5 },
      'extra key in a side': piWith({ extra: 1 }),
      'an unknown side among the sides': { ...DEFAULT, sides: { ...DEFAULT.sides, agy: { model: 'x', effort: 'high' } } },
      'not JSON': 'side: pi',
    }))
      assert.throws(() => load(s), (e) => e.cause === 'setting' || /setting/i.test(e.message), why);
    for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(load(piWith({ effort })).effort, effort);
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) assert.equal(load(codexWith({ effort })).effort, effort);
  });
});

test('a pass with a refused setting makes no model call and writes one reader-failed setting line, once', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.setting({ ...DEFAULT, side: 'agy' });
    w.put(w.seatFile(), say('hello there'));
    await w.pass({ now: T0 });
    await w.pass({ now: T0 + 15 * MIN });
    assert.deepEqual(w.calls(), []);
    assert.deepEqual(w.shape(), ['start reader-failed setting']);
    w.setting(DEFAULT);
    await w.pass({ now: T0 + 30 * MIN });
    assert.deepEqual(w.shape(), ['start reader-failed setting', 'clear reader-failed setting']);
  });
});

// ---- the parse and the quote check ----------------------------------------------------------------------------------------

test('the answer is JSON alone, in a fence or among words if need be; any other shape is malformed', async () => {
  const { parseAnswer } = await reader();
  const ok = { events: [{ kind: 'drift', session: 'a b', quote: 'twelve chars', why: 'because' }] };
  assert.deepEqual(parseAnswer(JSON.stringify(ok)), ok);
  assert.deepEqual(parseAnswer(`\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``), ok);
  assert.deepEqual(parseAnswer('{"events":[]}\n'), { events: [] });
  for (const bad of ['', 'no json at all', '{"events":', '{"events":{}}', '{}', '[]', '{"events":[1]}', '{"events":[{"kind":"nice","session":"a","quote":"twelve chars","why":"w"}]}',
    '{"events":[{"kind":"drift","session":1,"quote":"twelve chars","why":"w"}]}', '{"events":[{"kind":"drift","session":"a","quote":"twelve chars"}]}', '{"events":[],"extra":1}'])
    assert.throws(() => parseAnswer(bad), undefined, JSON.stringify(bad));
});

test('the quote check keeps a quote that is verbatim in its session\'s part, and drops every other', async () => {
  const { judge } = await reader();
  const parts = new Map([
    ['issue-333 fix9', 'I am going in circles on the same flaky test.\n[tool Bash]'],
    ['app-lead 0a1b2c3d', 'Tests are red again and I do not know why.'],
  ]);
  const ev = (session, quote) => ({ kind: 'struggling', session, quote, why: 'w' });
  const r = judge({ events: [
    ev('issue-333 fix9', 'going in circles on the same flaky test'),
    ev('issue-333 fix9', 'Tests are red again'),
    ev('app-lead 0a1b2c3d', 'Tests are red again'),
    ev('issue-333 fix9', 'never written by anyone'),
    ev('issue-333 fix9', 'circles'),
    ev('issue-999 nope', 'going in circles'),
    ev('issue-333 fix9', 'GOING IN CIRCLES'),
  ] }, parts);
  assert.deepEqual(r.kept.map((e) => `${e.session}|${e.quote}`), ['issue-333 fix9|going in circles on the same flaky test', 'app-lead 0a1b2c3d|Tests are red again']);
  assert.equal(r.dropped.length, 5);
});

test('the quote check keeps a quote across a `"` or a line break of a report, in plain or escaped form, and drops a made-up one', async () => {
  const { judge, reduce } = await reader();
  const parts = new Map([['issue-333 fix9', reduce(fixture('seat-report.jsonl'))]]);
  const ev = (quote) => ({ kind: 'admits-mistake', session: 'issue-333 fix9', quote, why: 'w' });
  const plainQuote = 'refused: "Permission denied (publickey)" twice\nthen I tried it';
  const quotes = {
    plainQuote,
    escapedQuote: 'refused: \\"Permission denied (publickey)\\" twice\\nthen I tried it',
    plainQuoteOnly: '"Permission denied (publickey)"',
    madeUpPlain: 'refused: "Connection reset by peer" twice\nthen I tried it',
    madeUpEscaped: 'refused: \\"Connection reset by peer\\" twice\\nthen I tried it',
  };
  const r = judge({ events: Object.values(quotes).map(ev) }, parts);
  assert.deepEqual(r.kept.map((e) => e.quote), [quotes.plainQuote, quotes.escapedQuote, quotes.plainQuoteOnly]);
  assert.deepEqual(r.dropped.map((e) => e.quote), [quotes.madeUpPlain, quotes.madeUpEscaped]);
});

test('a malformed answer writes reader-failed answer and no event, and moves no cursor', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), say('first line'));
    await w.pass({ now: T0 });
    const before = w.cursors();
    appendFileSync(w.seatFile(), say('I keep going in circles on this test'));
    w.answer('this is not json');
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.equal(w.calls().length, 1);
    assert.deepEqual(w.shape(), ['start reader-failed answer']);
    assert.deepEqual(w.cursors(), before);
    assert.deepEqual(r.failed, ['answer']);
  });
});

test('a quote that is not in the input, in another session\'s part or too short writes reader-failed answer, never the event', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile('issue-333', 'fix9'), '');
    w.put(w.leadFile(), '');
    await w.pass({ now: T0 });
    let at = T0;
    // A dropped event counts as answered and moves the cursors, so each case is sent new text of its own.
    for (const [n, e] of [
      { kind: 'drift', session: 'issue-333 fix9', quote: 'a made up quote that was never said', why: 'w' },
      { kind: 'drift', session: 'issue-333 fix9', quote: 'Lead words that are only the Lead\'s own', why: 'w' },
      { kind: 'drift', session: 'issue-333 fix9', quote: 'circles', why: 'w' },
    ].entries()) {
      appendFileSync(w.seatFile('issue-333', 'fix9'), say(`I keep going in circles on this test, round ${n}`));
      appendFileSync(w.leadFile(), say(`Lead words that are only the Lead's own, round ${n}`));
      w.answer({ events: [e] });
      at += 15 * MIN;
      const r = await w.pass({ now: at });
      assert.equal(w.calls().length, n + 1, `the model was called for ${JSON.stringify(e)}`);
      assert.deepEqual(r.failed, ['answer'], JSON.stringify(e));
    }
    assert.deepEqual(w.events().filter((l) => l.kind === 'drift'), []);
    assert.deepEqual(w.shape(), ['start reader-failed answer']);
  });
});

test('an answer with a good event and a bad one writes the good one and the failure, and the streams count as answered', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('I keep going in circles on this test'));
    w.answer({ events: [
      { kind: 'struggling', session: 'issue-333 fix9', quote: 'going in circles on this test', why: 'repeats' },
      { kind: 'drift', session: 'issue-333 fix9', quote: 'invented text', why: 'w' },
    ] });
    await w.pass({ now: T0 + 15 * MIN });
    assert.deepEqual(w.shape(), ['start struggling issue-333 fix9', 'start reader-failed answer']);
    assert.equal(w.cursors()['issue-333/run-fix9.jsonl'], statSync(w.seatFile()).size);
  });
});

// ---- the event ------------------------------------------------------------------------------------------------------------

test('a finding becomes one start line named by its session, kind and quote, with no token and no control character', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    w.put(w.leadFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('This keeps failing and I am going in circles on the same flaky test.'));
    appendFileSync(w.leadFile(), say('I am now also refactoring the build script, which issue 12 did not plan.'));
    w.answer({ events: [
      { kind: 'struggling', session: 'issue-333 fix9', quote: 'going in circles on the same flaky test', why: 'repeats the same step\nghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      { kind: 'unplanned-work', session: 'app-lead 0a1b2c3d', quote: 'also refactoring the build script', why: 'not in the issue' },
    ] });
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.deepEqual(r.failed, []);
    const lines = w.events();
    assert.deepEqual(lines.map((l) => [l.seq, l.type, l.kind, l.key]), [[1, 'start', 'struggling', 'struggling issue-333 fix9'], [2, 'start', 'unplanned-work', 'unplanned-work app-lead 0a1b2c3d']]);
    assert.equal(lines[0].text, 'issue-333 fix9 struggling: "going in circles on the same flaky test" (repeats the same step [redacted])');
    assert.equal(lines[1].text, 'app-lead 0a1b2c3d unplanned-work: "also refactoring the build script" (not in the issue)');
    assert.doesNotMatch(readFileSync(join(w.state, 'events.jsonl'), 'utf8'), /ghp_/);
    const active = JSON.parse(readFileSync(join(w.state, 'events-active.json'), 'utf8'));
    assert.equal(active.seq, 2);
    assert.deepEqual(active.conditions, {}, 'a finding is a one-time line, never a condition');
  });
});

test('the headers name a seat stream by its run folder and tag, and a Lead copy by its folder and the first 8 characters of the session', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    w.put(w.leadFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('seat words'));
    appendFileSync(w.leadFile(), say('lead words'));
    await w.pass({ now: T0 + 15 * MIN });
    const input = w.calls()[0].input;
    assert.match(input, /^.*issue-333 fix9.*\n.*seat words/m);
    assert.match(input, /^.*app-lead 0a1b2c3d.*\n.*lead words/m);
    assert.ok(!input.includes(LEAD_ID));
  });
});

// ---- where the model runs and what it is given ---------------------------------------------------------------------------

test('both sides run from the empty folder in the state folder, with the argv the setting builds and nothing from a stream in it', async () => {
  const { commandOf, loadSetting } = await reader();
  for (const side of ['pi', 'codex']) {
    await withDir(async (dir) => {
      const w = world(dir);
      w.setting({ ...DEFAULT, side });
      w.put(w.seatFile(), '');
      await w.pass({ now: T0 });
      appendFileSync(w.seatFile(), say('--dangerously-skip-permissions $(touch /tmp/x) ; rm -rf ~'));
      await w.pass({ now: T0 + 15 * MIN });
      const [call] = w.calls();
      assert.equal(call.name, side);
      const empty = join(w.state, 'reader/empty');
      assert.equal(call.cwd.replace(/^\/private/, ''), empty.replace(/^\/private/, ''));
      assert.deepEqual(readdirSync(empty), []);
      const want = commandOf(loadSetting(w.settingFile), { input: call.input, inputFile: call.argv.find((a) => a.startsWith('@'))?.slice(1), schemaFile: join(w.state, 'reader/schema.json'), empty, home: '/h' });
      assert.deepEqual(call.argv, want.args);
      if (side === 'pi') assert.ok(call.argv.find((a) => a.startsWith('@')).startsWith(`@${join(w.state, 'reader')}/`));
      assert.ok(call.input.includes('--dangerously-skip-permissions'), 'the stream text reaches the model as data');
      assert.ok(!call.argv.some((a) => a.includes('dangerously')));
    });
  }
});

test('a folder that is not empty gets no model call and one reader-failed folder line', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('words'));
    mkdirSync(join(w.state, 'reader/empty'), { recursive: true });
    writeFileSync(join(w.state, 'reader/empty/stray'), 'x');
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.deepEqual(w.calls(), []);
    assert.deepEqual(r.failed, ['folder']);
    assert.deepEqual(w.shape(), ['start reader-failed folder']);
    rmSync(join(w.state, 'reader/empty/stray'));
    await w.pass({ now: T0 + 30 * MIN });
    assert.equal(w.calls().length, 1);
    assert.deepEqual(w.shape(), ['start reader-failed folder', 'clear reader-failed folder']);
  });
});

test('a failed command, or one that outlasts the timeout, writes reader-failed command once and moves no cursor; the next good pass clears it', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    const before = w.cursors();
    appendFileSync(w.seatFile(), say('some words'));
    w.flag('fail');
    await w.pass({ now: T0 + 15 * MIN });
    await w.pass({ now: T0 + 30 * MIN });
    assert.deepEqual(w.shape(), ['start reader-failed command']);
    assert.deepEqual(w.cursors(), before);
    assert.doesNotMatch(readFileSync(join(w.state, 'events.jsonl'), 'utf8'), /ghp_/);
    w.unflag('fail');
    w.flag('hang');
    const t = Date.now();
    const r = await w.pass({ now: T0 + 45 * MIN, timeoutMs: 400 });
    assert.deepEqual(r.failed, ['command']);
    assert.ok(Date.now() - t < 10_000);
    assert.deepEqual(w.cursors(), before);
    w.unflag('hang');
    await w.pass({ now: T0 + 60 * MIN });
    assert.deepEqual(w.shape(), ['start reader-failed command', 'clear reader-failed command']);
    assert.equal(w.cursors()['issue-333/run-fix9.jsonl'], statSync(w.seatFile()).size);
  });
});

test('a call that outlasts the timeout ends the pass even when a grandchild holds the pipes, and leaves no lock', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('some words'));
    w.flag('tree');
    const t = Date.now();
    try {
      const r = await w.pass({ now: T0 + 15 * MIN, timeoutMs: 2500 });
      assert.ok(Date.now() - t < 20_000, 'the pass ended well within the grandchild\'s 60 s sleep');
      assert.deepEqual(r.failed, ['command']);
      assert.deepEqual(w.shape(), ['start reader-failed command']);
      assert.ok(!existsSync(join(w.state, 'reader.lock')));
      const pid = Number(readFileSync(join(w.q, 'grandchild'), 'utf8'));
      let alive = true;
      for (let i = 0; i < 50 && alive; i += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((res) => setTimeout(res, 100));
        } catch {
          alive = false;
        }
      }
      assert.ok(!alive, 'the whole process group was killed');
    } finally {
      // Whatever happened, no sleep outlives the test.
      try {
        process.kill(Number(readFileSync(join(w.q, 'grandchild'), 'utf8')), 'SIGKILL');
      } catch {
        // gone already
      }
    }
  });
});

test('a timer that fires after the child exited, with a grandchild in another session holding the pipes, still ends the pass', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('some words'));
    w.flag('orphan');
    const t = Date.now();
    try {
      const r = await w.pass({ now: T0 + 15 * MIN, timeoutMs: 1500 });
      assert.ok(Date.now() - t < 20_000, 'the pass ended well within the grandchild\'s 60 s sleep');
      assert.deepEqual(r.failed, ['command']);
      assert.deepEqual(w.shape(), ['start reader-failed command']);
      assert.ok(!existsSync(join(w.state, 'reader.lock')));
    } finally {
      try {
        process.kill(Number(readFileSync(join(w.q, 'grandchild'), 'utf8')), 'SIGKILL');
      } catch {
        // gone already
      }
    }
  });
});

test('a failed second call keeps the cursors of the first call and moves none of the others', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    const names = ['issue-a', 'issue-b', 'issue-c'];
    for (const n of names) w.put(w.seatFile(n), '');
    await w.pass({ now: T0 });
    // One line of about 300,000 characters each: no two fit in one call.
    for (const n of names) appendFileSync(w.seatFile(n), say('word '.repeat(60_000)));
    writeFileSync(join(w.q, 'answer-2.txt'), 'this is not JSON');
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.equal(w.calls().length, 2, 'the pass stopped at the second call');
    assert.deepEqual(r.failed, ['answer']);
    assert.deepEqual(w.shape(), ['start reader-failed answer']);
    const c = w.cursors();
    assert.equal(c['issue-a/run-fix9.jsonl'], statSync(w.seatFile('issue-a')).size, 'call 1 had been answered');
    assert.equal(c['issue-b/run-fix9.jsonl'], 0);
    assert.equal(c['issue-c/run-fix9.jsonl'], 0);
  });
});

// ---- the cursor -----------------------------------------------------------------------------------------------------------

test('the first pass ever sends nothing and puts every stream at its end; a stream that appears later is read from its start', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), say('OLD seat words'));
    w.put(w.leadFile(), say('OLD lead words'));
    const first = await w.pass({ now: T0 });
    assert.equal(first.calls, 0);
    assert.deepEqual(w.calls(), []);
    assert.deepEqual(w.cursors(), { 'issue-333/run-fix9.jsonl': statSync(w.seatFile()).size, 'app-lead/transcripts/0a1b2c3d-1111-2222-3333-444455556666.jsonl': statSync(w.leadFile()).size });
    appendFileSync(w.seatFile(), say('NEW seat words'));
    w.put(w.seatFile('issue-400', 'build'), say('BRAND NEW stream words'));
    await w.pass({ now: T0 + 15 * MIN });
    const [call] = w.calls();
    assert.ok(call.input.includes('NEW seat words') && call.input.includes('BRAND NEW stream words'));
    assert.ok(!call.input.includes('OLD'));
    await w.pass({ now: T0 + 30 * MIN });
    assert.equal(w.calls().length, 1, 'nothing grew, so nothing is sent');
  });
});

test('only whole lines are read: a last line with no newline waits for the next pass', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    const whole = say('WHOLE line words');
    const next = say('LATER line words');
    appendFileSync(w.seatFile(), whole + next.slice(0, 40));
    await w.pass({ now: T0 + 15 * MIN });
    assert.ok(w.calls()[0].input.includes('WHOLE line words'));
    assert.equal(w.cursors()['issue-333/run-fix9.jsonl'], Buffer.byteLength(whole));
    appendFileSync(w.seatFile(), next.slice(40));
    await w.pass({ now: T0 + 30 * MIN });
    assert.ok(w.calls()[1].input.includes('LATER line words'));
    assert.ok(!w.calls()[1].input.includes('WHOLE line words'));
    assert.equal(w.cursors()['issue-333/run-fix9.jsonl'], Buffer.byteLength(whole + next));
  });
});

test('a stream that shrank starts again from 0', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), say('a long first version of the stream, long enough to be longer'));
    await w.pass({ now: T0 });
    w.put(w.seatFile(), say('short'));
    await w.pass({ now: T0 + 15 * MIN });
    assert.ok(w.calls()[0].input.includes('short'));
  });
});

test('a stream with nothing of the assistant\'s in what it grew by sends nothing, and its cursor moves', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), user('only a tool result'));
    await w.pass({ now: T0 + 15 * MIN });
    assert.deepEqual(w.calls(), []);
    assert.equal(w.cursors()['issue-333/run-fix9.jsonl'], statSync(w.seatFile()).size);
  });
});

test('a pass sends at most 400,000 characters a call and makes at most 3 calls; what is left waits for the next pass', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    const line = say('word '.repeat(1_800));
    const lines = 150;
    appendFileSync(w.seatFile(), line.repeat(lines));
    await w.pass({ now: T0 + 15 * MIN });
    const calls = w.calls();
    assert.equal(calls.length, 3);
    for (const c of calls) assert.ok(c.input.length <= 400_000, `${c.input.length}`);
    const cursor = w.cursors()['issue-333/run-fix9.jsonl'];
    assert.ok(cursor > 0 && cursor < statSync(w.seatFile()).size && cursor % Buffer.byteLength(line) === 0, 'the cursor is at a line end short of the end');
    await w.pass({ now: T0 + 30 * MIN });
    assert.equal(w.calls().length, 3 + 1, 'the rest goes in one more call');
    assert.equal(w.cursors()['issue-333/run-fix9.jsonl'], statSync(w.seatFile()).size);
  });
});

test('an event that quotes a seat\'s StructuredOutput report is kept by the quote check', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), fixture('seat-report.jsonl'));
    w.answer({ events: [{ kind: 'admits-mistake', session: 'issue-333 fix9', quote: 'I ran the full suite once although the brief said not to.', why: 'a lapse in its report' }] });
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.deepEqual(r.failed, []);
    assert.equal(r.events, 1);
    assert.deepEqual(w.shape(), ['start admits-mistake issue-333 fix9']);
    assert.ok(w.calls()[0].input.includes('I ran the full suite once'));
  });
});

// ---- the pass: lock and crash ---------------------------------------------------------------------------------------------

test('a pass writes reader/last.json with its counts, a crashed one too, and one that found the lock taken writes nothing', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    const last = () => JSON.parse(readFileSync(join(w.state, 'reader/last.json'), 'utf8'));
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    assert.deepEqual(last(), { at: new Date(T0).toISOString(), status: 'ok', calls: 0, events: 0, failed: [], chars: 0 });
    appendFileSync(w.seatFile(), fixture('seat-report.jsonl'));
    w.answer({ events: [
      { kind: 'admits-mistake', session: 'issue-333 fix9', quote: 'I ran the full suite once although the brief said not to.', why: 'w' },
      { kind: 'drift', session: 'issue-333 fix9', quote: 'invented text', why: 'w' },
    ] });
    await w.pass({ now: T0 + 15 * MIN });
    const sent = w.calls()[0].input.length;
    assert.ok(sent > 0);
    assert.deepEqual(last(), { at: new Date(T0 + 15 * MIN).toISOString(), status: 'ok', calls: 1, events: 1, failed: ['answer'], chars: sent });
    const { takeLock } = await import('../bin/lib/queue.mjs');
    const mine = takeLock(join(w.state, 'reader.lock'));
    assert.ok(mine);
    assert.equal((await w.pass({ now: T0 + 30 * MIN })).status, 'running');
    assert.equal(last().at, new Date(T0 + 15 * MIN).toISOString(), 'a pass that found the lock taken wrote nothing');
    rmSync(join(w.state, 'reader.lock'));
    rmSync(join(w.state, 'reader/cursors.json'));
    mkdirSync(join(w.state, 'reader/cursors.json'));
    const r = await w.pass({ now: T0 + 45 * MIN });
    assert.equal(r.status, 'crashed');
    assert.deepEqual(last(), { at: new Date(T0 + 45 * MIN).toISOString(), status: 'crashed', calls: 0, events: 0, failed: [], chars: 0 });
  });
});

test('a pass holds reader.lock: a live holder stops another pass, and a lock whose pid is gone is stale', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('some words'));
    const { takeLock } = await import('../bin/lib/queue.mjs');
    const mine = takeLock(join(w.state, 'reader.lock'));
    assert.ok(mine);
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.equal(r.status, 'running');
    assert.deepEqual(w.calls(), []);
    rmSync(join(w.state, 'reader.lock'));
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((res) => dead.once('exit', res));
    writeFileSync(join(w.state, 'reader.lock'), JSON.stringify({ pid: dead.pid, start: 'x', host: 'h', token: 'deadbeef' }));
    const again = await w.pass({ now: T0 + 16 * MIN });
    assert.equal(again.status, 'ok');
    assert.equal(w.calls().length, 1);
    assert.ok(!existsSync(join(w.state, 'reader.lock')), 'the lock is released');
  });
});

test('a crash writes reader.failed and no event; the next pass that ends well removes it', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    rmSync(join(w.state, 'reader/cursors.json'));
    mkdirSync(join(w.state, 'reader/cursors.json'));
    const r = await w.pass({ now: T0 + 15 * MIN });
    assert.equal(r.status, 'crashed');
    assert.match(readFileSync(join(w.state, 'reader.failed'), 'utf8'), /^2026-|^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(w.events(), []);
    assert.ok(!existsSync(join(w.state, 'reader.lock')));
    rmSync(join(w.state, 'reader/cursors.json'), { recursive: true });
    writeFileSync(join(w.state, 'reader/cursors.json'), '{}\n');
    const ok = await w.pass({ now: T0 + 30 * MIN });
    assert.equal(ok.status, 'ok');
    assert.ok(!existsSync(join(w.state, 'reader.failed')));
  });
});

test('a pass reads only the runs folder: a profile folder beside it is never listed', async () => {
  await withDir(async (dir) => {
    const w = world(dir);
    mkdirSync(join(dir, '.agent-profiles/seats/1/claude/projects'), { recursive: true });
    writeFileSync(join(dir, '.agent-profiles/seats/1/claude/projects/x.jsonl'), say('PROFILE words'));
    w.put(w.seatFile(), '');
    await w.pass({ now: T0 });
    appendFileSync(w.seatFile(), say('seat words'));
    await w.pass({ now: T0 + 15 * MIN });
    assert.ok(!JSON.stringify(w.calls()).includes('PROFILE'));
    assert.deepEqual(Object.keys(w.cursors()), ['issue-333/run-fix9.jsonl']);
  });
});

// ---- the two writers ------------------------------------------------------------------------------------------------------

test('the sweep and the reader write the events file in turn: no seq repeats, none is lost', async () => {
  await withDir(async (dir) => {
    const state = join(dir, 'state');
    mkdirSync(state);
    const events = pathToFileURL(join(factory, 'bin/lib/events.mjs')).href;
    const script = (body) => `import * as e from ${JSON.stringify(events)};\n${body}`;
    const N = 40;
    const readerCode = script(`for (let i = 0; i < ${N}; i += 1) e.appendStart({ state: ${JSON.stringify(state)}, kind: 'drift', key: 'drift s' + i, text: 'line ' + i });`);
    const sweepCode = script(`for (let i = 0; i < ${N}; i += 1) e.record({ state: ${JSON.stringify(state)}, found: [{ key: 'gh-refused', scope: 'gh', text: 'x' }, { key: 'out-of-quota ' + i, scope: 'quota', text: 'q' + i }], read: new Set(['gh', 'quota']), now: 1000 + i });`);
    const run = (code) => new Promise((res) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'inherit', 'inherit'] });
      c.once('exit', (status) => res(status));
    });
    const codes = await Promise.all([run(readerCode), run(readerCode), run(sweepCode)]);
    assert.deepEqual(codes, [0, 0, 0]);
    const lines = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const seqs = lines.map((l) => l.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'the file is in seq order');
    assert.equal(new Set(seqs).size, seqs.length, 'no seq repeats');
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'no seq is skipped');
    assert.equal(lines.filter((l) => l.kind === 'drift').length, 2 * N);
    assert.equal(lines.filter((l) => l.key === 'gh-refused' && l.type === 'start').length, 1);
    assert.equal(lines.filter((l) => l.kind === 'out-of-quota' && l.type === 'start').length, N);
    assert.equal(JSON.parse(readFileSync(join(state, 'events-active.json'), 'utf8')).seq, lines.length);
    assert.ok(!existsSync(join(state, 'events.lock')), 'the lock is released');
  });
});

// ---- when the sweep starts a pass -----------------------------------------------------------------------------------------

test('the sweep starts a pass when 15 minutes have passed since the last began and none runs, and never waits for it', async () => {
  const { startReader } = await import('../bin/lib/queue.mjs');
  await withDir(async (dir) => {
    const state = join(dir, 'state');
    const runs = join(dir, 'runs');
    mkdirSync(state);
    mkdirSync(join(runs, 'issue-333'), { recursive: true });
    const started = [];
    const spawnFn = (cmd, args, opts) => {
      started.push({ cmd, args, opts });
      return { unref() {}, on() {} };
    };
    const env = { HOME: '/h', PATH: '/opt/homebrew/bin:/usr/bin' };
    const go = (now) => startReader({ state, runs, now, spawnFn, env });
    assert.equal(go(T0), false, 'no stream exists to read');
    writeFileSync(join(runs, 'issue-333/run-fix9.jsonl'), '');
    assert.equal(go(T0), true, 'none began yet');
    assert.equal(started.length, 1);
    assert.equal(started[0].cmd, process.execPath);
    assert.ok(started[0].args[0].endsWith('/reader.mjs') || started[0].args[0].endsWith('/factory-reader'));
    assert.equal(started[0].opts.detached, true);
    assert.equal(started[0].opts.stdio, 'ignore');
    assert.equal(started[0].opts.env, env, 'the sweep\'s own environment, unchanged');
    assert.equal(go(T0 + 14 * MIN + 59_000), false);
    assert.equal(go(T0 + 15 * MIN), true);
    assert.equal(started.length, 2);
    const { takeLock } = await import('../bin/lib/queue.mjs');
    const lock = takeLock(join(state, 'reader.lock'));
    assert.ok(lock);
    assert.equal(go(T0 + 40 * MIN), false, 'a pass is running');
    rmSync(join(state, 'reader.lock'));
    const dead = spawn(process.execPath, ['-e', '0']);
    await new Promise((res) => dead.once('exit', res));
    writeFileSync(join(state, 'reader.lock'), JSON.stringify({ pid: dead.pid, start: 'x', host: 'h', token: 'deadbeef' }));
    assert.equal(go(T0 + 40 * MIN), true, 'a lock whose pid is gone is stale');
    assert.equal(started.length, 3);
  });
});

test('a sweep starts the pass detached and returns at once, with the gh calls it had before, and a second sweep within 15 minutes starts none', () => {
  withDir((dir) => {
    // The world's bin holds the fake pi and codex; the fake gh joins them, so a pass this sweep starts never reaches a real model.
    const w = world(dir);
    mkdirSync(join(dir, 'home'));
    w.put(w.seatFile(), say('words'));
    writeFileSync(join(dir, 'bin/gh'), '#!/bin/sh\necho "$*" >>"$Q/calls"\ncase "$*" in\n  "api user"*) echo agent-bot ;;\n  *graphql*) echo \'{"data":{"repository":{"issues":{"nodes":[]},"pullRequests":{"nodes":[]}}}}\' ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n');
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const state = join(dir, 'state');
    const sweep = () =>
      spawnSync(join(factory, 'bin/factory-queue'), ['sweep', '--repo', 'o/app'], {
        encoding: 'utf8',
        env: { ...w.env, HOME: join(dir, 'home'), FACTORY_STATE: state, FACTORY_RUNS: join(dir, 'runs'), AGENT_PROFILES: join(dir, 'profiles'), FACTORY_ROOT: join(dir, 'root') },
      });
    const r = sweep();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(w.q, 'calls'), 'utf8').split('\n').filter((l) => /^(api|pr|run|issue|repo) /.test(l)).length, 3);
    assert.ok(existsSync(join(state, 'reader/started')));
    const until = Date.now() + 15_000;
    while ((!existsSync(join(state, 'reader/cursors.json')) || existsSync(join(state, 'reader.lock'))) && Date.now() < until) spawnSync('sleep', ['0.1']);
    assert.ok(existsSync(join(state, 'reader/cursors.json')), 'the first pass ran and put the stream at its end');
    assert.ok(!existsSync(join(state, 'reader.lock')));
    const began = readFileSync(join(state, 'reader/started'), 'utf8');
    assert.equal(sweep().status, 0);
    assert.equal(readFileSync(join(state, 'reader/started'), 'utf8'), began, 'no second pass within 15 minutes');
  });
});

// ---- --try ----------------------------------------------------------------------------------------------------------------

test('factory-reader --try reduces one file, sends it once to the side named, prints the answer and the quote check, and writes nothing', async () => {
  for (const side of ['pi', 'codex']) {
    await withDir(async (dir) => {
      const w = world(dir);
      w.answer({ events: [
        { kind: 'struggling', session: 'try seat-str', quote: 'going in circles on the same flaky test', why: 'repeats' },
        { kind: 'drift', session: 'try seat-str', quote: 'a quote that was never in the input', why: 'w' },
      ] });
      const file = join(dir, 'seat-stream.jsonl');
      writeFileSync(file, fixture('seat-stream.jsonl'));
      const before = readdirSync(dir).sort();
      const r = spawnSync(join(factory, 'bin/factory-reader'), ['--try', file, '--side', side], { encoding: 'utf8', env: { ...w.env, FACTORY_STATE: w.state, HOME: join(dir, 'home') } });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const calls = w.calls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, side);
      assert.ok(calls[0].input.includes('going in circles'));
      assert.ok(!calls[0].input.includes('TOOL-OUTPUT-MARKER'));
      assert.match(r.stdout, /going in circles on the same flaky test/);
      assert.match(r.stdout, /a quote that was never in the input/);
      assert.match(r.stdout, /dropped/i);
      assert.deepEqual(readdirSync(w.state), [], 'no event, lock, cursor or folder is written to the state folder');
      assert.deepEqual(readdirSync(dir).sort(), before, 'and nothing else is left behind');
    });
  }
});

test('factory-reader --try refuses a side that is not pi or codex', () => {
  withDir((dir) => {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, fixture('seat-stream.jsonl'));
    const r = spawnSync(join(factory, 'bin/factory-reader'), ['--try', file, '--side', 'agy'], { encoding: 'utf8', env: { ...process.env, FACTORY_STATE: join(dir, 'state') } });
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(dir, 'state')));
  });
});
