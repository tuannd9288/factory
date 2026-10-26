// The research eval's path check (#92, re-review 3, B1): a "$" in any form, outside single quotes, or a backtick, makes its word
// unplaceable, so outside. The review's cases: $VAR, ${VAR}, $(...), a backtick, ANSI-C quoting $'...' and $"...".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathWorld } from './research-eval-paths-world.mjs';

test('a "$" in any form, or a backtick, outside single quotes is outside', () => pathWorld((w) => {
  for (const command of [
    'wc -c $HOME/factory-runs/issue-92/report-worker.md',
    'wc -c ${HOME}/factory-runs/issue-92/report-worker.md',
    'wc -c $(echo /etc/hosts)',
    'wc -c `echo x`',
    "wc -c $'\\x2f'etc/hosts",
    'cat $"/etc/hosts"',
    'cat "$HOME"/x',
    'echo $1',
  ]) assert.ok(w.outside(command).length > 0, command);
}));

test('the same "$" inside single quotes is text', () => pathWorld((w) => {
  assert.deepEqual(w.outside("echo '$HOME' '$(x)' '$1' 'a`b'"), []);
}));
