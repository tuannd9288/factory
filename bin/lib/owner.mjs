// The Human's half of taking a repository in, run by him from the factory clone, logged into gh as the repository's
// owner: it checks the repository is the one he names, by name and id, shows every change, and with --apply invites
// the agents' account (write), sets the factory's rulesets and creates the reviewer environment, then reads back what
// it set. It calls only gh against GitHub's API, with the factory's own files: never git, never the target's .envrc,
// scripts or hooks, so nothing the target holds runs with his authority. A second run changes nothing.
// See bin/onboard-owner for the arguments.
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
const CALL_MS = 60_000;
const BRANCH_POLICY = { protected_branches: false, custom_branch_policies: true };

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
 * the last push; after, the kit's gate in place of the bootstrap one. */
export function wanted({ kitLanded, branch }) {
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  return {
    rulesets: [read(FILES.branches), read(FILES.tags), read(FILES.claims), read(kitLanded ? FILES.gate : FILES.bootstrap)],
    drop: kitLanded ? [read(FILES.bootstrap).name] : [],
    branch,
  };
}

/** The calls that bring the repository from have to want: every addition before any removal, so main never stands
 * bare between the two. */
export function plan(slug, agent, have, want) {
  const repo = `repos/${slug}`;
  const calls = [];
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

function gh(args, input) {
  const out = execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: CALL_MS });
  return out.trim() ? JSON.parse(out) : null;
}

/** A GET that answers null on 404 and throws on any other failure. */
function maybe(path) {
  try {
    return gh(['api', path]);
  } catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr))) return null;
    throw error;
  }
}

/** What the repository holds now, of what the factory sets. */
function current(slug, agent, names) {
  const repo = `repos/${slug}`;
  const invitations = gh(['api', `${repo}/invitations`]) ?? [];
  const list = gh(['api', `${repo}/rulesets?per_page=100`]) ?? [];
  const environment = maybe(`${repo}/environments/${ENV}`);
  return {
    // GitHub may answer 404 for an account that is not a collaborator yet, the case the invitation is for.
    collaborator: maybe(`${repo}/collaborators/${agent}/permission`)?.permission ?? 'none',
    invited: invitations.some((i) => i.invitee?.login?.toLowerCase() === agent.toLowerCase() && i.permissions === 'write'),
    rulesets: list.filter((r) => names.has(r.name)).map((r) => gh(['api', `${repo}/rulesets/${r.id}`])),
    environment,
    policies: environment ? (gh(['api', `${repo}/environments/${ENV}/deployment-branch-policies`])?.branch_policies ?? []) : [],
  };
}

const show = (c) => `${c.method} ${c.path}${c.body ? ` ${JSON.stringify(c.body)}` : ''}`;

function main(argv) {
  const [slug] = argv;
  const i = argv.indexOf('--id');
  const id = i >= 0 ? argv[i + 1] : undefined;
  const apply = argv.includes('--apply');
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug ?? '') || !/^\d+$/.test(id ?? '')) {
    console.error('usage: bin/onboard-owner <owner/name> --id <repository id> [--apply]');
    return 2;
  }
  const agent = process.env.FACTORY_AGENT ?? 'tuan9288-agent';
  const login = gh(['api', 'user']).login;
  if (login.toLowerCase() === agent.toLowerCase()) {
    console.error(`onboard-owner: runs as the Human, the repository's owner, not as the agents' account (${agent})`);
    return 2;
  }
  const repo = gh(['api', `repos/${slug}`]);
  if (String(repo.id) !== id) {
    console.error(`onboard-owner: ${slug} has repository id ${repo.id}, not ${id}: check the name and the id before anything changes`);
    return 2;
  }
  if (repo.full_name.toLowerCase() !== slug.toLowerCase() || repo.owner.login.toLowerCase() !== slug.split('/')[0].toLowerCase()) {
    console.error(`onboard-owner: ${slug} answers as ${repo.full_name}: it was renamed or moved; name it as it is now`);
    return 2;
  }
  if (!repo.permissions?.admin) {
    console.error(`onboard-owner: ${login} has no admin right on ${slug}; the repository's owner runs this`);
    return 2;
  }
  const branch = repo.default_branch;
  const kitLanded = maybe(`repos/${slug}/contents/.gate/kit-files?ref=${encodeURIComponent(branch)}`) !== null;
  const want = wanted({ kitLanded, branch });
  const names = new Set([...want.rulesets.map((r) => r.name), ...want.drop]);
  console.log(`onboard-owner: ${slug} (id ${repo.id}, default branch ${branch}); the kit is ${kitLanded ? '' : 'not '}on ${branch}`);
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
  const left = plan(slug, agent, have, want).map((c) => c.what);
  const extra = have.policies.filter((p) => p.name !== branch).map((p) => p.name);
  if (extra.length) left.push(`environment ${ENV} also deploys from ${extra.join(', ')}: take that out by hand`);
  if (left.length) {
    console.log(`onboard-owner: incomplete: ${left.join('; ')}`);
    return 1;
  }
  console.log('onboard-owner: read back: every setting as planned');
  if (have.collaborator !== 'write')
    console.log(`onboard-owner: waiting: ${agent} accepts the invitation, logged in as itself; then its half, bin/onboard, opens the kit pull request`);
  else if (!kitLanded) console.log(`onboard-owner: next: the agents' half, bin/onboard, opens the kit pull request`);
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
