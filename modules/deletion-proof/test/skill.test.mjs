// The module's skill follows the Agent Skills specification (agentskills.io/specification), and its script and fixtures work.
// The skill is guidance for an agent; the gate never depends on it. Step 1 ships the whole-file parts only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

// Claude Code loads the skill from its front matter (agentskills.io/specification): the name must be the folder's, and the
// one tool the skill grants must be a script the module lays. Retention bar: a key Claude Code reads, outside this repository.
describe('the skill loads', () => {
  const { front } = parse(text('SKILL.md'));

  test('front matter: the name is the folder\'s and a valid skill name; the description is not empty and at most 1024 characters', () => {
    assert.equal(front.name, SKILL.split('/').at(-1));
    assert.match(front.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(front.name.length <= 64);
    assert.ok(front.description.length > 0 && front.description.length <= 1024, `${front.description.length} characters`);
  });
  test('allowed-tools grants a script the module lays, by a path with no variable', () => {
    const grant = /^Bash\((\S+) \*\)$/.exec(front['allowed-tools']);
    assert.ok(grant, front['allowed-tools']);
    assert.doesNotMatch(grant[1], /[$`]/);
    const laid = join(MODULE, 'kit', grant[1]);
    assert.ok(statSync(laid).isFile() && statSync(laid).mode & 0o111, `${grant[1]} is an executable file under the module's kit/`);
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
