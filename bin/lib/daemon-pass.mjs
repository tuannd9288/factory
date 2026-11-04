// One pass of the sweep, run by the daemon in a worker thread of its own (#399, bin/lib/daemon.mjs): the queue's runPass, unchanged, with the
// job's environment (a worker's process.env is a copy of the daemon's, which is the job's). It posts back { type: 'pass', code, heldBy, moved }.
// A pass that raises is told as the queue's own command tells it: queue-run.failed, so the digest shows it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { runPass } from './queue.mjs';

const { state, human } = workerData;
try {
  parentPort.postMessage({ type: 'pass', ...runPass({ repos: [], human, state }) });
} catch (error) {
  const why = String(error.stderr || error.message).trim();
  console.error(`factory-daemon: the pass raised: ${why}`);
  try {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'queue-run.failed'), `${new Date().toISOString()} ${why}\n`);
  } catch {}
}
