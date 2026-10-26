// bin/factory-alerts and the quota (#63): at session start it names a rejected window, and a window at or above a threshold
// that has not yet reset. A seat's seven-day threshold is the stop bin/seat uses (SEATS: 0.70 for seat 1, 0.90 for seat 2),
// since that is when the seat is no longer started; the five-hour window, which bin/seat does not stop on, and a status-line
// row, which names no seat, use 0.90. A window that was never reported, or has reset since, gives nothing.
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

test('a rejected window is named with its seat, and the seven-day use above the seat\'s stop is a line of its own', () => {
  world(({ log, alerts }) => {
    log(1, eventLine('synthetic-rejected-event.jsonl', {}));
    const r = alerts();
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 2, r.out);
    assert.ok(r.lines.some((l) => /seat 1/.test(l) && /five-hour/.test(l) && /rejected/.test(l)), r.out);
    assert.ok(r.lines.some((l) => /seat 1/.test(l) && /seven-day/.test(l) && /74%/.test(l) && /70%/.test(l)), r.out);
  });
});

test('the seven-day threshold is the seat\'s own stop: 0.74 is over seat 1\'s 0.70 and under seat 2\'s 0.90', () => {
  world(({ log, alerts }) => {
    log(2, eventLine('synthetic-high-week-event.jsonl', {}));
    assert.deepEqual(alerts(), { code: 0, out: '', err: '', lines: [] });
    log(1, eventLine('synthetic-high-week-event.jsonl', {}));
    assert.equal(alerts().lines.length, 1);
  });
});

test('seat 2 is named at its stop of 0.90 and not at 0.89', () => {
  world(({ log, alerts }) => {
    log(2, eventLine('synthetic-high-week-event.jsonl', { seven: 0.89 }));
    assert.equal(alerts().out, '');
    log(2, eventLine('synthetic-high-week-event.jsonl', { seven: 0.9 }));
    assert.match(alerts().out, /seat 2.*seven-day.*90%/);
  });
});

test('the five-hour window is named from 0.90', () => {
  world(({ log, alerts }) => {
    log(2, eventLine('synthetic-high-week-event.jsonl', { five: 0.89, seven: 0.1 }));
    assert.equal(alerts().out, '');
    log(2, eventLine('synthetic-high-week-event.jsonl', { five: 0.9, seven: 0.1 }));
    assert.match(alerts().out, /seat 2.*five-hour.*90%/);
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

test('a status-line file that was given is read too: its five-hour 93% is named, its seven-day 41% is not', () => {
  world(({ dir, alerts }) => {
    const file = join(dir, 'sl.jsonl');
    const r0 = JSON.parse(readFileSync(fixturePath('synthetic-statusline.jsonl'), 'utf8'));
    r0.rate_limits.five_hour.resets_at = nowSec() + HOUR;
    r0.rate_limits.seven_day.resets_at = nowSec() + 24 * HOUR;
    writeFileSync(file, `${JSON.stringify(r0)}\n`);
    const r = alerts(['--text'], { FACTORY_STATUSLINE: file });
    assert.equal(r.lines.length, 1, r.out);
    assert.match(r.lines[0], /sl\.jsonl.*five-hour.*93%/);
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

test('an allowed_warning window is named once, with its seat, window and reset, though it is under the seat\'s stop', () => {
  world(({ log, alerts }) => {
    log(2, warningLine({}));
    const r = alerts();
    assert.equal(r.lines.length, 1, r.out);
    assert.match(r.lines[0], /seat 2.*seven-day.*warning.*78%.*resets/);
  });
});

test('an allowed_warning window over the seat\'s stop is one line, not a warning line and a threshold line', () => {
  world(({ log, alerts }) => {
    log(1, warningLine({}));
    assert.equal(alerts().lines.length, 1);
  });
});

test('the warning line goes away once the window\'s reset has passed', () => {
  world(({ log, alerts }) => {
    log(2, warningLine({ sevenIn: -HOUR }));
    assert.equal(alerts().out, '');
  });
});

test('both windows of a seat alert at that seat\'s own stop: seat 1 from 0.70, seat 2 from 0.90, five-hour included', () => {
  world(({ log, alerts }) => {
    log(1, eventLine('synthetic-high-week-event.jsonl', { five: 0.69, seven: 0.1 }));
    assert.equal(alerts().out, '');
    log(1, eventLine('synthetic-high-week-event.jsonl', { five: 0.7, seven: 0.1 }));
    assert.match(alerts().out, /seat 1.*five-hour.*70%/);
  });
  world(({ log, alerts }) => {
    log(2, eventLine('synthetic-high-week-event.jsonl', { five: 0.79, seven: 0.1 }));
    assert.equal(alerts().out, '');
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
