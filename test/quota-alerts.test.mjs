// bin/factory-alerts and the quota (#63): at session start it names a window Claude Code rejected, and one Claude Code itself
// warns of, while it has not yet reset. A use alone, however high, gives nothing: the factory keeps no threshold of its own
// (#194). A window that was never reported, or has reset since, gives nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factory } from './helpers.mjs';

const fixturePath = (name) => fileURLToPath(new URL(`./fixtures/quota/${name}`, import.meta.url));
const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

/** A recorded event with its windows set: the use of each and the seconds from now at which each resets. */
function eventLine(base, { five, seven, fiveIn = HOUR, sevenIn = 24 * HOUR }) {
  const e = JSON.parse(readFileSync(fixturePath(base), 'utf8'));
  const w = e.rate_limit_info.unifiedWindows;
  Object.assign(w.five_hour, { utilization: five ?? w.five_hour.utilization, resetsAt: nowSec() + fiveIn });
  Object.assign(w.seven_day, { utilization: seven ?? w.seven_day.utilization, resetsAt: nowSec() + sevenIn });
  return `${JSON.stringify(e)}\n`;
}

function world(body) {
  const dir = mkdtempSync(join(tmpdir(), 'quota-alerts-'));
  const [state, runs] = [join(dir, 'state'), join(dir, 'runs')];
  mkdirSync(state);
  mkdirSync(runs);
  const log = (seatNo, line) => {
    mkdirSync(join(runs, `issue-${seatNo}`), { recursive: true });
    writeFileSync(join(runs, `issue-${seatNo}`, 'run-worker.jsonl'), `{"type":"system","subtype":"init"}\n${line}`);
    writeFileSync(join(runs, `issue-${seatNo}`, 'run-worker.seat'), `${seatNo}\n`);
  };
  const alerts = (args = ['--text'], env = {}) => {
    const { FACTORY_NO_ALERTS, FACTORY_STATUSLINE, ...outer } = process.env;
    const r = spawnSync(join(factory, 'bin/factory-alerts'), args, { encoding: 'utf8', env: { ...outer, FACTORY_STATE: state, FACTORY_RUNS: runs, TZ: 'UTC', ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter(Boolean) };
  };
  try {
    body({ dir, state, runs, log, alerts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a rejected window is named with its seat, and nothing else: its seven-day use of 0.74 gives no line', () => {
  world(({ log, alerts }) => {
    log(1, eventLine('synthetic-rejected-event.jsonl', {}));
    const r = alerts();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 1, r.out);
    assert.match(r.lines[0], /seat 1.*five-hour.*rejected/);
  });
});

test('a use alone gives no line on either seat, in either window: 0.99 of the week, then 0.99 of five hours (#194)', () => {
  world(({ log, alerts }) => {
    for (const seatNo of [1, 2]) {
      log(seatNo, eventLine('synthetic-high-week-event.jsonl', { seven: 0.99, five: 0.1 }));
      assert.deepEqual(alerts(), { code: 0, out: '', err: '', lines: [] });
      log(seatNo, eventLine('synthetic-high-week-event.jsonl', { seven: 0.1, five: 0.99 }));
      assert.deepEqual(alerts(), { code: 0, out: '', err: '', lines: [] });
    }
  });
});

test('a window that has reset since the report gives nothing, rejected or not', () => {
  world(({ log, alerts }) => {
    log(1, eventLine('synthetic-rejected-event.jsonl', { fiveIn: -HOUR, sevenIn: -HOUR }));
    assert.equal(alerts().out, '');
  });
});

test('a seat that no session has run on gives nothing: no guess', () => {
  world(({ alerts }) => {
    assert.deepEqual(alerts(), { code: 0, out: '', err: '', lines: [] });
  });
});

test('a status-line file gives no line for its use: its five-hour 93% is not named (#194)', () => {
  world(({ dir, alerts }) => {
    const file = join(dir, 'sl.jsonl');
    const r0 = JSON.parse(readFileSync(fixturePath('synthetic-statusline.jsonl'), 'utf8'));
    r0.rate_limits.five_hour.resets_at = nowSec() + HOUR;
    r0.rate_limits.seven_day.resets_at = nowSec() + 24 * HOUR;
    writeFileSync(file, `${JSON.stringify(r0)}\n`);
    assert.deepEqual(alerts(['--text'], { FACTORY_STATUSLINE: file }), { code: 0, out: '', err: '', lines: [] });
  });
});

test('the JSON the hook prints carries the quota lines beside a *.failed line, to the Human and to Claude', () => {
  world(({ state, log, alerts }) => {
    writeFileSync(join(state, 'queue-o-app.failed'), 'o/app: gh timed out\n');
    log(1, eventLine('synthetic-rejected-event.jsonl', {}));
    const o = JSON.parse(alerts([]).out);
    assert.match(o.systemMessage, /queue-o-app\.failed/);
    assert.match(o.systemMessage, /seat 1.*rejected/);
    assert.match(o.hookSpecificOutput.additionalContext, /seat 1.*rejected/);
  });
});

test('FACTORY_NO_ALERTS=1 silences the quota lines, and a runs folder that cannot be read never fails the hook', () => {
  world(({ runs, log, alerts }) => {
    log(1, eventLine('synthetic-rejected-event.jsonl', {}));
    assert.equal(alerts(['--text'], { FACTORY_NO_ALERTS: '1' }).out, '');
    rmSync(runs, { recursive: true });
    writeFileSync(runs, 'a file, not a folder');
    assert.deepEqual(alerts(), { code: 0, out: '', err: '', lines: [] });
  });
});

// Fix round 1 (#63): Claude Code's own warning (status allowed_warning, 0.75), one number per seat, a reset for any type.

/** The recorded warning event with its seven-day use and the seconds from now at which that window (and the event) resets. */
function warningLine({ seven = 0.78, five = 0.3, sevenIn = 24 * HOUR }) {
  const e = JSON.parse(readFileSync(fixturePath('real-warning-event.jsonl'), 'utf8'));
  const i = e.rate_limit_info;
  i.unifiedWindows.five_hour.utilization = five;
  i.unifiedWindows.five_hour.resetsAt = nowSec() + 48 * HOUR;
  Object.assign(i.unifiedWindows.seven_day, { utilization: seven, resetsAt: nowSec() + sevenIn });
  i.utilization = seven;
  i.resetsAt = nowSec() + sevenIn;
  return `${JSON.stringify(e)}\n`;
}

test('an allowed_warning window is named once, with its seat, window and reset', () => {
  world(({ log, alerts }) => {
    log(2, warningLine({}));
    const r = alerts();
    assert.equal(r.lines.length, 1, r.out);
    assert.match(r.lines[0], /seat 2.*seven-day.*warning.*78%.*resets/);
  });
});

test('the warning line goes away once the window\'s reset has passed', () => {
  world(({ log, alerts }) => {
    log(2, warningLine({ sevenIn: -HOUR }));
    assert.equal(alerts().out, '');
  });
});

// The guard above ("a runs folder that cannot be read never fails the hook") cannot fail alone: the hook's outer catch also
// gives empty output. What quotaLines' own catch protects is the *.failed lines, which a bad runs folder must not hide.
test('a runs folder that cannot be read leaves the *.failed lines printed', () => {
  world(({ state, runs, alerts }) => {
    writeFileSync(join(state, 'queue-o-app.failed'), 'o/app: gh timed out\n');
    rmSync(runs, { recursive: true });
    writeFileSync(runs, 'a file, not a folder');
    const r = alerts();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 1, r.out);
    assert.match(r.lines[0], /queue-o-app\.failed.*gh timed out/);
  });
});

test('a rejected event of another rateLimitType expires at the event\'s own resetsAt', () => {
  const opus = (inSeconds) => {
    const e = JSON.parse(eventLine('synthetic-rejected-event.jsonl', { five: 0.1, seven: 0.1 }));
    e.rate_limit_info.rateLimitType = 'seven_day_opus';
    e.rate_limit_info.resetsAt = nowSec() + inSeconds;
    return `${JSON.stringify(e)}\n`;
  };
  world(({ log, alerts }) => {
    log(1, opus(-HOUR));
    assert.equal(alerts().out, '');
    log(1, opus(HOUR));
    assert.match(alerts().out, /seat 1.*rejected.*resets/);
  });
});
