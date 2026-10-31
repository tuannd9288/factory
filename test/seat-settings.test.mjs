// bin/seat (#205): every session it starts runs bin/factory-alerts at its start, from the settings buildArgs passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import * as seat from '../bin/lib/seat.mjs';
import { factory } from './helpers.mjs';

for (const role of ['worker', 'reviewer', 'researcher']) {
  for (const n of [1, 2]) {
    test(`${role} on seat ${n}: one --settings, whose only hook is bin/factory-alerts at session start`, () => {
      const args = seat.buildArgs({ role, run: '/r/issue-1', home: '/h', work: '/r/w', seat: n, tokenPath: '/p/seats/1/oauth-token' });
      assert.equal(args.filter((a) => a === '--settings').length, 1);
      const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? 'null');
      const command = join(factory, 'bin/factory-alerts');
      assert.ok(isAbsolute(command));
      assert.deepEqual(settings, { hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command, timeout: 10 }] }] } });
    });
  }
}
