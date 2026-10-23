// The ledger charges an assistant entry to a repository by its working directory, beside today's one profile per
// repository, and its canary knows every field the ledger reads. The fixture entry's key paths are those `bin/factory-ledger
// --check` printed on the writer profile with Claude Code 2.1.308 on 2026-10-22; its values are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const FIXTURE = JSON.parse(readFileSync(join(factory, 'test/fixtures/ledger-entry-2.1.308.json'), 'utf8'));
const ledger = () => import(join(factory, 'bin/lib/ledger.mjs'));

/** A profile folder holding one session file made of the fixture entry with some fields changed. */
function profile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-folder-'));
  mkdirSync(join(dir, 'projects/x'), { recursive: true });
  const lines = entries.map((over, i) => {
    const { id, ...rest } = over;
    return JSON.stringify({ ...structuredClone(FIXTURE), uuid: `u${i}`, requestId: `r${i}`, ...rest, message: { ...FIXTURE.message, id: id ?? `m${i}`, ...(rest.message ?? {}) } });
  });
  writeFileSync(join(dir, 'projects/x/s.jsonl'), lines.join('\n'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the canary reads every field the ledger reads from the fixture of 2.1.308: none missing, and cwd is one of them', async () => {
  const { READS, inspect, costOf } = await ledger();
  assert.ok(READS.includes('cwd'));
  const p = profile([{}]);
  try {
    const r = inspect([p.dir]);
    assert.deepEqual(r.missing, []);
    for (const field of READS) assert.ok(r.paths.some((x) => field.split('|').includes(x.path)), field);
    const wanted = Object.keys(FIXTURE).concat(['message.usage.cache_creation.ephemeral_1h_input_tokens']);
    for (const path of wanted) assert.ok(r.paths.some((x) => x.path === path), `${path} is not among the key paths`);
    assert.ok(costOf(FIXTURE.message.model, FIXTURE.message.usage) > 0, 'the fixture entry has a price');
  } finally {
    p.cleanup();
  }
});

test('an entry is charged to the repository whose folder its working directory is under, with its branch', async () => {
  const { repoCosts, costOf } = await ledger();
  const one = costOf(FIXTURE.message.model, FIXTURE.message.usage);
  const p = profile([
    { cwd: '/work/app', gitBranch: 'a' },
    { cwd: '/work/app/.claude/worktrees/t', gitBranch: 'a' },
    { cwd: '/work/app-two', gitBranch: 'a' },
    { cwd: '/work/other', gitBranch: 'b' },
    { cwd: '/elsewhere', gitBranch: 'c' },
  ]);
  try {
    const app = repoCosts({ own: null, extra: [p.dir], root: '/work', name: 'app' });
    assert.deepEqual([...app.keys()], ['a']);
    assert.ok(Math.abs(app.get('a').dollars - 2 * one) < 1e-9, 'a worktree under the folder counts; app-two does not');
    const other = repoCosts({ own: null, extra: [p.dir], root: '/work', name: 'other' });
    assert.deepEqual([...other.keys()], ['b']);
    assert.equal(repoCosts({ own: null, extra: [p.dir], root: '/work', name: 'none' }).size, 0);
  } finally {
    p.cleanup();
  }
});

test('an entry with no working directory is charged to no repository by folder, and an entry seen twice once', async () => {
  const { repoCosts, costOf } = await ledger();
  const one = costOf(FIXTURE.message.model, FIXTURE.message.usage);
  const { cwd, ...noCwd } = FIXTURE;
  const p = profile([{ ...noCwd, cwd: undefined, id: 'x1', gitBranch: 'a' }, { id: 'y1', cwd: '/work/app', gitBranch: 'a' }, { id: 'y1', cwd: '/work/app', gitBranch: 'a' }]);
  try {
    const app = repoCosts({ own: null, extra: [p.dir, p.dir], root: '/work', name: 'app' });
    assert.ok(Math.abs(app.get('a').dollars - one) < 1e-9);
  } finally {
    p.cleanup();
  }
});

test('with one profile per repository the costs are branchCosts of that profile, unchanged; extra folders add to it once', async () => {
  const { repoCosts, branchCosts, costOf } = await ledger();
  const one = costOf(FIXTURE.message.model, FIXTURE.message.usage);
  const own = profile([{ cwd: '/anywhere', gitBranch: 'a' }, { cwd: '/anywhere', gitBranch: 'b' }]);
  const extra = profile([{ id: 'e1', cwd: '/work/app', gitBranch: 'a' }, { id: 'm0', cwd: '/work/app', gitBranch: 'a' }]);
  try {
    assert.deepEqual([...repoCosts({ own: own.dir, extra: [], root: '/work', name: 'app' })], [...branchCosts(own.dir)]);
    const both = repoCosts({ own: own.dir, extra: [extra.dir], root: '/work', name: 'app' });
    assert.ok(Math.abs(both.get('a').dollars - 2 * one) < 1e-9, 'own m0 + extra e1; extra m0 is the same message as own m0');
    assert.ok(Math.abs(both.get('b').dollars - one) < 1e-9);
    assert.equal(repoCosts({ own: null, extra: [], root: '/work', name: 'app' }), null);
  } finally {
    own.cleanup();
    extra.cleanup();
  }
});

test('the profile folders can be named by a flag or by FACTORY_PROFILE_DIRS', () => {
  const p = profile([{}]);
  try {
    const env = { ...process.env, AGENT_PROFILES: '/nonexistent', FACTORY_PROFILE_DIRS: p.dir };
    const r = spawnSync(join(factory, 'bin/factory-ledger'), ['--check'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /cwd +string/);
  } finally {
    p.cleanup();
  }
});
