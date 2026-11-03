// The command of the overview page (#369), run through bin/factory-page, whose header says what it prints. It reads one fresh snapshot and
// prints the view model or the page; it serves nothing and knows no host. The rendering is page.mjs's.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { snapshot as readSnapshot } from './top.mjs';
import { pageOf, viewOf } from './page.mjs';

const USAGE = 'usage: factory-page view|html';

/** Runs one verb: `view` prints the view model as JSON, `html` prints the page. `snapshot`, `write` and `fail` are injected so that a test
 * needs neither the machine nor a terminal. Returns the exit code. */
export async function main(argv, { snapshot = readSnapshot, write = (text) => process.stdout.write(text), fail = (text) => console.error(text) } = {}) {
  const [verb, ...rest] = argv;
  if (!['view', 'html'].includes(verb) || rest.length) {
    fail(USAGE);
    return 2;
  }
  const view = viewOf(await snapshot());
  write(verb === 'view' ? `${JSON.stringify(view)}\n` : pageOf(view));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`factory-page: ${String(error.message).trim().split('\n')[0]}`);
    process.exitCode = 1;
  }
}
