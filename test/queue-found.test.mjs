// #211: the merge queue finds the repositories taken in, as the ledger does, so a new one needs no new install.
// A fake gh and a temporary factory root; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from './helpers.mjs';

const GH = '#!/bin/sh\ncase "$*" in\n  "api user"*) echo agent-bot ;;\n  *graphql*) echo \'{"data":{"repository":{"pullRequests":{"nodes":[]}}}}\' ;;\n  *rules/branches*) echo "[]" ;;\n  *) exit 1 ;;\nesac\n';

/** A clone under the root: a git folder whose origin is on github.com, with the kit's config when `kit` is set. */
function clone(root, folder, url, kit) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  if (kit) {
    mkdirSync(join(dir, '.gate'));
    writeFileSync(join(dir, '.gate/config.sh'), '');
  }
}

function withRoot(body) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-found-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/gh'), GH);
    chmodSync(join(dir, 'bin/gh'), 0o755);
    const root = join(dir, 'root');
    mkdirSync(root);
    const home = join(dir, 'home');
    mkdirSync(home);
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: home, FACTORY_STATE: join(dir, 'state'), FACTORY_ROOT: root };
    const queue = (...args) => spawnSync(join(factory, 'bin/factory-queue'), args, { encoding: 'utf8', env });
    body({ dir, root, queue });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a kit clone with no origin is skipped by name, and the others are still swept', () => {
  withRoot(({ dir, root, queue }) => {
    clone(root, 'app', 'https://github.com/o/app.git', true);
    clone(root, 'stray', 'https://github.com/o/stray.git', true);
    execFileSync('git', ['-C', join(root, 'stray'), 'remote', 'remove', 'origin']);
    const r = queue('sweep');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skipped .*stray/);
    assert.ok(existsSync(join(dir, 'state/queue-o-app.ok')), 'the good clone was not swept');
    assert.ok(!existsSync(join(dir, 'state/queue-run.failed')), 'the odd clone failed the run');
  });
});

test('sweep with no --repo and no repository taken in logs that and is not an error', () => {
  withRoot(({ dir, root, queue }) => {
    clone(root, 'plain', 'https://github.com/o/plain.git', false);
    const r = queue('sweep');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no repository taken in under /);
    assert.ok(!existsSync(join(dir, 'state/queue-run.failed')), 'an empty list left a failure');
  });
});

test('plist --daemon with no --repo prints a job whose arguments list no repository', () => {
  withRoot(({ dir, queue }) => {
    const r = queue('plist', '--daemon');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    writeFileSync(join(dir, 'job.plist'), r.stdout);
    const p = spawnSync('python3', ['-I', '-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', join(dir, 'job.plist')], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(JSON.parse(p.stdout).ProgramArguments, [join(factory, 'bin/factory-queue'), 'sweep']);
  });
});

test('sweep with no --repo sweeps each clone under the root that holds the kit, and no other', () => {
  withRoot(({ dir, root, queue }) => {
    clone(root, 'app', 'https://github.com/o/app.git', true);
    clone(root, 'lib', 'git@github.com:o/lib.git', true);
    clone(root, 'plain', 'https://github.com/o/plain.git', false);
    const r = queue('sweep');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(join(dir, 'state')).filter((f) => f.endsWith('.ok')).sort(), ['queue-o-app.ok', 'queue-o-lib.ok']);
    assert.ok(!existsSync(join(dir, 'state/queue-o-plain.ok')), 'a folder without the kit was swept');
  });
});
