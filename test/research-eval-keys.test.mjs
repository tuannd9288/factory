// The research eval's answer keys (#92): each fact of a key names where it was read, and `verifyTask` re-reads it, so a
// key that no longer holds on disk is found by a command and not by a model. The fixtures here are a temporary runs folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keys = () => import('../probes/research-eval/keys.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

function runs(body) {
  const root = mkdtempSync(join(tmpdir(), 'reval-'));
  try {
    mkdirSync(join(root, 'issue-9/src/plugins/a'), { recursive: true });
    mkdirSync(join(root, 'issue-9/src/plugins/b'), { recursive: true });
    mkdirSync(join(root, 'issue-9/src/plugins/c'), { recursive: true });
    writeFileSync(join(root, 'issue-9/package.json'), '{\n  "name": "x",\n  "dep": "^0.154.0"\n}\n');
    for (const [dir, text] of [['a', 'resolveConfig'], ['b', 'resolveConfig and more'], ['c', 'nothing']]) writeFileSync(join(root, 'issue-9/src/plugins', dir, 'index.ts'), `${text}\n`);
    git(join(root, 'issue-9'), 'init', '-q');
    git(join(root, 'issue-9'), 'add', '-A');
    git(join(root, 'issue-9'), 'commit', '-q', '-m', 'first');
    return body(root, git(join(root, 'issue-9'), 'rev-parse', 'HEAD'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const task = (facts) => ({ id: 't', title: 'T', sources: ['issue-9'], facts, unreadable: { id: 'F9', ask: 'x', topic: 'x' } });

test('a fact whose source line holds the text, whose git output is the answer, or whose count is right, verifies', async () => {
  const { verifyTask } = await keys();
  runs((root, head) => {
    const t = task([
      { id: 'F1', source: { file: 'issue-9/package.json', line: 3, has: '"dep": "^0.154.0"' } },
      { id: 'F2', source: { git: 'issue-9', args: ['rev-parse', 'HEAD'], out: head } },
      { id: 'F3', source: { git: 'issue-9', args: ['rev-list', '--count', 'HEAD'], out: '1' } },
      { id: 'F4', source: { git: 'issue-9', args: ['ls-files'], lines: 4 } },
      { id: 'F5', source: { dir: 'issue-9/src/plugins', name: 'index.ts', has: 'resolveConfig', count: 2 } },
    ]);
    assert.deepEqual(verifyTask(t, root), []);
  });
});

test('a fact that does not hold is named with what the disk has', async () => {
  const { verifyTask } = await keys();
  runs((root) => {
    const t = task([
      { id: 'F1', source: { file: 'issue-9/package.json', line: 2, has: '"dep"' } },
      { id: 'F2', source: { git: 'issue-9', args: ['rev-list', '--count', 'HEAD'], out: '2' } },
      { id: 'F3', source: { git: 'issue-9', args: ['ls-files'], lines: 5 } },
      { id: 'F4', source: { dir: 'issue-9/src/plugins', name: 'index.ts', has: 'resolveConfig', count: 3 } },
      { id: 'F5', source: { file: 'issue-9/missing.json', line: 1, has: 'x' } },
      { id: 'F6' },
    ]);
    const problems = verifyTask(t, root);
    assert.deepEqual(problems.map((p) => p.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
    assert.match(problems[0].why, /line 2 is "  "name": "x","/);
    assert.match(problems[1].why, /"1"/);
    assert.match(problems[2].why, /4/);
    assert.match(problems[3].why, /2/);
    assert.match(problems[4].why, /missing\.json/);
    assert.match(problems[5].why, /no source/);
  });
});

test('git is run with a fixed list of read-only subcommands, and only on a folder under the runs folder', async () => {
  const { verifyTask } = await keys();
  runs((root) => {
    const t = task([
      { id: 'F1', source: { git: 'issue-9', args: ['checkout', '-q', 'HEAD'], out: '' } },
      { id: 'F2', source: { git: '../escape', args: ['rev-parse', 'HEAD'], out: 'x' } },
      { id: 'F3', source: { file: '../etc/passwd', line: 1, has: 'root' } },
    ]);
    const problems = verifyTask(t, root);
    assert.deepEqual(problems.map((p) => p.id), ['F1', 'F2', 'F3']);
    for (const p of problems) assert.match(p.why, /not allowed|outside/);
  });
});

test('validateTask accepts 4 to 6 facts with a source, a matching pattern and a citation each, and refuses anything else', async () => {
  const { validateTask } = await keys();
  const fact = (n) => ({ id: `F${n}`, ask: 'a', all: ['x'], cite: 'y', source: { file: 'issue-9/package.json', line: 1, has: '{' } });
  const ok = { id: 't', title: 'T', sources: ['issue-9'], facts: [1, 2, 3, 4].map(fact), unreadable: { id: 'F5', ask: 'a', topic: 'z' } };
  assert.deepEqual(validateTask(ok), []);
  const wrong = (patch) => validateTask({ ...ok, ...patch }).join('; ');
  assert.match(wrong({ facts: [1, 2, 3].map(fact), unreadable: { id: 'F4', ask: 'a', topic: 'z' } }), /4 to 6 facts/);
  assert.match(wrong({ facts: [1, 2, 3, 4, 5, 6, 7].map(fact), unreadable: { id: 'F8', ask: 'a', topic: 'z' } }), /4 to 6 facts/);
  assert.match(wrong({ unreadable: { id: 'F4', ask: 'a', topic: 'z' } }), /ids/);
  assert.match(wrong({ facts: [1, 2, 3, 4].map((n) => ({ ...fact(n), all: n === 2 ? ['('] : ['x'] })) }), /F2.*pattern/);
  assert.match(wrong({ facts: [1, 2, 3, 4].map((n) => (n === 3 ? { ...fact(n), source: undefined } : fact(n))) }), /F3.*source/);
  assert.match(wrong({ facts: [1, 2, 3, 4].map((n) => (n === 4 ? { ...fact(n), cite: undefined } : fact(n))) }), /F4.*cite/);
  assert.match(wrong({ unreadable: { id: 'F5', ask: 'a', topic: '[' } }), /topic/);
  assert.match(wrong({ sources: [] }), /sources/);
});
