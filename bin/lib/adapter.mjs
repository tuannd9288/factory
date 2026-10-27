// The adapter lines bin/onboard appends to .gate/config.sh for a repository that keeps its own verify: GATE_NATIVE names
// it, "native" joins GATE_CHECKS, and gate_fast calls the repository's own pre-commit hook (one source, no copy). bin/kit-evidence
// rebuilds the block from the same facts, so the two agree on what onboard may write.
//   node bin/lib/adapter.mjs <repository dir>   prints the block for the files the work tree holds ("" when none)
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE = 'scripts/verify';
export const HOOK = '.githooks/pre-commit';

/** The block for a repository that has (native) its own scripts/verify and (hookText) the text of its pre-commit hook,
 * or null; an empty string when it has no scripts/verify. A hook that calls .gate/bin/verify is not folded: a loop. */
export function adapterBlock({ native, hookText }) {
  if (!native) return '';
  const lines = ['', "# --- adapter, written by bin/onboard from the repository's own files ---", `GATE_NATIVE=${NATIVE}`, 'GATE_CHECKS="native"'];
  if (hookText !== null && !hookText.includes('.gate/bin/verify')) lines.push(`gate_fast() { ${HOOK}; }`);
  return `${lines.join('\n')}\n`;
}

function main([dir]) {
  if (!dir) {
    console.log('usage: node bin/lib/adapter.mjs <repository dir>');
    return 2;
  }
  const hook = join(dir, HOOK);
  process.stdout.write(adapterBlock({ native: existsSync(join(dir, NATIVE)), hookText: existsSync(hook) ? readFileSync(hook, 'utf8') : null }));
  return 0;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
