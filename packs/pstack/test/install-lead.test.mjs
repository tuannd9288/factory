// packs/pstack/bin/install-lead (#166): puts `lead` on the factory account's PATH, in a fixture home only. Never the real ~/.zshenv.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const real = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const me = userInfo().username;

// The block, byte for byte: nothing printed, each folder added in front only when PATH lacks it, the result in the order ~/.zprofile uses.
const BEGIN = '# >>> factory: lead on PATH (packs/pstack/bin/install-lead) >>>\n';
const END = '# <<< factory: lead on PATH <<<\n';
const BLOCK = `${BEGIN}for d in /opt/homebrew/sbin /opt/homebrew/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
unset d
export PATH
${END}`;

function fixture(body) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-lead-')));
  const home = join(root, 'home');
  mkdirSync(home);
  const f = {
    root, home, zshenv: join(home, '.zshenv'), link: join(home, '.local/bin/lead'),
    run: (extra = {}, script = join(real, 'packs/pstack/bin/install-lead.mjs')) => {
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, FACTORY_HOST_USER: me, ...extra }, timeout: 20000 });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
  };
  try {
    return body(f);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('install-lead', () => {
  test('a fresh home gets the symlink to the clone\'s launcher and exactly the block in ~/.zshenv', () => fixture((f) => {
    const r = f.run();
    assert.equal(r.code, 0, r.err);
    assert.equal(readlinkSync(f.link), join(real, 'packs/pstack/bin/lead'));
    assert.equal(readFileSync(f.zshenv, 'utf8'), BLOCK);
  }));

  test('a second run changes no byte and says nothing changed', () => fixture((f) => {
    f.run();
    const before = [lstatSync(f.zshenv), lstatSync(f.link)];
    const r = f.run();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nothing changed/);
    assert.equal(readFileSync(f.zshenv, 'utf8'), BLOCK);
    assert.deepEqual([lstatSync(f.zshenv).ino, lstatSync(f.link).ino], before.map((s) => s.ino));
    assert.deepEqual([lstatSync(f.zshenv).mtimeMs, lstatSync(f.link).mtimeMs], before.map((s) => s.mtimeMs));
  }));

  test('a .zshenv it does not own keeps every byte; the block goes at its end, and a changed block is replaced in place', () => fixture((f) => {
    const mine = 'export FOO=1\nalias ll="ls -l"\n';
    writeFileSync(f.zshenv, mine);
    assert.equal(f.run().code, 0);
    assert.equal(readFileSync(f.zshenv, 'utf8'), mine + BLOCK);
    const tail = '# after\nexport BAR=2\n';
    writeFileSync(f.zshenv, `${mine}${BEGIN}old line\n${END}${tail}`);
    assert.equal(f.run().code, 0);
    assert.equal(readFileSync(f.zshenv, 'utf8'), mine + BLOCK + tail);
    writeFileSync(f.zshenv, 'export NO_NEWLINE=1');
    assert.equal(f.run().code, 0);
    assert.equal(readFileSync(f.zshenv, 'utf8'), `export NO_NEWLINE=1\n${BLOCK}`);
  }));

  test('refuses another file or another symlink at ~/.local/bin/lead, names it, and writes nothing', () => fixture((f) => {
    mkdirSync(dirname(f.link), { recursive: true });
    writeFileSync(f.link, '#!/bin/sh\n');
    let r = f.run();
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(f.link), r.err);
    assert.equal(readFileSync(f.link, 'utf8'), '#!/bin/sh\n');
    rmSync(f.link);
    symlinkSync('/usr/bin/true', f.link);
    r = f.run();
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(f.link), r.err);
    assert.equal(readlinkSync(f.link), '/usr/bin/true');
    assert.throws(() => lstatSync(f.zshenv), { code: 'ENOENT' });
  }));

  test('after a move of the clone, a run points the link at the new place', () => fixture((f) => {
    const moved = join(f.root, 'WORKSPACES2');
    mkdirSync(join(moved, 'packs/pstack/bin'), { recursive: true });
    for (const n of ['install-lead.mjs', 'lead']) cpSync(join(real, 'packs/pstack/bin', n), join(moved, 'packs/pstack/bin', n));
    assert.equal(f.run().code, 0);
    const r = f.run({}, join(moved, 'packs/pstack/bin/install-lead.mjs'));
    assert.equal(r.code, 0, r.err);
    assert.equal(readlinkSync(f.link), join(moved, 'packs/pstack/bin/lead'));
  }));

  test('refuses a .zshenv whose markers are not one begin and one end in order, and changes nothing', () => fixture((f) => {
    for (const bad of [BEGIN, END, `${END}${BEGIN}`, BLOCK + BLOCK]) {
      writeFileSync(f.zshenv, bad);
      const r = f.run();
      assert.equal(r.code, 1, JSON.stringify(bad));
      assert.ok(r.err.includes(f.zshenv), r.err);
      assert.equal(readFileSync(f.zshenv, 'utf8'), bad);
      assert.throws(() => lstatSync(f.link), { code: 'ENOENT' });
    }
  }));

  test('runs only as the factory host user: FACTORY_HOST_USER, default factory', () => fixture((f) => {
    const r = f.run({ FACTORY_HOST_USER: `not-${me}` });
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`not-${me}`));
    assert.throws(() => lstatSync(f.zshenv), { code: 'ENOENT' });
    const d = spawnSync(process.execPath, [join(real, 'packs/pstack/bin/install-lead.mjs')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.home } });
    if (me === 'factory') assert.equal(d.status, 0, d.stderr);
    else {
      assert.equal(d.status, 1);
      assert.match(d.stderr, /factory/);
    }
  }));

  test('refuses a HOME that is no absolute folder', () => fixture((f) => {
    assert.equal(f.run({ HOME: 'relative/home' }).code, 1);
    assert.equal(f.run({ HOME: '' }).code, 1);
  }));

  test('the shell wrapper installs the same way', () => fixture((f) => {
    const r = spawnSync('bash', [join(real, 'packs/pstack/bin/install-lead')], { encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: f.home, FACTORY_HOST_USER: me } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(f.zshenv, 'utf8'), BLOCK);
  }));
});

describe('the ~/.zshenv block, sourced by a shell', () => {
  for (const shell of ['sh', 'zsh']) {
    test(`${shell}: prints nothing, adds the missing folders in front in ~/.zprofile's order, and adds none twice`, (t) => fixture((f) => {
      const ask = (PATH) => spawnSync(shell, ['-c', `. "${f.zshenv}"; printf %s "$PATH"`], { encoding: 'utf8', env: { PATH, HOME: f.home } });
      if (ask('/usr/bin:/bin').error) return t.skip(`no ${shell}`);
      writeFileSync(f.zshenv, BLOCK);
      let r = ask('/usr/bin:/bin');
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, `${f.home}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin`);
      const full = `/usr/bin:/opt/homebrew/bin:${f.home}/.local/bin:/opt/homebrew/sbin:/bin`;
      r = ask(full);
      assert.equal(r.stdout, full, 'a PATH that holds them all is left as it is');
      r = ask('/shim:/opt/homebrew/bin:/usr/bin:/bin');
      assert.equal(r.stdout, `${f.home}/.local/bin:/opt/homebrew/sbin:/shim:/opt/homebrew/bin:/usr/bin:/bin`);
    }));
  }
});
