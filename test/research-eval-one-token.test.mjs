// The research eval's grader (#92, re-review 2): a fact with one value (a hash, a version, a count, a date) scores nothing when its
// answer holds a second token of the same shape, with no "or" or other word to say it is a guess: "11.24.1, 11.24.2" and
// "11.24.1/11.24.2". The entries are the re-review's own examples, on the real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function scores(task, id, entry) {
  const { loadTasks } = await import('../probes/research-eval/keys.mjs');
  const { grade } = await import('../probes/research-eval/grade.mjs');
  const t = loadTasks().find((x) => x.id === task);
  const evidence = [...t.facts.map((f) => (f.id === id ? entry : f.example)), `${t.unreadable.id}: not readable`];
  return grade(t, { conclusion: 'c', evidence, couldNotRead: [t.unreadable.example], needsHuman: [] }).facts.find((f) => f.id === id).ok;
}

test('a version with a second version beside it scores nothing; the right one alone does', async () => {
  assert.equal(await scores('knip-reader', 'F2', 'F2: 11.24.2 — packages/knip/package.json:102'), true);
  assert.equal(await scores('knip-reader', 'F2', 'F2: 11.24.1, 11.24.2 — packages/knip/package.json:102'), false);
  assert.equal(await scores('knip-reader', 'F2', 'F2: 11.24.1/11.24.2 — packages/knip/package.json:102'), false);
  assert.equal(await scores('knip-reader', 'F2', 'F2: 11.24.1, 11.24.2, 11.25.0 — packages/knip/package.json:102'), false);
});

test('the same holds for a hash, a count and a date; a short hash of the same commit is not a second one', async () => {
  const full = 'ee32ee6ca4c8826ca45f306041d9f8c5ffdaa335';
  assert.equal(await scores('knip-reader', 'F1', `F1: ${full} — git rev-parse HEAD`), true);
  assert.equal(await scores('knip-reader', 'F1', `F1: ${full}, 0123456789abcdef0123456789abcdef01234567 — git rev-parse HEAD`), false);
  assert.equal(await scores('knip-reader', 'F1', `F1: ee32ee6 (${full}) — git rev-parse HEAD`), true);
  assert.equal(await scores('knip-reader', 'F5', 'F5: 112, 113 — grep -l resolveConfig packages/knip/src/plugins/*/index.ts'), false);
  assert.equal(await scores('humanlayer-pins', 'F2', 'F2: 2107 — git rev-list --count HEAD'), true);
  assert.equal(await scores('humanlayer-pins', 'F2', 'F2: 2107, 2108 — git rev-list --count HEAD'), false);
  assert.equal(await scores('mycroft-pins', 'F3', 'F3: 2026-10-18, 2026-10-19 — git log --max-parents=0 --format=%cs'), false);
});

test('a second value of the same shape counts only when a list mark joins it to the first (re-review 3)', async () => {
  const right = [
    ['knip-reader', 'F5', 'F5: 112 of 199 plugin folders — grep -l resolveConfig packages/knip/src/plugins/*/index.ts'],
    ['agentrun-pins', 'F2', 'F2: 588 commits since 2026-09-23 — git rev-list --count HEAD'],
    ['knip-reader', 'F2', 'F2: oxc-resolver 11.24.2 (in knip 6.42.1) — packages/knip/package.json:102'],
    ['mycroft-pins', 'F4', 'F4: 1305a72ffe5ea29a9f5e7d576a7cf9334189c1ef (not c79c4106, which is line 20) — ios/project.yml:23'],
    ['humanlayer-pins', 'F3', 'F3: 5,856 files — git ls-files | wc -l'],
    ['round4-review', 'F1', 'F1: 3 commits: 9938d14, 6bc9104, a2f6aa4 — git -C issue-17/w17 rev-list --count aedffb0..a2f6aa4'],
  ];
  for (const [task, id, entry] of right) assert.equal(await scores(task, id, entry), true, entry);
  const wrong = [
    ['small-tools', 'F5', 'F5: 3.9 or newer (3.10) — pyproject.toml:12'],
    ['knip-reader', 'F5', 'F5: 112 [111 by git grep] — grep -l resolveConfig'],
    ['knip-reader', 'F2', 'F2: 11.24.2-11.25.0 — packages/knip/package.json:102'],
    ['paseo-daemon', 'F3', 'F3: 6767 and 6768 — packages/server/src/server/config.ts:38'],
    ['agentrun-pins', 'F3', 'F3: 2026-09-23, 2026-09-24 — git log --max-parents=0'],
    ['mycroft-pins', 'F2', 'F2: 37, 38 — git rev-list --count HEAD'],
  ];
  for (const [task, id, entry] of wrong) assert.equal(await scores(task, id, entry), false, entry);
});

test('a fact whose answer is words, not one figure, is not held to one token', async () => {
  assert.equal(await scores('rex-docs', 'F2', 'F2: state=blocked, kind=permission — inputs/raw/rex-llms-full.txt:2387'), true);
  assert.equal(await scores('round4-review', 'F2', 'F2: 25 tests, 21 failed — rev4/REVIEW.md:187'), true);
});
