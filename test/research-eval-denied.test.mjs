// The research eval's path check (#92): a tool call that Claude Code refused never ran, so it reads nothing. The CLI records each
// refusal in the result event's `permission_denials`, keyed by `tool_use_id`; the check leaves out exactly those calls. A log
// with no result event cannot say what was refused, so every call in it is checked (fail closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsidePaths } from '../probes/research-eval/paths.mjs';
import { pathWorld } from './research-eval-paths-world.mjs';

const call = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (denied) => JSON.stringify({ type: 'result', subtype: 'success', permission_denials: denied.map((id) => ({ tool_name: 'Bash', tool_use_id: id, tool_input: {} })) });

test('a call the CLI refused is left out; the same call not refused, or a log with no result event, is outside', () => pathWorld((w) => {
  const at = (log) => outsidePaths(log, { cwd: w.work, inside: [w.run, w.work, w.readable], home: w.home }).map((x) => x.path);
  const read = call('toolu_1', 'cat /etc/hosts');
  assert.deepEqual(at([read, result(['toolu_1'])].join('\n')), []);
  assert.deepEqual(at([read, result(['toolu_2'])].join('\n')), ['/etc/hosts']);
  assert.deepEqual(at(read), ['/etc/hosts']);
}));
