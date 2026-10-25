// The module's skill follows the Agent Skills specification (agentskills.io/specification), and its script and fixtures work.
// The skill is guidance for an agent; the gate never depends on it. Step 1 ships the whole-file parts only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, run, script } from '../../../test/helpers.mjs';
import { entry, fl, moduleRepo, report } from './lib.mjs';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(MODULE, 'kit/.claude/skills/deletion-proof');
const text = (path) => readFileSync(join(SKILL, path), 'utf8');

/** The front matter of a SKILL.md: its keys with single-line values, and the body after it. */
function parse(source) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(m, 'SKILL.md starts with a --- front matter block');
  const front = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+): (.*)$/.exec(line);
    assert.ok(kv, `front matter line is "key: value": ${line}`);
    front[kv[1]] = kv[2];
  }
  return { front, body: m[2] };
}

describe('the skill follows the Agent Skills specification', () => {
  const { front, body } = parse(text('SKILL.md'));

  test('name matches its folder: lowercase letters, digits and single hyphens, at most 64, no hyphen at either end', () => {
    assert.equal(front.name, 'deletion-proof');
    assert.equal(front.name, 'deletion-proof'.toLowerCase());
    assert.match(front.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(front.name.length <= 64);
    assert.equal(SKILL.split('/').at(-1), front.name, 'the folder is the name');
  });
  test('description says what it does and when, in 1024 characters at most', () => {
    assert.ok(front.description.length > 0 && front.description.length <= 1024, `${front.description.length} characters`);
    assert.match(front.description, /^Use when /);
    assert.match(front.description, /not a pure deletion/);
    assert.match(front.description, /Not for /);
  });
  test('compatibility is at most 500 characters; only keys the specification or Claude Code know are used', () => {
    assert.ok(front.compatibility.length <= 500);
    for (const key of Object.keys(front)) assert.ok(['name', 'description', 'compatibility', 'allowed-tools', 'license', 'metadata'].includes(key), key);
  });
  test('allowed-tools grants the one script by a fixed repository path, with no variable (the factory\'s grants refuse any)', () => {
    assert.equal(front['allowed-tools'], 'Bash(.claude/skills/deletion-proof/scripts/knip-at-base *)');
    assert.doesNotMatch(front['allowed-tools'], /[$`]/);
  });
  test('the body is under 500 lines and about 5,000 tokens (characters / 4) at most', () => {
    assert.ok(body.split('\n').length < 500, `${body.split('\n').length} lines`);
    assert.ok(body.length / 4 <= 5000, `${Math.round(body.length / 4)} tokens`);
  });
  test('one reference, one level deep: references/refusals.md, named in the body and linking to nothing', () => {
    assert.deepEqual(readdirSync(join(SKILL, 'references')), ['refusals.md']);
    assert.match(body, /references\/refusals\.md/);
    assert.doesNotMatch(text('references/refusals.md'), /\]\(|references\/|scripts\//);
  });
  test('the folder holds SKILL.md, the reference and the script, and nothing else', () => {
    const all = readdirSync(SKILL, { recursive: true }).filter((p) => statSync(join(SKILL, p)).isFile()).sort();
    assert.deepEqual(all, ['SKILL.md', 'references/refusals.md', 'scripts/knip-at-base']);
    assert.ok(statSync(join(SKILL, 'scripts/knip-at-base')).mode & 0o111, 'the script is executable');
  });
  test('step 1 only: no fix mode, no kept-file clause, no node --check, no plugin-config line', () => {
    const all = `${text('SKILL.md')}\n${text('references/refusals.md')}\n${text('scripts/knip-at-base')}`;
    assert.doesNotMatch(all, /knip-at-base fix|--fix|keyword-only|node --check|knip's bytes|byte-exact|plugin config/i);
    assert.match(text('references/refusals.md'), /config: <knip config> is not in \.gate\/protected/);
  });
  test('says review still runs on a proved deletion, and the gate never depends on the skill', () => {
    assert.match(body, /`review` still runs on a proved deletion/);
    assert.match(body, /The proof is the gate's/);
  });
  test('every refusal the module can print has a row in the reference', () => {
    const refusals = text('references/refusals.md');
    for (const line of ['config: <file> holds the key', 'config: knip has no config', 'is not in .gate/protected', 'check 1:', 'check 2:', 'check 3: knip did not list', 'check 3: the base could not be prepared', 'knip could not run']) {
      assert.ok(refusals.includes(line), line);
    }
  });
});

describe('scripts/knip-at-base report', () => {
  let r;
  before(() => {
    r = moduleRepo({ 'src/old.js': 'export const old = 1;\n', 'src/lib.js': 'export const lib = 1;\n' });
    // A branch off origin/main, as an agent would start one, so the gate_prepare main holds is the one knip-at-base runs.
    git(r.repo, 'switch', '-q', '-C', 'skill', 'origin/main');
  });
  after(() => r.cleanup());
  const knipAtBase = (args, env = r.env()) => run(r.repo, join(r.repo, '.claude/skills/deletion-proof/scripts/knip-at-base'), args, env);

  test('is laid in the repository that turns the module on, with the skill, and is executable', () => {
    for (const f of ['SKILL.md', 'references/refusals.md', 'scripts/knip-at-base']) assert.ok(existsSync(join(r.repo, '.claude/skills/deletion-proof', f)), f);
    assert.ok(statSync(join(r.repo, '.claude/skills/deletion-proof/scripts/knip-at-base')).mode & 0o111);
  });
  test('prints the merge-base and the whole files knip lists as unused there, as JSON, from a worktree of the base', () => {
    const out = knipAtBase(['report'], r.env(report(fl('src/old.js'), entry('src/lib.js', { exports: [{ name: 'lib' }] }))));
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(JSON.parse(out.out), { base: git(r.repo, 'merge-base', 'HEAD', 'origin/main'), files: ['src/old.js'] });
    assert.match(readFileSync(r.log, 'utf8'), /prepared=yes args=--yes knip@6\.42\.1 --reporter json/);
    assert.equal(git(r.repo, 'worktree', 'list').split('\n').length, 1, 'the worktree is removed');
  });
  test('--help shows the usage and the exit codes; an unknown mode, and fix, exit 2', () => {
    const help = knipAtBase(['--help']);
    assert.equal(help.code, 0, help.out);
    assert.match(help.out, /knip-at-base report/);
    assert.match(help.out, /Exit: 0 done; 2 usage or a git error; 3 the proof is off; 4 /);
    assert.equal(knipAtBase([]).code, 2);
    const fix = knipAtBase(['fix', 'src/old.js']);
    assert.equal(fix.code, 2, fix.out);
    assert.match(fix.out, /say report/);
  });
  test('exits 4 with the reason on stderr when knip cannot run, and 3 when origin/main does not name the module', () => {
    const bad = knipAtBase(['report'], r.env('boom\n', { FAKE_KNIP_EXIT: '2' }));
    assert.equal(bad.code, 4, bad.out);
    assert.match(bad.out, /knip could not run \(exit 2\)/);
    git(r.repo, 'switch', '-q', 'main');
    git(r.repo, 'mv', '.gate/modules', '.gate/modules.off');
    git(r.repo, 'commit', '-qm', 'turn the module off on main', '--no-verify');
    git(r.repo, 'push', '-q', 'origin', 'main');
    git(r.repo, 'switch', '-q', 'work');
    const off = knipAtBase(['report']);
    assert.equal(off.code, 3, off.out);
    assert.match(off.out, /the proof is off: .*\.gate\/modules.*does not list deletion-proof/);
  });
});

describe('the module\'s fixtures', () => {
  let r;
  before(() => (r = moduleRepo()));
  after(() => r.cleanup());

  test('prove-check --all runs the four of them with main\'s seven, and each fails its check for its own reason', () => {
    const names = ['red-check-deletion-modifies', 'red-check-deletion-named', 'red-check-deletion-unlisted', 'red-check-deletion-unprotected'];
    for (const n of names) assert.ok(existsSync(join(r.repo, `.gate/proofs/${n}.sh`)), n);
    const out = script(r.repo, 'prove-check', ['--all']);
    assert.equal(out.code, 0, out.out);
    assert.equal(out.out, 'prove-check: 11 checks fail on their fixtures\n');
    for (const n of names) assert.equal(script(r.repo, 'prove-check', [n]).out, 'prove-check: 1 checks fail on their fixtures\n', n);
  });
});
