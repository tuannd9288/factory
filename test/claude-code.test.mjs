// INN-39 item 3: the factory reads Claude Code's formats in one module, bin/lib/claude-code.mjs, and everything else reads the factory's own
// shapes. This scans the factory's code (comments left out) for field names that only Claude Code's stream, transcripts and login output use.
// Its scope is three folders, with no list of exceptions: the kit is outside it, since it is copied into every repository and has its own one
// Claude file behind result.mjs. The markers leave out, on purpose, the names that a hook script reads or the factory's own shapes reuse:
// `rate_limits` and `used_percentage` (statusline-hook.mjs), `hook_event_name`, `notification_type` and `transcript_path` (the hooks),
// `resetsAt` (the factory's windows), `duration_ms` and `total_cost_usd` (a seat's record), `loggedIn` (the Linear login). Adding one of those
// would fail the hooks, which must stay standalone (they import only node: modules), not the seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const SCOPE = ['bin/lib', 'packs/pstack/bin', 'packs/pstack/scripts/lib'];
const SEAM = 'bin/lib/claude-code.mjs';
const MARKERS = [
  'rate_limit_event', 'rate_limit_info', 'unifiedWindows', 'rateLimitType', 'utilization',
  'stop_reason', 'isSidechain', 'parent_tool_use_id', 'tool_use', 'subtype',
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation',
  'modelUsage', 'structured_output', 'num_turns', 'is_error', 'session_id',
  'gitBranch', 'requestId', 'subscriptionType',
];

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('no file outside bin/lib/claude-code.mjs names a field of Claude Code\'s stream, transcripts or login output', () => {
  const found = [];
  for (const dir of SCOPE) {
    for (const name of readdirSync(join(factory, dir)).filter((n) => n.endsWith('.mjs'))) {
      const path = `${dir}/${name}`;
      if (path === SEAM) continue;
      const text = code(readFileSync(join(factory, path), 'utf8'));
      const hits = MARKERS.filter((m) => new RegExp(`\\b${m}\\b`).test(text));
      if (hits.length) found.push(`${path}: ${hits.join(', ')}`);
    }
  }
  assert.deepEqual(found, []);
});
