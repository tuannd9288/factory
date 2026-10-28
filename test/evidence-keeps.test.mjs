// bin/kit-evidence over a repository that kept its own verify, hooks and settings.json: the settings file is judged as
// merged (the base's bytes plus the kit's deny lines), .gate/config.sh as the kit's text plus the adapter lines, and the
// repository's own scripts/ and .githooks/ as untouched.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { commit, git, run } from './helpers.mjs';
import { addDeny } from '../bin/lib/settings.mjs';
import { EXECUTABLE, OWN, SEED } from './seed-world.mjs';
import { world } from './world.mjs';

/** The seeded repository onboarded from a copy of this factory; evidence() runs bin/kit-evidence on factory/kit. */
function onboarded() {
  const w = world({ onboardArgs: null, seedFiles: SEED, seedExecutable: EXECUTABLE });
  const out = w.onboard([]);
  assert.equal(out.code, 0, out.out);
  const base = git(w.repo, 'rev-parse', 'main');
  const evidence = () =>
    run(w.dir, join(w.fac, 'bin/kit-evidence'), ['--factory', w.fac, '--commit', 'HEAD', '--repo', w.repo, '--base', base, '--head', 'factory/kit', '--slug', 'tuannd9288/app', '--id', '1']);
  const change = (files) => commit(w.repo, files, 'a change after onboard');
  return { ...w, evidence, change };
}

describe('bin/kit-evidence over a repository with its own verify, hooks and settings', () => {
  test('passes, and names the merged, adapter and untouched files', () => {
    const w = onboarded();
    try {
      const out = w.evidence();
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /^kit-evidence: PASS$/m);
      assert.match(out.out, /^merged \(.*\):\n {2}\.claude\/settings\.json$/m);
      assert.match(out.out, /^adapter \(.*\):\n {2}\.gate\/config\.sh$/m);
      assert.match(out.out, /^untouched \(.*\):\n {2}\.githooks\/pre-commit\n {2}\.githooks\/pre-push\n {2}scripts\/size\.mjs\n {2}scripts\/verify$/m);
    } finally {
      w.cleanup();
    }
  });

  test('fails a changed byte in an untouched file, a hook included', () => {
    for (const [path, text] of [['scripts/verify', `${SEED['scripts/verify']}// edited\n`], ['.githooks/pre-commit', `${SEED['.githooks/pre-commit']}# edited\n`], ['scripts/size.mjs', 'console.log("no rule");\n']]) {
      const w = onboarded();
      try {
        w.change({ [path]: text });
        const out = w.evidence();
        assert.equal(out.code, 1, out.out);
        assert.match(out.out, new RegExp(`^ {2}differs: ${path.replaceAll('.', '\\.')} \\(the repository's own, which the kit leaves untouched\\)$`, 'm'));
      } finally {
        w.cleanup();
      }
    }
  });

  test("fails a settings.json that is not the base's bytes plus the kit's deny lines", () => {
    for (const edit of [(t) => t.replace('"Bash(rm -rf *)"', '"Bash(rm *)"'), (t) => t.replace('"Read(./.env*)",', ''), (t) => `${t}\n`]) {
      const w = onboarded();
      try {
        w.change({ '.claude/settings.json': edit(readFileSync(join(w.repo, '.claude/settings.json'), 'utf8')) });
        const out = w.evidence();
        assert.equal(out.code, 1, out.out);
        assert.match(out.out, /^ {2}differs: \.claude\/settings\.json \(not the repository's own with only the kit's deny lines added\)$/m);
      } finally {
        w.cleanup();
      }
    }
  });

  test('fails a config.sh that is not the kit\'s text with the adapter lines for this repository', () => {
    const w = onboarded();
    try {
      const config = readFileSync(join(w.repo, '.gate/config.sh'), 'utf8');
      w.change({ '.gate/config.sh': `${config}# one more line\n` });
      const out = w.evidence();
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^ {2}differs: \.gate\/config\.sh \(not the kit's text with the adapter lines for this repository\)$/m);
    } finally {
      w.cleanup();
    }
  });

  test('onboard refuses a settings.json that is not UTF-8, and evidence fails a head that decoded it', () => {
    // A Latin-1 \u00e9 in a string: read as UTF-8 and written back, the byte becomes U+FFFD.
    const latin1 = Buffer.concat([Buffer.from('{\n  "permissions": { "deny": ["Bash(rm -rf *)"] },\n  "note": "caf'), Buffer.from([0xe9]), Buffer.from('"\n}\n')]);
    const w = world({ onboardArgs: null, seedFiles: { ...SEED, '.claude/settings.json': latin1 }, seedExecutable: EXECUTABLE });
    try {
      const out = w.onboard([]);
      assert.equal(out.code, 2, out.out);
      assert.match(out.out, /\.claude\/settings\.json: .*not UTF-8/);
      assert.ok(!existsSync(w.repo), 'the clone is left behind');
      const clone = join(w.dir, 'clone');
      git(w.dir, 'clone', '-q', w.url, clone);
      git(clone, 'switch', '-q', '-c', 'factory/kit');
      const kitDeny = JSON.parse(readFileSync(join(w.fac, 'kit/.claude/settings.json'), 'utf8')).permissions.deny;
      commit(clone, { '.claude/settings.json': addDeny(latin1.toString('utf8'), kitDeny).text }, 'decoded');
      const ev = run(w.dir, join(w.fac, 'bin/kit-evidence'), ['--factory', w.fac, '--commit', 'HEAD', '--repo', clone, '--base', 'main', '--head', 'factory/kit', '--slug', 'tuannd9288/app', '--id', '1']);
      assert.equal(ev.code, 1, ev.out);
      assert.match(ev.out, /^ {2}differs: \.claude\/settings\.json \(.*not UTF-8.*\)$/m);
    } finally {
      w.cleanup();
    }
  });
});
