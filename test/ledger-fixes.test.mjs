// Review fixes for the ledger canary and the folder match (PR #14): a format change that leaves the canary green, the
// READS list against what the reading code touches, an allow-list for check mode, path containment, the union of profile
// folders, entries without a cwd, the canary line of the digest, and the mutants the first tests let live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { factory } from './helpers.mjs';

const FIXTURE = JSON.parse(readFileSync(join(factory, 'test/fixtures/ledger-entry-2.1.308.json'), 'utf8'));
const ledger = () => import(join(factory, 'bin/lib/ledger.mjs'));
let counter = 0;
const entry = (over = {}) => {
  counter += 1;
  const e = { ...structuredClone(FIXTURE), uuid: `u${counter}`, requestId: `r${counter}`, ...over, message: { ...structuredClone(FIXTURE.message), id: `m${counter}`, ...(over.message ?? {}) } };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
};

/** A profile folder: each item of `files` is {name, mtime (a day of October 2026), entries}. */
function profile(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-fixes-'));
  mkdirSync(join(dir, 'projects/x'), { recursive: true });
  for (const f of files) {
    const file = join(dir, 'projects/x', f.name);
    writeFileSync(file, f.entries.map((e) => JSON.stringify(e)).join('\n'));
    utimesSync(file, new Date(2026, 9, f.day), new Date(2026, 9, f.day));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const check = (args, env = {}) => {
  const r = spawnSync(join(factory, 'bin/factory-ledger'), ['--check', ...args], { encoding: 'utf8', env: { ...process.env, AGENT_PROFILES: '/nonexistent', ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const noBranch = () => entry({ gitBranch: undefined });

test('the canary fails when the newest 10 entries all lack a field the ledger reads, though older ones have it', () => {
  const p = profile([
    { name: 'old.jsonl', day: 1, entries: Array.from({ length: 5 }, () => entry()) },
    { name: 'new.jsonl', day: 2, entries: Array.from({ length: 45 }, noBranch) },
  ]);
  try {
    const r = check(['--profile-dir', p.dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /stale: .*gitBranch/);
    assert.match(r.out, /missing: none/);
  } finally {
    p.cleanup();
  }
});

test('the canary fails when every entry of the newest session file lacks a field, even with fewer than 10', () => {
  const p = profile([
    { name: 'old.jsonl', day: 1, entries: Array.from({ length: 30 }, () => entry()) },
    { name: 'new.jsonl', day: 2, entries: [noBranch(), noBranch(), noBranch()] },
  ]);
  try {
    const r = check(['--profile-dir', p.dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /stale: .*gitBranch/);
  } finally {
    p.cleanup();
  }
});

test('the canary stays green when only some of the newest entries lack a field', () => {
  const p = profile([{ name: 'a.jsonl', day: 1, entries: [...Array.from({ length: 20 }, () => entry()), noBranch(), noBranch()] }]);
  try {
    const r = check(['--profile-dir', p.dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /partly: .*gitBranch/);
  } finally {
    p.cleanup();
  }
});

test('READS holds every field charge and costOf touch, including the cache-creation split', async () => {
  const { READS, charge } = await ledger();
  assert.ok(READS.includes('message.usage.cache_creation.ephemeral_1h_input_tokens'));
  assert.ok(READS.includes('message.usage.cache_creation.ephemeral_5m_input_tokens'));
  const touched = new Set();
  const wrap = (value, path) =>
    new Proxy(value, {
      get(target, key) {
        if (typeof key === 'symbol') return target[key];
        const v = target[key];
        const p = path ? `${path}.${key}` : key;
        if (v && typeof v === 'object') return wrap(v, p);
        touched.add(p);
        return v;
      },
    });
  charge(new Map(), new Set(), wrap(entry(), ''));
  const allowed = new Set(READS.flatMap((r) => r.split('|')));
  assert.ok(touched.size > 5, [...touched].join(' '));
  for (const path of touched) assert.ok(allowed.has(path), `${path} is read but not in READS`);
  for (const path of ['gitBranch', 'message.model', 'message.usage.input_tokens', 'message.usage.cache_creation.ephemeral_5m_input_tokens']) assert.ok(touched.has(path), `${path} was not touched`);
});

test('check mode opens only message and message.usage: no other object, and no key under message.diagnostics', () => {
  const p = profile([{ name: 'a.jsonl', day: 1, entries: [entry({ topSecretMap: { 'sk-live-SECRET-KEY-ONE': 1 }, message: { diagnostics: { 'sk-live-SECRET-KEY-TWO': 1 } } })] }]);
  try {
    const r = check(['--profile-dir', p.dir]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /SECRET/);
    assert.match(r.out, /topSecretMap +object/);
    assert.match(r.out, /message\.diagnostics +object/);
    assert.match(r.out, /message\.usage\.cache_creation\.ephemeral_1h_input_tokens +number/);
  } finally {
    p.cleanup();
  }
});

test('a folder is matched by path containment: .. in cwd, //, symlinks on either side; case is exact', async () => {
  const { repoCosts, costOf } = await ledger();
  const one = costOf(FIXTURE.message.model, FIXTURE.message.usage);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-path-')));
  try {
    mkdirSync(join(base, 'root/app/sub'), { recursive: true });
    mkdirSync(join(base, 'root/other'), { recursive: true });
    symlinkSync(join(base, 'root'), join(base, 'rootlink'));
    symlinkSync(join(base, 'root/app'), join(base, 'applink'));
    const cost = (cwd, root = join(base, 'root')) => {
      const p = profile([{ name: 'a.jsonl', day: 1, entries: [entry({ cwd })] }]);
      try {
        return repoCosts({ own: null, extra: [p.dir], root, name: 'app' }).get('work')?.dollars ?? 0;
      } finally {
        p.cleanup();
      }
    };
    assert.equal(cost(`${base}/root/app/../other`), 0, '.. must not charge app');
    assert.equal(cost(`${base}/root/app/sub/../../other`), 0);
    assert.ok(Math.abs(cost(`${base}/root/app/sub/../sub`) - one) < 1e-9, '.. that stays inside is app');
    assert.ok(Math.abs(cost(`${base}/root//app`) - one) < 1e-9, '// is app');
    assert.ok(Math.abs(cost(`${base}/root/app/`) - one) < 1e-9, 'a trailing slash is app');
    assert.ok(Math.abs(cost(`${base}/rootlink/app/sub`) - one) < 1e-9, 'cwd through a symlink to the root is app');
    assert.ok(Math.abs(cost(`${base}/root/app/sub`, join(base, 'rootlink')) - one) < 1e-9, 'a root given as a symlink');
    assert.ok(Math.abs(cost(`${base}/applink`) - one) < 1e-9, 'a symlink to the folder is app');
    assert.equal(cost(`${base}/root/application`), 0);
    assert.equal(cost(`${base}/root/APP`), 0, 'case is exact (APFS is case-insensitive; the ledger does not guess)');
    assert.equal(cost('relative/app'), 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check mode reads the union: the per-repository profiles and the extra folders', () => {
  const profiles = mkdtempSync(join(tmpdir(), 'ledger-union-'));
  mkdirSync(join(profiles, 'o/app/claude'), { recursive: true });
  const own = profile([{ name: 'a.jsonl', day: 1, entries: [entry()] }]);
  const extra = profile([{ name: 'b.jsonl', day: 2, entries: [entry()] }]);
  try {
    spawnSync('cp', ['-R', join(own.dir, 'projects'), join(profiles, 'o/app/claude/projects')]);
    const r = check(['--profile-dir', extra.dir], { AGENT_PROFILES: profiles });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /2 assistant entries .* from 2 profile folder/);
  } finally {
    own.cleanup();
    extra.cleanup();
    rmSync(profiles, { recursive: true, force: true });
  }
});

test('entries without a cwd in an extra folder are counted with their dollars, in check mode and in the digest', async () => {
  const { unplaced, costOf, digest } = await ledger();
  const one = costOf(FIXTURE.message.model, FIXTURE.message.usage);
  const p = profile([{ name: 'a.jsonl', day: 1, entries: [entry({ cwd: undefined }), entry({ cwd: undefined }), entry({ cwd: '/work/app' })] }]);
  try {
    const u = unplaced([p.dir]);
    assert.equal(u.entries, 2);
    assert.ok(Math.abs(u.dollars - 2 * one) < 1e-9);
    const r = check(['--profile-dir', p.dir]);
    assert.match(r.out, /no cwd: 2 entries, \$/);
    const text = digest([], { since: '2026-10-15', until: '2026-10-22', unplaced: u });
    assert.match(text, /2 entries .*record no cwd/);
    assert.doesNotMatch(digest([], { since: 'a', until: 'b' }), /record no cwd/);
  } finally {
    p.cleanup();
  }
});

test('the digest says in one line which fields the canary could not read, so a posted digest is not silent', async () => {
  const { digest, canaryLine } = await ledger();
  assert.equal(canaryLine({ entries: 5, missing: [], stale: [] }), null);
  assert.equal(canaryLine({ entries: 0, missing: [], stale: [] }), null);
  const line = canaryLine({ entries: 5, missing: ['cwd'], stale: ['gitBranch'] });
  assert.match(line, /cwd/);
  assert.match(line, /gitBranch/);
  const text = digest([], { since: '2026-10-15', until: '2026-10-22', canary: line });
  assert.equal(text.split('\n').filter((l) => l.includes('gitBranch')).length, 1);
  assert.match(text, /--check/);
});

test('--latest must be a whole number of at least 1', () => {
  const p = profile([{ name: 'a.jsonl', day: 1, entries: [entry()] }]);
  try {
    for (const bad of ['0', 'x', '-3', '1.5', '']) {
      const r = check(['--profile-dir', p.dir, '--latest', bad]);
      assert.notEqual(r.code, 0, `--latest ${bad}`);
      assert.match(r.out, /--latest/);
    }
    assert.equal(check(['--profile-dir', p.dir, '--latest', '1']).code, 0);
  } finally {
    p.cleanup();
  }
});

test('the latest entries are the newest by file modification time, whatever the file names', () => {
  const p = profile([
    { name: 'a-newest.jsonl', day: 9, entries: [entry()] },
    { name: 'z-oldest.jsonl', day: 1, entries: [noBranch()] },
  ]);
  try {
    const r = check(['--profile-dir', p.dir, '--latest', '1']);
    assert.equal(r.code, 0, `the newest entry (a-newest, by mtime) has gitBranch: ${r.out}`);
    assert.match(r.out, /1 assistant entries/);
  } finally {
    p.cleanup();
  }
});

test('an entry repeated for each content block counts once, so the latest N are N distinct entries', () => {
  const dup = entry();
  const p = profile([{ name: 'a.jsonl', day: 1, entries: [noBranch(), dup, dup, dup] }]);
  try {
    const r = check(['--profile-dir', p.dir, '--latest', '2']);
    assert.match(r.out, /2 assistant entries/);
    assert.match(r.out, /partly: .*gitBranch \(1\/2\)/, 'the sample is the repeated entry once and the one before it');
  } finally {
    p.cleanup();
  }
});

test('the canary fails on the newest 10 entries alone: the newest file still holds older entries that have the field', () => {
  const p = profile([{ name: 'a.jsonl', day: 1, entries: [entry(), entry(), ...Array.from({ length: 10 }, noBranch)] }]);
  try {
    const r = check(['--profile-dir', p.dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /stale: .*gitBranch/);
  } finally {
    p.cleanup();
  }
});
