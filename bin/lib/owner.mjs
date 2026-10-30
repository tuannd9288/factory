// The admin step of taking a repository in, run by Colly from the factory clone, on the Human's gh login, after his
// one approval of what it prints: it checks the repository is the one he names, by name and id, shows every change,
// and with --apply invites the agents' account (write), sets the four repository variables the kit reads (#210), then
// the factory's rulesets, and creates the reviewer environment, then reads back what it set; the gate's ruleset follows
// the repository variable GATE_REVIEWER (#155: entire has its own), as it is being set. It prints the four values it
// sets and no other variable's. It calls only gh against GitHub's API, with the factory's own files: never git, never the
// target's .envrc, scripts or hooks, so nothing the target holds runs with his authority. A second run changes
// nothing. See bin/onboard-owner for the arguments.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = {
  branches: join(here, '../rulesets/branches.json'),
  tags: join(here, '../rulesets/tags.json'),
  claims: join(here, '../rulesets/claims.json'),
  bootstrap: join(here, '../rulesets/bootstrap.json'),
  gate: join(here, '../../kit/.gate/ruleset.json'),
};
const ENV = 'reviewer';
/** The four repository variables the kit reads, each with the option that gives its value (#210). */
const OPTIONS = [['--runner', 'GATE_RUNNER'], ['--pr-runner', 'GATE_PR_RUNNER'], ['--trusted-runner', 'GATE_TRUSTED_RUNNER'], ['--reviewer', 'GATE_REVIEWER']];
const REVIEWERS = ['claude', 'entire'];
const LABEL = /^[\w.-]+$/;
const HOSTED = /^(ubuntu|macos|windows)-[\w.-]+$/i;
/** Labels every self-hosted runner of one kind carries: sharing them is no sharing of a runner. */
const GENERIC = new Set(['self-hosted', 'linux', 'macos', 'windows', 'x86', 'x64', 'arm', 'arm64']);
const CALL_MS = 60_000;
const BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };
/** #155: Entire's GitHub App, which posts the check "Entire Gates": read by the Human on 2026-10-29 from that check on
 * factory-onboard-scratch's head 485678f. An App's id never changes; main() asks GitHub that the slug still names it. */
export const ENTIRE_APP = { slug: 'entire', id: 2626939, check: 'Entire Gates' };

/** The kit's gate for a repository whose GATE_REVIEWER is entire: Entire reviews outside Actions, so review and verdict
 * judge nothing and are not required, and Entire's check is, pinned to its App. tier, which passes only on that check's
 * success (GitHub counts its neutral as passing), stays required. */
export function entireGate(gate) {
  return {
    ...gate,
    rules: gate.rules.map((r) =>
      r.type !== 'required_status_checks'
        ? r
        : {
            ...r,
            parameters: {
              ...r.parameters,
              required_status_checks: [
                ...r.parameters.required_status_checks.filter((c) => c.context !== 'review' && c.context !== 'verdict'),
                { context: ENTIRE_APP.check, integration_id: ENTIRE_APP.id },
              ],
            },
          },
    ),
  };
}

/** Whether every field of want holds in have; a field GitHub adds of its own is no difference. */
export function holds(want, have) {
  if (Array.isArray(want)) return Array.isArray(have) && want.length === have.length && want.every((w, i) => holds(w, have[i]));
  if (want && typeof want === 'object') return Boolean(have) && typeof have === 'object' && Object.entries(want).every(([k, v]) => holds(v, have[k]));
  return want === have;
}

/** A ruleset with its rules in one order, as GitHub may return them in another. */
const sorted = (r) => ({ ...r, rules: [...(r.rules ?? [])].sort((a, b) => a.type.localeCompare(b.type)) });

/** What the repository should hold: before the kit is on its default branch, a ruleset on every branch that refuses a
 * rewrite, one on every tag that refuses creation, update and deletion but for a repository admin, one on the claim refs
 * (claim/<n>) that refuses deletion and rewrite for everyone, and a bootstrap one on main that asks the Human to approve
 * the last push; after, the kit's gate in place of the bootstrap one, in its Entire variant when the reviewer is entire. */
export function wanted({ kitLanded, branch, reviewer, variables = {} }) {
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const gate = () => (reviewer === 'entire' ? entireGate(read(FILES.gate)) : read(FILES.gate));
  return {
    rulesets: [read(FILES.branches), read(FILES.tags), read(FILES.claims), kitLanded ? gate() : read(FILES.bootstrap)],
    drop: kitLanded ? [read(FILES.bootstrap).name] : [],
    branch,
    variables,
  };
}

/** A runner value as the workflows read it, `fromJSON(vars.X)`: a label, or a list of labels, in JSON. Returns
 * { labels, text } with the value in one form, or null when it is not one. */
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

/** The runner rule of kit/.gate/enforced-rules.md, as far as this command can know it: a self-hosted trusted runner
 * (any value but one GitHub-hosted label) is neither the runner of main's jobs nor of the candidate's, and shares no label
 * with them beyond self-hosted, the operating system and the architecture. GitHub-hosted runners are fresh for each job,
 * so the same one for all three is fine. A deploy's runner is not known here. `held` maps the variables' names to their
 * values; a value that is not a runs-on one is for another check. Returns reasons that name variables, never values. */
export function runnerProblems(held) {
  const trusted = parseRunner(held.GATE_TRUSTED_RUNNER ?? '"ubuntu-latest"');
  if (!trusted || (trusted.labels.length === 1 && HOSTED.test(trusted.labels[0]))) return [];
  const mine = new Set(trusted.labels.map((l) => l.toLowerCase()));
  const problems = [];
  for (const name of ['GATE_RUNNER', 'GATE_PR_RUNNER']) {
    const other = parseRunner(held[name] ?? '"ubuntu-latest"');
    if (!other) continue;
    const theirs = new Set(other.labels.map((l) => l.toLowerCase()));
    const same = mine.size === theirs.size && [...mine].every((l) => theirs.has(l));
    if (same || [...mine].some((l) => theirs.has(l) && !GENERIC.has(l))) problems.push(`GATE_TRUSTED_RUNNER is self-hosted and shares a runner with ${name}`);
  }
  return problems;
}

/** What the doctor says of the four variables: each set, the runners in a form `runs-on` reads, and the runner rule. */
export function variableProblems(held) {
  const problems = [];
  for (const [, name] of OPTIONS) {
    if (held[name] === undefined) problems.push(`${name} is not set`);
    else if (name.endsWith('RUNNER') && !parseRunner(held[name])) problems.push(`${name} is not a JSON runs-on value`);
  }
  return [...problems, ...runnerProblems(held)];
}

/** The four variables as the repository holds them; an unset or empty one is absent. */
export function variablesOf(slug, read = gh) {
  const list = read(['variable', 'list', '--repo', slug, '--json', 'name,value']) ?? [];
  return Object.fromEntries(OPTIONS.map(([, name]) => [name, list.find((v) => v.name === name)?.value]).filter(([, value]) => value));
}

const canon = (value) => parseRunner(value)?.text ?? value;

/** The calls that bring the repository from have to want: the variables first, since the gate's ruleset follows
 * GATE_REVIEWER, then every addition before any removal, so main never stands bare between the two. */
export function plan(slug, agent, have, want) {
  const repo = `repos/${slug}`;
  const calls = [];
  for (const [name, value] of Object.entries(want.variables ?? {})) {
    const now = have.variables?.[name];
    if (now === undefined) calls.push({ what: `variable ${name}`, method: 'POST', path: `${repo}/actions/variables`, body: { name, value } });
    else if (canon(now) !== canon(value)) calls.push({ what: `variable ${name}`, method: 'PATCH', path: `${repo}/actions/variables/${name}`, body: { name, value } });
  }
  if (have.collaborator !== 'write' && !have.invited)
    calls.push({ what: `collaborator ${agent} (write)`, method: 'PUT', path: `${repo}/collaborators/${agent}`, body: { permission: 'push' } });
  for (const r of want.rulesets) {
    const now = have.rulesets.find((x) => x.name === r.name);
    if (!now) calls.push({ what: `ruleset ${r.name}`, method: 'POST', path: `${repo}/rulesets`, body: r });
    else if (!holds(sorted(r), sorted(now))) calls.push({ what: `ruleset ${r.name}`, method: 'PUT', path: `${repo}/rulesets/${now.id}`, body: r });
  }
  if (!holds(BRANCH_POLICY, have.environment?.deployment_branch_policy))
    calls.push({ what: `environment ${ENV}`, method: 'PUT', path: `${repo}/environments/${ENV}`, body: { deployment_branch_policy: BRANCH_POLICY } });
  if (!have.policies.some((p) => p.name === want.branch && (p.type ?? 'branch') === 'branch'))
    calls.push({ what: `environment ${ENV} deploys from ${want.branch}`, method: 'POST', path: `${repo}/environments/${ENV}/deployment-branch-policies`, body: { name: want.branch, type: 'branch' } });
  for (const name of want.drop) {
    const now = have.rulesets.find((x) => x.name === name);
    if (now) calls.push({ what: `ruleset ${name}, which the kit's gate replaces`, method: 'DELETE', path: `${repo}/rulesets/${now.id}` });
  }
  return calls;
}

export function gh(args, input) {
  const out = execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: CALL_MS });
  return out.trim() ? JSON.parse(out) : null;
}

/** A GET that answers null on 404 and throws on any other failure. `read` makes the call: bin/onboard-doctor passes one
 * that refuses anything but a read. */
export function maybe(path, read = gh) {
  try {
    return read(['api', path]);
  } catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr))) return null;
    throw error;
  }
}

/** What the repository holds now, of what the factory sets. */
export function current(slug, agent, names, read = gh) {
  const repo = `repos/${slug}`;
  const invitations = read(['api', `${repo}/invitations`]) ?? [];
  const list = read(['api', `${repo}/rulesets?per_page=100`]) ?? [];
  const environment = maybe(`${repo}/environments/${ENV}`, read);
  return {
    // GitHub may answer 404 for an account that is not a collaborator yet, the case the invitation is for.
    collaborator: maybe(`${repo}/collaborators/${agent}/permission`, read)?.permission ?? 'none',
    variables: variablesOf(slug, read),
    invited: invitations.some((i) => i.invitee?.login?.toLowerCase() === agent.toLowerCase() && i.permissions === 'write'),
    rulesets: list.filter((r) => names.has(r.name)).map((r) => read(['api', `${repo}/rulesets/${r.id}`])),
    environment,
    policies: environment ? (read(['api', `${repo}/environments/${ENV}/deployment-branch-policies`])?.branch_policies ?? []) : [],
  };
}

/** What the repository still lacks of `want`: the plan's calls by name, and an environment that also deploys from a
 * branch other than the default. onboard-owner's read-back and the doctor both ask it. */
export function left(slug, agent, have, want) {
  const calls = plan(slug, agent, have, want).map((c) => c.what);
  const extra = have.policies.filter((p) => p.name !== want.branch).map((p) => p.name);
  if (extra.length) calls.push(`environment ${ENV} also deploys from ${extra.join(', ')}: take that out by hand`);
  return calls;
}

/** What both bin/onboard-owner and bin/onboard-doctor settle before they trust the repository named: not the agents'
 * login, the id the repository has, its name as it is now, an admin right. `who` is the command's name in its messages.
 * Returns { refusal } or { login, repo }. */
export function identify(who, { slug, id, agent, read = gh }) {
  const login = read(['api', 'user']).login;
  if (login.toLowerCase() === agent.toLowerCase()) return { refusal: `${who}: runs as the Human, the repository's owner, not as the agents' account (${agent})` };
  const repo = read(['api', `repos/${slug}`]);
  if (String(repo.id) !== id) return { refusal: `${who}: ${slug} has repository id ${repo.id}, not ${id}: check the name and the id before anything changes` };
  if (repo.full_name.toLowerCase() !== slug.toLowerCase() || repo.owner.login.toLowerCase() !== slug.split('/')[0].toLowerCase())
    return { refusal: `${who}: ${slug} answers as ${repo.full_name}: it was renamed or moved; name it as it is now` };
  if (!repo.permissions?.admin) return { refusal: `${who}: ${login} has no admin right on ${slug}; the repository's owner runs this` };
  return { login, repo };
}

/** Whether the kit is on the branch (its inventory is) and the four repository variables, GATE_REVIEWER among them,
 * which the gate's ruleset follows; the jobs read it too, so a later run cannot put back a ruleset that requires review
 * and verdict while they judge nothing. The caller keeps the values to itself, but for those it is setting. */
export function gateState(slug, branch, read = gh) {
  const variables = variablesOf(slug, read);
  return {
    kitLanded: maybe(`repos/${slug}/contents/.gate/kit-files?ref=${encodeURIComponent(branch)}`, read) !== null,
    reviewer: variables.GATE_REVIEWER ?? '',
    variables,
  };
}

/** The arguments of bin/onboard-owner: { slug, id, apply, given } with `given` mapping a variable's name to the value
 * the Human's option gave, in one form, or { problem } for a usage error, which never repeats a value. */
export function parseArguments(argv) {
  const [slug, ...rest] = argv;
  const parsed = { slug, id: undefined, apply: false, given: {} };
  for (let k = 0; k < rest.length; k++) {
    const flag = rest[k];
    if (flag === '--apply') {
      parsed.apply = true;
      continue;
    }
    const name = OPTIONS.find(([option]) => option === flag)?.[1];
    if (flag !== '--id' && !name) return { problem: `unknown argument ${flag}` };
    const value = rest[++k];
    if (value === undefined) return { problem: `${flag} needs a value` };
    if (flag === '--id') parsed.id = value;
    else if (name === 'GATE_REVIEWER') {
      if (!REVIEWERS.includes(value)) return { problem: `--reviewer is ${REVIEWERS.join(' or ')}` };
      parsed.given[name] = value;
    } else {
      const runner = parseRunner(value);
      if (!runner) return { problem: `${flag} is a JSON runs-on value: a label as "ubuntu-latest", or a list as ["self-hosted","macOS"]` };
      parsed.given[name] = runner.text;
    }
  }
  return parsed;
}

const show = (c) => `${c.method} ${c.path}${c.body ? ` ${JSON.stringify(c.body)}` : ''}`;

function main(argv) {
  const { slug, id, apply, given, problem } = parseArguments(argv);
  if (problem || !/^[\w.-]+\/[\w.-]+$/.test(slug ?? '') || !/^\d+$/.test(id ?? '')) {
    if (problem) console.error(`onboard-owner: ${problem}`);
    console.error('usage: bin/onboard-owner <owner/name> --id <repository id> [--runner <json>] [--pr-runner <json>] ' +
      '[--trusted-runner <json>] [--reviewer claude|entire] [--apply]');
    return 2;
  }
  const agent = process.env.FACTORY_AGENT ?? 'tuan9288-agent';
  const who = identify('onboard-owner', { slug, id, agent });
  if (who.refusal) {
    console.error(who.refusal);
    return 2;
  }
  const { repo } = who;
  const branch = repo.default_branch;
  const { kitLanded, variables: held } = gateState(slug, branch);
  // The variables as they will stand: the gate's ruleset follows GATE_REVIEWER as it will be, and so does the runner rule.
  const after = { ...held, ...given };
  const reviewer = after.GATE_REVIEWER ?? '';
  // A runner already held that breaks the rule is the doctor's to name; only a run that sets a runner is refused for it.
  const broken = OPTIONS.some(([flag, name]) => flag.endsWith('runner') && given[name] !== undefined) ? runnerProblems(after) : [];
  if (broken.length) {
    console.error(`onboard-owner: ${broken.join('; ')}: the trusted runner holds the reviewer's credential and is never one that ` +
      'a candidate\'s or main\'s job uses (kit/.gate/enforced-rules.md), so nothing changes');
    return 2;
  }
  if (reviewer === 'entire' && kitLanded) {
    const app = maybe(`apps/${ENTIRE_APP.slug}`);
    if (app?.id !== ENTIRE_APP.id) {
      console.error(`onboard-owner: Entire's App ${ENTIRE_APP.slug} is ${app ? `id ${app.id}` : 'unknown to GitHub'}, not id ${ENTIRE_APP.id}: the gate would pin another App's check, so nothing changes`);
      return 2;
    }
  }
  const want = wanted({ kitLanded, branch, reviewer, variables: given });
  const names = new Set([...want.rulesets.map((r) => r.name), ...want.drop]);
  console.log(`onboard-owner: ${slug} (id ${repo.id}, default branch ${branch}); the kit is ${kitLanded ? '' : 'not '}on ${branch}`);
  for (const [flag, name] of OPTIONS)
    if (given[name] === undefined) console.log(`onboard-owner: ${flag} not given: ${name} stays ${held[name] === undefined ? 'unset' : 'as it is'}`);
  if (reviewer === 'entire')
    console.log(`onboard-owner: GATE_REVIEWER is entire: the gate requires verify, tier and ${ENTIRE_APP.check} from App ${ENTIRE_APP.slug} (id ${ENTIRE_APP.id}), not review or verdict`);
  const calls = plan(slug, agent, current(slug, agent, names), want);
  for (const c of calls) console.log(`  change  ${c.what}: ${show(c)}`);
  if (!calls.length) console.log('  nothing to change');
  if (!apply) {
    if (calls.length) console.log('onboard-owner: dry run: nothing changed; rerun with --apply to make these changes');
    return 0;
  }
  for (const c of calls) {
    const args = ['api', '-X', c.method, c.path];
    gh(c.body ? [...args, '--input', '-'] : args, c.body ? JSON.stringify(c.body) : undefined);
    console.log(`  done    ${c.what}`);
  }
  const have = current(slug, agent, names);
  const undone = left(slug, agent, have, want);
  if (undone.length) {
    console.log(`onboard-owner: incomplete: ${undone.join('; ')}`);
    return 1;
  }
  console.log('onboard-owner: read back: every setting as planned');
  if (have.collaborator !== 'write')
    console.log(`onboard-owner: waiting: ${agent} accepts the invitation, logged in as itself; then the team that ` +
      'claimed the issue runs bin/onboard, which opens the kit pull request');
  else if (!kitLanded)
    console.log('onboard-owner: next: the team that claimed the issue runs bin/onboard, ' +
      'which opens the kit pull request');
  else console.log(`onboard-owner: the kit's gate is in force on ${branch}`);
  return 0;
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`onboard-owner: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 2;
  }
}
