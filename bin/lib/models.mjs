// bin/lib/models.mjs (INN-39, contract H7): the factory's one table of models and efforts, bin/lib/models.json, for every role that
// runs from the factory checkout: the seats (bin/lib/seat.mjs), the pack Lead (packs/pstack/bin/lead.mjs), the MacBook Lead and Colly
// (bin/lib/factory.mjs), `factory codex` (packs/pstack/bin/codex-step.mjs) and the pstack role lines a Lead's profile gets as
// rules/pstack-models.md, which Claude Code loads with the user memory (2.1.319). The Watcher keeps its own frozen setting,
// bin/lib/reader.json (docs/decisions.md, "The Watcher's freeze, 2026-11-07"), tested by test/reader.test.mjs. The gate's reviewer keeps its
// own pin in the kit (kit/.gate/bin/lib/reviewer.json): a served repository's CI has no factory checkout. Each launcher takes the table as
// an argument, this one by default, and its test gives it a made-up one (test/models.test.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'models.json');

/** The table as models.json holds it. */
export const MODELS = JSON.parse(readFileSync(MODELS_FILE, 'utf8'));

/** The value that passes no model or effort, so the harness's own default applies. */
export const INHERIT = 'inherit';

const MODEL_VALUE = /^[A-Za-z0-9][\w.:/-]*$/;
const EFFORT_VALUE = /^[a-z]+$/;

/**
 * A role's entry in a table, by its path (`entryOf(MODELS, 'seats', 'worker')`, `entryOf(MODELS, 'lead', 'here')`), as { model, effort }:
 * a key the entry leaves out is inherit. Throws naming the role when the table has no such entry or a value is neither inherit nor a plain
 * model or effort name, so a launcher refuses to start rather than pass a wrong or missing flag.
 */
export function entryOf(models, ...path) {
  const name = path.join('.');
  const entry = path.reduce((at, key) => (at !== null && typeof at === 'object' && !Array.isArray(at) ? at[key] : undefined), models);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`models: the table has no entry for ${name}`);
  const model = entry.model ?? INHERIT;
  const effort = entry.effort ?? INHERIT;
  if (model !== INHERIT && (typeof model !== 'string' || !MODEL_VALUE.test(model))) throw new Error(`models: ${name} has no usable model: ${JSON.stringify(model)}`);
  if (effort !== INHERIT && (typeof effort !== 'string' || !EFFORT_VALUE.test(effort))) throw new Error(`models: ${name} has no usable effort: ${JSON.stringify(effort)}`);
  return { model, effort };
}

/** Claude Code's arguments for a role's entry: `--model` and `--effort`, each left out when the entry says inherit. */
export function claudeModelArgs(entry) {
  return [...(entry.model !== INHERIT ? ['--model', entry.model] : []), ...(entry.effort !== INHERIT ? ['--effort', entry.effort] : [])];
}

const PSTACK_HEAD = [
  '# pstack model configuration. One line per role. Delete a line to fall back to the skill default.',
  '# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.',
  "# `codex <effort>` as a value (the factory, #182): that seat is another model family and no Agent: run `factory codex --role <arena-runner|cross-judge|architect-runner|interrogate-reviewer> --effort <effort>` with its brief on stdin, adding `--write <its worktree>` for a seat that writes; its stdout is the seat's report. Exit 3: the seat waits for Codex; say so, and never run it on Claude.",
];

/** The text of a Lead profile's rules/pstack-models.md, rendered from a table's pstack entry: pstack's own rule-file shape (setup-pstack).
 * Throws when the entry is not { budget, roles } of one-line strings, so no Lead starts on a half-written file. */
export function pstackModels(pstack) {
  const line = (v) => typeof v === 'string' && !/[\r\n]/.test(v);
  const roles = pstack?.roles;
  if (!line(pstack?.budget) || roles === null || typeof roles !== 'object' || Array.isArray(roles) || !Object.entries(roles).every(([k, v]) => line(k) && line(v)))
    throw new Error('models: the table has no usable entry for pstack');
  return `${[...PSTACK_HEAD, `# budget: ${pstack.budget}`, ...Object.entries(pstack.roles).map(([role, value]) => `${role}: ${value}`)].join('\n')}\n`;
}
