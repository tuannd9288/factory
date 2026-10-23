// The ledger's canary: `bin/factory-ledger --check` reads the latest real assistant entries of the profile folders and
// reports which fields the ledger reads are missing and which key paths are present with their types, never a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const SECRET = 'the user asked for the launch codes';
const entry = (over = {}) => ({
  type: 'assistant',
  gitBranch: 'work',
  cwd: '/r/app',
  uuid: 'u1',
  message: {
    id: 'm1',
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 1 } },
    content: [{ type: 'text', text: SECRET, input: { command: SECRET } }],
  },
  ...over,
});

function profile(entries, name = 'p') {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-check-'));
  mkdirSync(join(dir, name, 'projects/x'), { recursive: true });
  entries.forEach((lines, i) => {
    const file = join(dir, name, 'projects/x', `s${i}.jsonl`);
    writeFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n'));
    utimesSync(file, new Date(2026, 9, 1 + i), new Date(2026, 9, 1 + i));
  });
  return { dir: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const check = (dirs, extra = []) => {
  const r = spawnSync(join(factory, 'bin/factory-ledger'), ['--check', ...dirs.flatMap((d) => ['--profile-dir', d]), ...extra], { encoding: 'utf8', env: { ...process.env, AGENT_PROFILES: '/nonexistent' } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test('check mode lists the key paths with their types and exits 0 when every field the ledger reads is there', () => {
  const p = profile([[entry()]]);
  try {
    const r = check([p.dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /gitBranch +string/);
    assert.match(r.out, /message\.usage\.input_tokens +number/);
    assert.match(r.out, /message\.model +string/);
    assert.match(r.out, /missing: none/);
  } finally {
    p.cleanup();
  }
});

test('check mode names a missing field and exits non-zero', () => {
  const { gitBranch, ...rest } = entry();
  const noUsage = entry({ uuid: 'u2', message: { ...entry().message, id: 'm2', usage: { input_tokens: 1 } } });
  const p = profile([[rest], [noUsage]]);
  try {
    let r = check([p.dir], ['--latest', '1']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /missing: .*message\.usage\.output_tokens/);
    assert.doesNotMatch(r.out, /missing: .*gitBranch/, 'the latest entry has gitBranch');
    r = check([p.dir], ['--latest', '50']);
    assert.match(r.out, /missing: none/, 'a field some entry has is not missing');
    assert.match(r.out, /stale: .*message\.usage\.cache_read_input_tokens/, 'the newest session file lacks it: stale, not partly');
    assert.match(r.out, /partly: .*gitBranch \(1\/2\)/);
  } finally {
    p.cleanup();
  }
  const q = profile([[(({ gitBranch, ...r }) => r)(entry())]]);
  try {
    const r = check([q.dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /missing: .*gitBranch/);
  } finally {
    q.cleanup();
  }
});

test('check mode reports only names, types and counts: no message text, no tool input', () => {
  const p = profile([[entry(), entry({ uuid: 'u2', message: { ...entry().message, id: 'm2' } })]]);
  try {
    const r = check([p.dir]);
    assert.doesNotMatch(r.out, /launch codes|command/);
    assert.doesNotMatch(r.out, /message\.content\./, 'it does not descend into the content');
    assert.match(r.out, /2 assistant entries/);
  } finally {
    p.cleanup();
  }
});

test('check mode on a folder with no session files fails, and on a missing one says so', () => {
  const p = profile([]);
  try {
    const r = check([p.dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no assistant entries/);
  } finally {
    p.cleanup();
  }
  assert.equal(check(['/nonexistent/profile']).code, 1);
});
