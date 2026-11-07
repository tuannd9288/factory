// bin/lib/models.mjs (INN-39, contract H7): the factory's one table of models and efforts, bin/lib/models.json, for every role that
// runs from the factory checkout: the seats (bin/lib/seat.mjs), the pack Lead (packs/pstack/bin/lead.mjs), the MacBook Lead and Colly
// (bin/lib/factory.mjs), the Watcher (bin/lib/reader.mjs), `factory codex` (packs/pstack/bin/codex-step.mjs) and the pstack role lines a
// Lead's profile gets as rules/pstack-models.md, which Claude Code loads with the user memory (2.1.319). The gate's reviewer keeps its own
// pin in the kit (kit/.gate/bin/lib/reviewer.json): a served repository's CI has no factory checkout. test/models.test.mjs checks both.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'models.json');

/** The table as models.json holds it. */
export const MODELS = JSON.parse(readFileSync(MODELS_FILE, 'utf8'));

/** The value that passes no model or effort, so the harness's own default applies. */
export const INHERIT = 'inherit';

/** Claude Code's arguments for a role's entry: `--model` and `--effort`, each left out when the entry says inherit. */
export function claudeModelArgs(entry) {
  return [...(entry.model !== INHERIT ? ['--model', entry.model] : []), ...(entry.effort !== INHERIT ? ['--effort', entry.effort] : [])];
}

const PSTACK_HEAD = [
  '# pstack model configuration. One line per role. Delete a line to fall back to the skill default.',
  '# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.',
  "# `codex <effort>` as a value (the factory, #182): that seat is another model family and no Agent: run `factory codex --role <arena-runner|cross-judge|architect-runner|interrogate-reviewer> --effort <effort>` with its brief on stdin, adding `--write <its worktree>` for a seat that writes; its stdout is the seat's report. Exit 3: the seat waits for Codex; say so, and never run it on Claude.",
];

/** The text of a Lead profile's rules/pstack-models.md, rendered from the table's pstack entry: pstack's own rule-file shape (setup-pstack). */
export function pstackModels(pstack = MODELS.pstack) {
  return `${[...PSTACK_HEAD, `# budget: ${pstack.budget}`, ...Object.entries(pstack.roles).map(([role, value]) => `${role}: ${value}`)].join('\n')}\n`;
}
