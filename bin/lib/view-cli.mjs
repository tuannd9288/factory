// The command of the overview data (#369), run through bin/factory-view, whose header says what it prints. It reads one fresh snapshot and
// prints the view model as JSON; it serves nothing and knows no page or host.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { snapshot as readSnapshot } from './top.mjs';
import { viewOf } from './view.mjs';

const USAGE = 'usage: factory-view';

/** Prints the view model as JSON. `snapshot`, `write` and `fail` are injected so that a test needs neither the machine nor a terminal.
 * Any argument is a usage error. Returns the exit code. */
export async function main(argv, { snapshot = readSnapshot, write = (text) => process.stdout.write(text), fail = (text) => console.error(text) } = {}) {
  if (argv.length) {
    fail(USAGE);
    return 2;
  }
  write(`${JSON.stringify(viewOf(await snapshot()))}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-view: ${String(error.message).trim().split('\n')[0]}`);
    process.exitCode = 1;
  }
}
