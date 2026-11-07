import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quotaRows, alertLines } from '../bin/lib/quota.mjs';
import { observe, readLines } from '../bin/lib/events.mjs';

test('Codex hand-run refusals reach quota alerts and events; capacity is softer and a manual move is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-quota-'));
  const runs = join(dir, 'runs');
  const run = join(runs, 'example', 'peer');
  const state = join(dir, 'state');
  const now = Date.parse('2026-11-06T04:00:00Z');
  const resetsAt = Date.parse('2099-11-06T06:00:00Z') / 1000;
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'run.account'), 'fictional-first\n');
  writeFileSync(join(run, 'run.seat'), 'peer\n');
  const log = (records) => writeFileSync(join(run, 'run.jsonl'), records.map(JSON.stringify).join('\n') + '\n{torn');
  const rows = () => quotaRows({ runs, accounts: [] });
  const sweep = () => observe({ state, runs, agentProfiles: join(dir, 'profiles'), reads: new Map(), processes: () => [], now });
  const starts = () => readLines(state).filter((e) => e.type === 'start');
  try {
    log([{ type: 'turn.failed', error: { message: "You've hit your usage limit", resets_at: resetsAt } }]);
    assert.match(alertLines(rows(), { now }).join('\n'), /quota: account fictional-first, seat peer:.*rejected.*2099-11-06 06:00/);
    sweep();
    sweep();
    assert.equal(starts().filter((e) => e.kind === 'out-of-quota').length, 1);
    assert.match(starts()[0].text, /fictional-first.*peer.*2099-11-06 06:00/);
    log([{ type: 'error', message: 'Model at capacity' }, { type: 'turn.failed', error: { message: 'Model at capacity' } }]);
    assert.equal(alertLines(rows(), { now }).some((l) => l.includes('quota:')), false);
    assert.match(alertLines(rows(), { now }).join('\n'), /capacity/);
    sweep();
    assert.equal(starts().filter((e) => e.kind === 'model-at-capacity').length, 1);
    writeFileSync(join(run, 'run.account'), 'fictional-second\n');
    log([{ type: 'turn.completed', usage: {} }]);
    sweep();
    sweep();
    const moves = starts().filter((e) => e.kind === 'account-moved');
    assert.equal(moves.length, 1);
    assert.match(moves[0].text, /peer.*fictional-first.*fictional-second/);
    log([{ type: 'error', message: 'Usage limit reached. Try again at 09:00 UTC.' }]);
    assert.match(alertLines(rows(), { now }).join('\n'), /rejected.*09:00 UTC/);
    log([{ type: 'turn.failed', error: { message: 'usage limit', resets_at: now / 1000 - 1 } }]);
    assert.deepEqual(alertLines(rows(), { now }), []);
    log([{ type: 'item.completed', item: { type: 'agent_message', text: 'usage limit' } }]);
    assert.deepEqual(alertLines(rows(), { now }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
