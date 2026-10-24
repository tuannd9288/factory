// bin/factory-alerts (#24): the SessionStart hook that tells the Human, at once, about every *.failed file in the
// state folder. It prints one JSON object (or plain lines with --text), prints nothing when all is well or
// FACTORY_NO_ALERTS=1 is set, and always exits 0, so a hook never blocks a session. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

function withState(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-'));
  try {
    for (const [name, [text, when]] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
      utimesSync(join(dir, name), new Date(when), new Date(when));
    }
    const alerts = (args = [], env = {}) => {
      const { FACTORY_NO_ALERTS, ...outer } = process.env;
      const r = spawnSync(join(factory, 'bin/factory-alerts'), args, { encoding: 'utf8', env: { ...outer, FACTORY_STATE: dir, TZ: 'UTC', ...env } });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    body({ dir, alerts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TWO = {
  'claude-canary.failed': ['2026-10-24T06:00:00Z claude 2.1.310 failed the probe; the launcher stays on 2.1.309\nFAIL git tag x refused\n', '2026-10-24T06:05:00Z'],
  'queue-o-app.failed': ['2026-10-23T22:00:00Z o/app: gh timed out\n', '2026-10-23T22:01:00Z'],
  'queue-o-app.ok': ['2026-10-24T05:00:00Z\n', '2026-10-24T05:00:00Z'],
};

test('with no *.failed file it prints nothing and exits 0, also when the state folder does not exist', () => {
  withState({ 'queue-o-app.ok': ['2026-10-24T05:00:00Z\n', '2026-10-24T05:00:00Z'] }, ({ alerts }) => {
    assert.deepEqual(alerts(), { code: 0, out: '', err: '' });
    assert.deepEqual(alerts(['--text']), { code: 0, out: '', err: '' });
  });
  withState({}, ({ dir, alerts }) => {
    assert.deepEqual(alerts([], { FACTORY_STATE: join(dir, 'absent') }), { code: 0, out: '', err: '' });
  });
});

test('two failed files give one JSON object: a line each for the Human, and the same lines for Claude to tell first', () => {
  withState(TWO, ({ alerts }) => {
    const r = alerts();
    assert.equal(r.code, 0, r.err);
    const o = JSON.parse(r.out);
    const lines = [
      'factory: claude-canary.failed (2026-10-24 06:05): 2026-10-24T06:00:00Z claude 2.1.310 failed the probe; the launcher stays on 2.1.309',
      'factory: queue-o-app.failed (2026-10-23 22:01): 2026-10-23T22:00:00Z o/app: gh timed out',
    ];
    assert.equal(o.systemMessage, lines.join('\n'), 'a line per .failed file, by name; the .ok file is no alert, and only the first line is shown');
    assert.equal(o.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(o.hookSpecificOutput.additionalContext.endsWith(lines.join('\n')));
    assert.match(o.hookSpecificOutput.additionalContext, /Tell the Human[^]*before anything else/i);
    assert.deepEqual(Object.keys(o).sort(), ['hookSpecificOutput', 'systemMessage']);
  });
});

test('the time is the file\'s mtime in local time, and a first line is cut at 200 characters', () => {
  withState({ 'queue-run.failed': [`${'x'.repeat(300)}\nsecond\n`, '2026-01-02T03:04:00Z'] }, ({ alerts }) => {
    assert.equal(JSON.parse(alerts().out).systemMessage, `factory: queue-run.failed (2026-01-02 03:04): ${'x'.repeat(200)}`);
    assert.equal(JSON.parse(alerts([], { TZ: 'Asia/Ho_Chi_Minh' }).out).systemMessage, `factory: queue-run.failed (2026-01-02 10:04): ${'x'.repeat(200)}`);
  });
});

test('FACTORY_NO_ALERTS=1 keeps a measured session clean: nothing is printed, with or without --text', () => {
  withState(TWO, ({ alerts }) => {
    assert.deepEqual(alerts([], { FACTORY_NO_ALERTS: '1' }), { code: 0, out: '', err: '' });
    assert.deepEqual(alerts(['--text'], { FACTORY_NO_ALERTS: '1' }), { code: 0, out: '', err: '' });
  });
});

test('--text prints the plain lines for a shell', () => {
  withState(TWO, ({ alerts }) => {
    const r = alerts(['--text']);
    assert.equal(r.code, 0);
    assert.equal(r.out, 'factory: claude-canary.failed (2026-10-24 06:05): 2026-10-24T06:00:00Z claude 2.1.310 failed the probe; the launcher stays on 2.1.309\nfactory: queue-o-app.failed (2026-10-23 22:01): 2026-10-23T22:00:00Z o/app: gh timed out\n');
  });
});

test('a state folder it cannot read gives one systemMessage that says so, and still exits 0', () => {
  withState({ 'not-a-folder': ['x', '2026-10-24T00:00:00Z'] }, ({ dir, alerts }) => {
    const path = join(dir, 'not-a-folder');
    const r = alerts([], { FACTORY_STATE: path });
    assert.equal(r.code, 0, r.err);
    const o = JSON.parse(r.out);
    assert.deepEqual(Object.keys(o), ['systemMessage']);
    assert.match(o.systemMessage, new RegExp(`^factory: cannot read the state folder ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    assert.match(alerts(['--text'], { FACTORY_STATE: path }).out, /^factory: cannot read the state folder /);
  });
});
