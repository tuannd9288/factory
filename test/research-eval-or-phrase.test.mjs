// The research eval's grader (#92, re-review 2): an "or" is let through only as the right answer's own phrase, so that "3.9 or
// 3.10" and "Android 6.0 or 7.0" do not score where "3.10 or newer" and "Android 7.0 or newer" do.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tasks = async () => {
  const { loadTasks } = await import('../probes/research-eval/keys.mjs');
  return Object.fromEntries(loadTasks().map((t) => [t.id, t]));
};

async function scores(task, id, entry) {
  const { grade } = await import('../probes/research-eval/grade.mjs');
  const t = (await tasks())[task];
  const evidence = [...t.facts.map((f) => (f.id === id ? entry : f.example)), `${t.unreadable.id}: not readable`];
  return grade(t, { conclusion: 'c', evidence, couldNotRead: [t.unreadable.example], needsHuman: [] }).facts.find((f) => f.id === id).ok;
}

test('an "or" between two values is a hedge on the facts whose right answer holds an "or" too', async () => {
  assert.equal(await scores('small-tools', 'F5', 'F5: 3.9 or 3.10 — pyproject.toml:12'), false);
  assert.equal(await scores('t3code-defaults', 'F5', 'F5: Android 6.0 or 7.0 — docs/user/mobile-notifications.md:9'), false);
  assert.equal(await scores('herdr-api', 'F5', 'F5: idle or working, blocked, done, unknown — docs/versions/0.9.5/website/src/content/docs/socket-api.mdx:421'), false);
  assert.equal(await scores('round4-review', 'F3', 'F3: .js or .ts, .mjs, .cjs, .mts, .cts — kit/scripts/lib/deletion.mjs:105'), false);
  assert.equal(await scores('rex-docs', 'F3', 'F3: Rex does not collect telemetry or analytics; no account or license checks — inputs/raw/rex-llms-full.txt:3329'), false);
});

test('the right answer\'s own phrase with its "or" still scores', async () => {
  assert.equal(await scores('small-tools', 'F5', 'F5: Python 3.10 or newer — pyproject.toml:12'), true);
  assert.equal(await scores('t3code-defaults', 'F5', 'F5: Android 7.0 or newer — docs/user/mobile-notifications.md:9'), true);
  assert.equal(await scores('herdr-api', 'F5', 'F5: idle, working, blocked, done, or unknown — docs/versions/0.9.5/website/src/content/docs/socket-api.mdx:421'), true);
  assert.equal(await scores('round4-review', 'F3', 'F3: .js, .mjs, .cjs, .ts, .mts or .cts — kit/scripts/lib/deletion.mjs:105'), true);
  assert.equal(await scores('rex-docs', 'F3', 'F3: Rex does not collect telemetry; no account or licence checks — inputs/raw/rex-llms-full.txt:3329'), true);
});

test('the right answer in the other words of its phrase scores (re-review 3)', async () => {
  assert.equal(await scores('herdr-api', 'F5', 'F5: idle, working, blocked, done or unknown — docs/versions/0.9.5/website/src/content/docs/socket-api.mdx:421'), true);
  assert.equal(await scores('small-tools', 'F5', 'F5: 3.10 or later — pyproject.toml:12'), true);
  assert.equal(await scores('small-tools', 'F5', 'F5: Python 3.10 or higher — pyproject.toml:12'), true);
  assert.equal(await scores('t3code-defaults', 'F5', 'F5: Android 7.0 or later — docs/user/mobile-notifications.md:9'), true);
  assert.equal(await scores('herdr-api', 'F5', 'F5: idle, working, blocked, done, or unknown (or stale) — docs/versions/0.9.5/website/src/content/docs/socket-api.mdx:421'), false);
  assert.equal(await scores('small-tools', 'F5', 'F5: 3.9 or later or 3.10 — pyproject.toml:12'), false);
});
