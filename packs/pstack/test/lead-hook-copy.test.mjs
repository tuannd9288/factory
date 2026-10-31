// #257: the Lead's Stop and SessionEnd hooks run a copy of transcript-copy.mjs that lives in the Lead's run folder, so an update of the
// factory's checkout never changes a file a Lead pane that stays open for days will run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const lead = () => import('../bin/lead.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'lead-hook-'));

test('copyHook puts the script at hooks/transcript-copy-<sha7>.mjs of the run folder, byte for byte, and reuses it', async () => {
  const { copyHook } = await lead();
  const dir = tmp();
  try {
    const first = copyHook({ root, runDir: dir });
    assert.match(first, /\/hooks\/transcript-copy-[0-9a-f]{7}\.mjs$/);
    assert.ok(first.startsWith(join(dir, 'hooks')));
    const text = readFileSync(join(root, 'packs/pstack/bin/transcript-copy.mjs'));
    assert.deepEqual(readFileSync(first), text);
    const before = statSync(first).mtimeMs;
    assert.equal(copyHook({ root, runDir: dir }), first);
    assert.equal(statSync(first).mtimeMs, before, 'a copy that is there is not written again');
    assert.deepEqual(readdirSync(join(dir, 'hooks')), [first.split('/').pop()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed script gets a copy of its own and the earlier copy stays', async () => {
  const { copyHook } = await lead();
  const dir = tmp();
  try {
    const fake = join(dir, 'root/packs/pstack/bin');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'transcript-copy.mjs'), '// v1\n');
    const a = copyHook({ root: join(dir, 'root'), runDir: join(dir, 'run') });
    writeFileSync(join(fake, 'transcript-copy.mjs'), '// v2\n');
    const b = copyHook({ root: join(dir, 'root'), runDir: join(dir, 'run') });
    assert.notEqual(a, b);
    assert.equal(readFileSync(a, 'utf8'), '// v1\n');
    assert.equal(readFileSync(b, 'utf8'), '// v2\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('leadArgs points both hooks at the copy, and the copy copies a transcript with the checkout out of reach', async () => {
  const { copyHook, leadArgs } = await lead();
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const run = join(home, 'factory-runs', 'r-lead');
    const hookScript = copyHook({ root, runDir: run });
    const { hook, argv } = leadArgs({ repo: 'r', home, root, roleText: 'x', node: process.execPath, hookScript });
    assert.ok(hook.includes(hookScript));
    assert.ok(!hook.includes('packs/pstack/bin/transcript-copy.mjs'));
    const { hooks } = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    for (const event of ['Stop', 'SessionEnd']) assert.equal(hooks[event][0].hooks[0].command, hook);
    const config = join(dir, 'profile');
    mkdirSync(join(config, 'projects/p'), { recursive: true });
    const source = join(config, 'projects/p/s.jsonl');
    writeFileSync(source, 'line\n');
    const r = spawnSync('sh', ['-c', hook], { cwd: dirname(hookScript), input: JSON.stringify({ transcript_path: source }), encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(run, 'transcripts/s.jsonl'), 'utf8'), 'line\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
