// bin/lib/node.mjs (#366): which place this is. The factory host is its user on the machine named HOST; the MacBook's own `factory` user
// is a node. Nothing live runs: the names are the test's, and scutil is a fake on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST, installedRoot, nodeGithubToken, placeOf } from '../bin/lib/node.mjs';
import { HOST_ENV, factory } from './helpers.mjs';

test('the host\'s user on a machine that is not named the host is a node: its installed copy, its own agents token (#366)', () => {
  const home = mkdtempSync(join(tmpdir(), 'node-place-'));
  try {
    mkdirSync(join(home, '.agent-profiles/tokens'), { recursive: true });
    writeFileSync(join(home, '.agent-profiles/tokens/fake-agent'), 'made-up-agents-token');
    const base = { HOME: home, FACTORY_AGENT: 'fake-agent' };
    const host = { ...base, ...HOST_ENV };
    assert.equal(placeOf(host), 'factory');
    assert.equal(installedRoot(host), join(home, 'WORKSPACES'));
    assert.equal(nodeGithubToken(host), undefined, 'the host\'s gh has its own login');
    const node = { ...host, FACTORY_HOST_NAME: 'another-machine' };
    assert.equal(placeOf(node), 'macbook');
    assert.equal(installedRoot(node), join(home, '.local/share/factory/checkout'));
    assert.equal(nodeGithubToken(node), 'made-up-agents-token');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the machine\'s name is the LocalHostName scutil gives, in lower case and without .local, and the host name where scutil fails', () => {
  const bin = mkdtempSync(join(tmpdir(), 'node-name-'));
  try {
    const nameWith = (script) => {
      writeFileSync(join(bin, 'scutil'), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, 'scutil'), 0o755);
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { nodeName } from ${JSON.stringify(join(factory, 'bin/lib/node.mjs'))}; console.log(nodeName());`],
        { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(nameWith('[ "$*" = "--get LocalHostName" ] && echo Some-Mac-mini'), 'some-mac-mini');
    assert.equal(nameWith('echo Some-Mac.local'), 'some-mac');
    // What the two machines print (2026-11-07): the Mac mini's is the host's name; the MacBook's is not.
    assert.equal(nameWith('echo Tuans-Mac-mini'), HOST);
    assert.equal(nameWith('echo Tuans-Mac-mini.local'), HOST);
    assert.notEqual(nameWith('echo MacBook-Pro'), HOST);
    assert.equal(nameWith('exit 1'), hostname().toLowerCase().replace(/\.local$/, '').split('.')[0]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
