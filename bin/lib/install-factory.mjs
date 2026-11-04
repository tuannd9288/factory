// bin/lib/install-factory.mjs root|place|follow (#390): the parts of bin/install-factory that are not shell.
//   root    prints where this machine's installed copy of the factory is (installedRoot, bin/lib/factory.mjs)
//   place   prints `factory` on the factory host and `macbook` anywhere else (placeOf)
//   follow  brings the installed copy to origin/main by followMain (bin/lib/checkout.mjs), by the rules the Mac mini's sweep keeps ~/WORKSPACES
//           by: never under a live run, a refusal is in queue-checkout.failed and told here. Prints one line; exit 1 on a refusal.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { followMain } from './checkout.mjs';
import { contextOf, installedRoot, placeOf } from './factory.mjs';
import { liveRuns } from './seat.mjs';

/** The line for one `follow`, and its exit code. */
export function follow(env = process.env, move = followMain) {
  const root = installedRoot(env);
  const ctx = contextOf(env);
  const r = move({ root, state: ctx.state, live: () => liveRuns(ctx.runs), env });
  if (r.status === 'refused') return { code: 1, line: `install-factory: ${root} is not moved: ${r.why}` };
  if (r.status === 'updated') return { code: 0, line: `install-factory: ${root} moved ${r.from.slice(0, 7)}..${r.to.slice(0, 7)} (${r.behind} commits)` };
  return { code: 0, line: `install-factory: ${root} is ${r.status}` };
}

export function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (rest.length) throw new Error('usage: install-factory.mjs root|place|follow');
  if (command === 'root') return { code: 0, line: installedRoot(env) };
  if (command === 'place') return { code: 0, line: placeOf(env) };
  if (command === 'follow') return follow(env);
  throw new Error('usage: install-factory.mjs root|place|follow');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = main(process.argv.slice(2));
    (r.code === 0 ? console.log : console.error)(r.line);
    process.exitCode = r.code;
  } catch (error) {
    console.error(`install-factory: ${error.message}`);
    process.exitCode = 2;
  }
}
