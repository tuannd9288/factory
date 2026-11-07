// What no agent may read (INN-39 item 2): each harness that runs here refuses each protected category and still reads what the work needs,
// probed on synthetic files against test/deny-probe.mjs's table, which is written apart from the lists the harnesses render. The MacBook
// Lead and Colly start claude in a child process: the same probe runs on their settings in test/factory-here.test.mjs and
// test/factory-colly.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, sandboxSettings } from '../bin/lib/seat.mjs';
import { leadArgs } from '../packs/pstack/bin/lead.mjs';
import { permissionArgs } from '../packs/pstack/bin/codex-step.mjs';
import { mismatches, probeWorld, refusedCodex, refusedRead, refusedSandbox } from './deny-probe.mjs';

const PROFILES = '/Volumes/other/agent-profiles';

/** The rules that follow `flag` in an argv, up to the next option. */
const after = (argv, flag) => {
  const from = argv.indexOf(flag) + 1;
  const end = argv.findIndex((a, i) => i >= from && a.startsWith('--'));
  return argv.slice(from, end === -1 ? undefined : end);
};

test('each harness refuses each protected category and still reads what the work needs, probed on synthetic files', () => {
  const w = probeWorld();
  try {
    const seat = after(buildArgs({ role: 'worker', run: '/r/run', work: w.work, home: w.home, profiles: PROFILES }), '--disallowedTools');
    const lead = after(leadArgs({ repo: 'app', team: 'lead', home: w.home, root: '/w', roleText: 'role', node: '/usr/bin/node' }).argv, '--disallowedTools');
    const shell = sandboxSettings({ home: w.home, run: '/r/run', work: w.work, profiles: PROFILES }).filesystem.denyRead;
    const args = permissionArgs({ home: w.home, profiles: PROFILES });
    const values = args.filter((_, i) => args[i - 1] === '-c');
    const name = /^default_permissions="([^"]+)"$/.exec(values.find((v) => v.startsWith('default_permissions=')))[1];
    const table = values.find((v) => v.startsWith(`permissions.${name}.filesystem=`));
    const codex = Object.entries(JSON.parse(table.slice(table.indexOf('=') + 1).replaceAll('"="', '":"'))).filter(([, mode]) => mode === 'deny').map(([p]) => p);
    assert.deepEqual(mismatches({
      'seat file': (p) => refusedRead(seat, p, w),
      'lead file': (p) => refusedRead(lead, p, w),
      'seat shell': (p) => refusedSandbox(shell, p),
      codex: (p) => refusedCodex(codex, p),
    }, w), []);
  } finally {
    w.done();
  }
});
