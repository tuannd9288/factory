// One pass of the sweep, run by the daemon in a worker thread of its own (#399, bin/lib/daemon.mjs): the queue's runPass, unchanged, with the
// job's environment (a worker's process.env is a copy of the daemon's, which is the job's). It posts back { type: 'pass', code, heldBy, moved }.
// A pass that raises is told as the queue's own command tells it: queue-run.failed, so the digest shows it.
import { parentPort, workerData } from 'node:worker_threads';
import { createLinear } from './linear.mjs';
import { runPass } from './queue.mjs';
import { markFailed } from './status.mjs';

const { state, human } = workerData;
try {
  parentPort.postMessage({ type: 'pass', ...runPass({ repos: [], human, state }) });
} catch (error) {
  const why = String(error.stderr || error.message).trim();
  console.error(`factory-daemon: the pass raised: ${why}`);
  markFailed(state, 'queue-run', why);
}
// The Factory app's Linear token (#403, bin/lib/linear.mjs) is renewed here, 7 days before it ends, so no caller finds it dead. A host with no
// credentials stored does nothing; a failed mint has raised its own condition, so only a line is printed (never a token).
try {
  await createLinear({ state }).renew();
} catch (error) {
  console.log(`daemon: the Linear token could not be renewed: ${String(error.message).split('\n')[0].slice(0, 200)}`);
}
