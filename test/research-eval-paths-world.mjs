// The fixture of the path check's unit tests (#92): a runs folder with a session's run folder, work folder and one readable folder,
// and the paths that outsidePaths finds in a Bash command run by that session.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outsidePaths } from '../probes/research-eval/paths.mjs';

export function pathWorld(body) {
  const root = mkdtempSync(join(tmpdir(), 'reval-path-'));
  const w = { root, home: root, runs: join(root, 'factory-runs') };
  w.run = join(w.runs, 're-probe-knip-reader-B-1');
  w.work = join(root, 'scratch/work/re-knip-reader-B-1');
  w.readable = join(w.runs, 'issue-70/sources/knip');
  for (const d of [w.run, w.work, w.readable]) mkdirSync(d, { recursive: true });
  // The paths a Bash command of the session reads outside its folders, as the check lists them.
  w.outside = (command) => outsidePaths(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }),
    { cwd: w.work, inside: [w.run, w.work, w.readable], home: w.home }).map((x) => x.path);
  try {
    return body(w);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
