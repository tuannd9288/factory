// The gate's four settings (#335): which reviewer `review` runs, and the runners of main's jobs, of the candidate's verify
// and of the trusted jobs that hold the reviewer's credential. They live in the kit's workflow files on the repository's
// main, filled in for each repository the way .github/CODEOWNERS gets its owner: a runner as the `runs-on:` of every job in
// its file, the reviewer as the workflow-level env GATE_REVIEWER of gate-trusted.yml, whose copy on main is the one
// pull_request_target runs. Changing one is a pull request under /.github: tier 3, the Human's approval. Until #335 they
// were repository variables, which change without a pull request.
//   bin/onboard fills them in, bin/kit-update carries them from the base, bin/kit-evidence names them and checks the runner
//   rule, and bin/onboard-owner and bin/onboard-doctor read them back from main.
//   node bin/lib/gate-settings.mjs check [options]                  the options' problems, exit 2 on any
//   node bin/lib/gate-settings.mjs render <path> --human <login> [options]   fills in the kit file at <path>, in place
// The options: --reviewer stub|claude|entire ('' for none), and --runner, --pr-runner, --trusted-runner <json>
// ("ubuntu-latest" or ["self-hosted","macOS"]).
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAIN = '.github/workflows/main.yml';
export const GATE = '.github/workflows/gate.yml';
export const TRUSTED = '.github/workflows/gate-trusted.yml';
export const WORKFLOWS = [MAIN, GATE, TRUSTED];
/** The settings: each with its option, the repository variable that held it before #335, the file that holds it now, and
 * the words that name it in a message. */
export const SETTINGS = [
  { key: 'reviewer', option: '--reviewer', variable: 'GATE_REVIEWER', file: TRUSTED, words: 'the reviewer' },
  { key: 'runner', option: '--runner', variable: 'GATE_RUNNER', file: MAIN, words: "main's runner" },
  { key: 'prRunner', option: '--pr-runner', variable: 'GATE_PR_RUNNER', file: GATE, words: "the candidate's runner" },
  { key: 'trustedRunner', option: '--trusted-runner', variable: 'GATE_TRUSTED_RUNNER', file: TRUSTED, words: 'the trusted runner' },
];
export const REVIEWERS = ['stub', 'claude', 'entire'];
const HOSTED_DEFAULT = ['ubuntu-latest'];
/** The kit's own lines, which are also what a repository that sets nothing holds: GitHub-hosted Ubuntu, and no reviewer,
 * so `review` and `verdict` fail closed. */
export const DEFAULTS = { reviewer: '', runner: HOSTED_DEFAULT, prRunner: HOSTED_DEFAULT, trustedRunner: HOSTED_DEFAULT };
const runsOn = (labels) => `runs-on: ${JSON.stringify(labels)}`;
const reviewerLine = (name) => `GATE_REVIEWER: '${name}'`;
const KIT_RUNS_ON = runsOn(HOSTED_DEFAULT);
const KIT_REVIEWER = reviewerLine('');

const LABEL = /^[\w.-]+$/;
/** GitHub-hosted: one label, an OS name and then `latest` or a version (ubuntu-24.04-arm, macos-15-xlarge); macos-mini is not. */
const HOSTED = /^(ubuntu|macos|windows)-(latest|\d[\w.]*)(-[\w.]+)?$/i;
/** Labels every self-hosted runner of one kind carries: sharing them is no sharing of a runner. */
const GENERIC = new Set(['self-hosted', 'linux', 'macos', 'windows', 'x86', 'x64', 'arm', 'arm64']);

/** What a kit file needs filled in: [from, to] pairs, each applied to the first match on every line, as sed's s/from/to/. */
export const FILLED = {
  '.github/CODEOWNERS': (v) => [['@OWNER', `@${v.human}`]],
  [MAIN]: (v) => [[KIT_RUNS_ON, runsOn(v.runner ?? DEFAULTS.runner)]],
  [GATE]: (v) => [[KIT_RUNS_ON, runsOn(v.prRunner ?? DEFAULTS.prRunner)]],
  [TRUSTED]: (v) => [
    [KIT_RUNS_ON, runsOn(v.trustedRunner ?? DEFAULTS.trustedRunner)],
    [KIT_REVIEWER, reviewerLine(v.reviewer ?? DEFAULTS.reviewer)],
  ],
};

/** A kit file as bin/onboard fills it in, or null for a file the kit does not fill in. values: { human, reviewer, runner,
 * prRunner, trustedRunner }; a setting left out is the kit's default. */
export function render(path, text, values) {
  if (!FILLED[path]) return null;
  const pairs = FILLED[path](values);
  return text
    .split('\n')
    .map((line) => pairs.reduce((l, [from, to]) => l.replace(from, () => to), line))
    .join('\n');
}

/** A runner as JSON, the form an option gives it in: a label, or a list of labels. Returns { labels, text } with the value
 * in one form, or null when it is not one. */
export function parseRunner(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const labels = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(labels) || !labels.length || !labels.every((l) => typeof l === 'string' && LABEL.test(l))) return null;
  return { labels, text: JSON.stringify(value) };
}

/** The settings a workflow file holds, as its filled-in lines give them: { key: value } for each it holds in the kit's
 * form, and nothing for one it does not (the old kit's `${{ vars.X }}`, two jobs on different runners, a value of the
 * wrong form). The caller compares the file with the kit filled in with these, so a file that holds more than that fails. */
export function valuesOf(path, text) {
  const found = {};
  const runner = SETTINGS.find((s) => s.file === path && s.key !== 'reviewer');
  if (runner) {
    const seen = [...new Set(text.split('\n').map((l) => /^\s*runs-on: (.*)$/.exec(l)?.[1]).filter((v) => v !== undefined))];
    const parsed = seen.length === 1 ? parseRunner(seen[0]) : null;
    if (parsed && Array.isArray(JSON.parse(seen[0]))) found[runner.key] = parsed.labels;
  }
  if (path === TRUSTED) {
    const names = text.split('\n').map((l) => /^\s*GATE_REVIEWER: '([a-z]*)'$/.exec(l)?.[1]).filter((v) => v !== undefined);
    if (names.length === 1 && ['', ...REVIEWERS].includes(names[0])) found.reviewer = names[0];
  }
  return found;
}

/** The settings of a set of workflow files ({ path: text }), each from the file that holds it. */
export function valuesIn(files) {
  return Object.assign({}, ...WORKFLOWS.filter((p) => typeof files[p] === 'string').map((p) => valuesOf(p, files[p])));
}

/** Whether a workflow's text reads a gate variable, as the kit did before #335. */
export const readsVariables = (text) => /\bvars\.GATE_/.test(text);

/** Whether a runner's labels name one GitHub-hosted machine. */
export const isHosted = (labels) => labels.length === 1 && HOSTED.test(labels[0]);
const selfHosted = (labels) => !isHosted(labels);

/** Whether a job on runner `a` can land on a machine that serves runner `b`, or the reverse: GitHub gives a job to any
 * runner that carries every label of its runs-on, so one label set inside the other reaches the same machine; so does a
 * label both hold beyond self-hosted, the operating system and the architecture. */
function reaches(a, b) {
  const [x, y] = [a, b].map((labels) => new Set(labels.map((l) => l.toLowerCase())));
  const inside = (s, t) => [...s].every((l) => t.has(l));
  return inside(x, y) || inside(y, x) || [...x].some((l) => y.has(l) && !GENERIC.has(l));
}

/** The runner rule of kit/.gate/enforced-rules.md as far as the factory can know it, without the #155 exception: of the
 * trusted runner, the candidate's and main's, no two self-hosted ones reach the same machine. GitHub-hosted runners are
 * fresh for each job, so the same one for all three is fine. A deploy's runner is not known here. */
export function sharedRunners(values) {
  const v = { ...DEFAULTS, ...values };
  const words = (key) => SETTINGS.find((s) => s.key === key).words;
  const problems = [];
  for (const [a, b] of [['trustedRunner', 'runner'], ['trustedRunner', 'prRunner'], ['prRunner', 'runner']]) {
    if (selfHosted(v[a]) && selfHosted(v[b]) && reaches(v[a], v[b])) problems.push(`${words(a)} is self-hosted and shares a machine with ${words(b)}`);
  }
  return problems;
}

/** The runner rule with the Human's exception (#155): with the reviewer entire and no reviewer secret in the environment
 * `reviewer`, the jobs hold no reviewer credential and may share self-hosted runners. The factory reads no secret, so the
 * condition is the Human's to keep. */
export const runnerProblems = (values) => (values.reviewer === 'entire' ? [] : sharedRunners(values));

/** The settings the options give: { values } with each option given in the form the files hold, or { problem }. */
export function parseOptions(argv) {
  const values = {};
  for (let k = 0; k < argv.length; k += 2) {
    const setting = SETTINGS.find((s) => s.option === argv[k]);
    if (!setting) return { problem: `unknown argument ${argv[k]}` };
    const value = argv[k + 1];
    if (value === undefined) return { problem: `${argv[k]} needs a value` };
    if (setting.key === 'reviewer') {
      if (value !== '' && !REVIEWERS.includes(value)) return { problem: `--reviewer is ${REVIEWERS.join(', ')}, or '' for none` };
      values.reviewer = value;
    } else {
      const runner = parseRunner(value);
      if (!runner) return { problem: `${argv[k]} is a JSON runs-on value: a label as "ubuntu-latest", or a list as ["self-hosted","macOS"]` };
      values[setting.key] = runner.labels;
    }
  }
  return { values };
}

/** A setting's value in words: a reviewer's name, or a runner's labels as JSON. */
export const shown = (key, v) => (key === 'reviewer' ? (v === '' ? 'none (review and verdict fail closed)' : v) : JSON.stringify(v));

/** One line for each setting as values give it, and where it came from: `from` maps a key to its source's words. */
export const describe = (values, from = {}) =>
  SETTINGS.map((s) => `${s.words} (${s.file}): ${shown(s.key, values[s.key] ?? DEFAULTS[s.key])}${from[s.key] ? `, ${from[s.key]}` : ''}`);

function main([verb, ...rest]) {
  if (verb === 'check') {
    const { values, problem } = parseOptions(rest);
    const problems = problem ? [problem] : runnerProblems(values);
    if (problems.length) {
      console.log(problems.join('; '));
      return 2;
    }
    return 0;
  }
  if (verb === 'render' && rest.length >= 3 && rest[1] === '--human') {
    const [path, , human, ...options] = rest;
    const { values, problem } = parseOptions(options);
    if (problem || !FILLED[path]) {
      console.log(problem ?? `${path} is no file the kit fills in`);
      return 2;
    }
    writeFileSync(path, render(path, readFileSync(path, 'utf8'), { ...values, human }));
    return 0;
  }
  console.log('usage: node bin/lib/gate-settings.mjs check [options] | render <path> --human <login> [options]');
  return 2;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
