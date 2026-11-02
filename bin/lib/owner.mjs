// The admin step of taking a repository in, run by Colly from the factory clone, on the Human's gh login, after his one
// approval of what it prints: it checks the repository is the one he names, by name and id, shows every change, and
// with --apply invites the agents' account (write), sets the factory's rulesets, creates the reviewer environment and turns
// on the repository's "Allow auto-merge" (#139), then reads back what it set. The gate's ruleset follows the reviewer as
// main's gate-trusted.yml holds it (#155: entire has its own). The gate's settings are in the workflows on main, which
// bin/onboard fills in and a pull request changes (#335); this command sets none of them, since the Human's approval of
// that pull request is what changes one. Nor does it set the gate's merge switch (#333), the two review parameters of the
// gate's pull_request rule, unless --merge all|1-2|none says so: it takes them from the live ruleset when it puts one back,
// and from the kit's (1-2) when it makes one. With --merge it writes the live gate ruleset back with those two parameters changed and
// nothing else in it. A main whose gate-trusted.yml cannot be read stops the run when the kit is on
// it, since the reviewer chooses the ruleset. It calls only gh against GitHub's API, with the factory's own files: never git,
// never the target's .envrc, scripts or hooks, so nothing the target holds runs with his authority. A second run changes
// nothing. See bin/onboard-owner for the arguments.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSITIONS, PARAMETERS, pagesOf, positionOf } from '../../kit/.gate/bin/lib/switch.mjs';
import { SETTINGS, TRUSTED, WORKFLOWS, readsVariables, sharedRunners, valuesIn } from './gate-settings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = {
  branches: join(here, '../rulesets/branches.json'),
  tags: join(here, '../rulesets/tags.json'),
  claims: join(here, '../rulesets/claims.json'),
  bootstrap: join(here, '../rulesets/bootstrap.json'),
  gate: join(here, '../../kit/.gate/ruleset.json'),
};
const ENV = 'reviewer';
const GATE_NAME = 'factory-gate';
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
export function wanted({ kitLanded, branch, reviewer }) {
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const gate = () => (reviewer === 'entire' ? entireGate(read(FILES.gate)) : read(FILES.gate));
  return {
    rulesets: [read(FILES.branches), read(FILES.tags), read(FILES.claims), kitLanded ? gate() : read(FILES.bootstrap)],
    drop: kitLanded ? [read(FILES.bootstrap).name] : [],
    branch,
  };
}

/** The two review parameters of a ruleset's pull_request rule, when both are in the form GitHub gives them: they are the
 * repository's merge switch (#333), which only the owner moves and a put-back of a changed ruleset keeps. Null otherwise. */
export function reviewOf(ruleset) {
  const p = ruleset?.rules?.find((r) => r.type === 'pull_request')?.parameters;
  try {
    positionOf([{ type: 'pull_request', parameters: p }]);
  } catch {
    return null;
  }
  return { required_approving_review_count: p.required_approving_review_count, require_code_owner_review: p.require_code_owner_review };
}

/** The fields of a ruleset GitHub takes in a write (Update a repository ruleset); the rest of what it reads back (ids,
 * links, dates, source, current_user_can_bypass and the like) is not sent. */
const WRITABLE = ['name', 'target', 'enforcement', 'bypass_actors', 'conditions', 'rules'];

/** The live ruleset as a write body with only the pull_request rule's two review parameters set to `review`: everything
 * else in it stays as it is live. { body, from, to } with the two parameters before and after, or null when the ruleset
 * has no pull_request rule, and so no switch. */
export function moveSwitch(live, review) {
  const rule = live?.rules?.find((r) => r.type === 'pull_request');
  const from = reviewOf(live);
  if (!rule || !from) return null;
  const body = Object.fromEntries(WRITABLE.filter((k) => k in live).map((k) => [k, live[k]]));
  body.rules = live.rules.map((r) => (r.type === 'pull_request' ? { ...r, parameters: { ...r.parameters, ...review } } : r));
  return { body, from, to: review };
}

/** `want` with the gate's two review parameters set to `review` (the live ones, or the position --merge names): the
 * kit's other parameters, key order included, stay. */
export function withReview(want, review) {
  const put = (r) => (r.type === 'pull_request' ? { ...r, parameters: { ...r.parameters, ...review } } : r);
  return { ...want, rulesets: want.rulesets.map((r) => (r.name === GATE_NAME ? { ...r, rules: r.rules.map(put) } : r)) };
}

/** The merge switch as the rules in force on the branch read now: { position }, or { problem } saying why they do not. */
export function switchNow(slug, branch, read = gh) {
  try {
    return { position: positionOf(pagesOf(read(['api', '--paginate', '--slurp', `repos/${slug}/rules/branches/${branch}`]))) };
  } catch (error) {
    return { problem: String(error.stderr || error.message).trim().split('\n')[0] };
  }
}

/** The four repository variables that held the gate's settings before #335, as the repository holds them; an unset or
 * empty one is absent. Only a main whose gate-trusted.yml predates #335 reads one, GATE_REVIEWER, until its kit update. */
export function variablesOf(slug, read = gh) {
  const list = read(['variable', 'list', '--repo', slug, '--json', 'name,value']) ?? [];
  return Object.fromEntries(SETTINGS.map(({ variable }) => [variable, list.find((v) => v.name === variable)?.value]).filter(([, value]) => value));
}

/** The calls that bring the repository from have to want: every addition before any removal, so main never stands bare
 * between the two. */
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
  if (!have.autoMerge) calls.push({ what: 'allow auto-merge', method: 'PATCH', path: repo, body: { allow_auto_merge: true } });
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
    // GitHub shows the setting to an admin only (identify has checked that), so an absent field reads as off.
    autoMerge: read(['api', repo])?.allow_auto_merge === true,
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

/** Whether the kit is on the branch (its inventory is), and the gate's settings as the branch's workflows hold them (#335),
 * read through the contents API, or with `fileAt(path)` (text, or null) where the caller holds the branch already. The
 * gate's ruleset follows the reviewer, and the jobs read it too, so a later run cannot put back a ruleset that requires
 * review and verdict while they judge nothing. A branch whose gate-trusted.yml still reads the repository variable (`old`,
 * the kit before #335) has its reviewer there until its kit update lands. */
export function gateState(slug, branch, read = gh, fileAt = undefined) {
  const at = (path) => `repos/${slug}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const kitLanded = maybe(at('.gate/kit-files'), read) !== null;
  const viaApi = (path) => {
    const file = maybe(at(path), read);
    return typeof file?.content === 'string' ? Buffer.from(file.content, 'base64').toString('utf8') : null;
  };
  const files = {};
  for (const path of kitLanded ? WORKFLOWS : []) {
    const text = (fileAt ?? viaApi)(path);
    if (typeof text === 'string') files[path] = text;
  }
  const settings = valuesIn(files);
  const variables = variablesOf(slug, read);
  const old = typeof files[TRUSTED] === 'string' && readsVariables(files[TRUSTED]);
  // On a main where the kit has landed, a gate-trusted.yml that is absent, or holds no reviewer line in the kit's form, is not
  // "no reviewer": the reviewer is unknown, and the ruleset it chooses would be the wrong one (#333, #335's round 2).
  const unreadable = kitLanded && !old && settings.reviewer === undefined;
  return { kitLanded, files, settings, variables, old, unreadable, reviewer: settings.reviewer ?? (old ? (variables.GATE_REVIEWER ?? '') : '') };
}

/** The arguments of bin/onboard-owner: { slug, id, apply, merge }, or { problem } for a usage error. */
export function parseArguments(argv) {
  const [slug, ...rest] = argv;
  const parsed = { slug, id: undefined, apply: false, merge: undefined };
  for (let k = 0; k < rest.length; k++) {
    const flag = rest[k];
    if (flag === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (flag === '--merge') {
      const value = rest[++k];
      if (!POSITIONS.includes(value)) return { problem: `--merge is ${POSITIONS.join(', ')}${value === undefined ? ' and needs one' : `, not ${value}`}` };
      parsed.merge = value;
      continue;
    }
    if (SETTINGS.some((s) => s.option === flag))
      return { problem: `${flag} is not this command's (#335): the gate's settings are in the workflows on main, which bin/onboard fills in and a pull request the Human approves changes` };
    if (flag !== '--id') return { problem: `unknown argument ${flag}` };
    const value = rest[++k];
    if (value === undefined) return { problem: `${flag} needs a value` };
    parsed.id = value;
  }
  return parsed;
}

const show = (c) => c.shown ?? `${c.method} ${c.path}${c.body ? ` ${JSON.stringify(c.body)}` : ''}`;

function main(argv) {
  const { slug, id, apply, merge, problem } = parseArguments(argv);
  if (problem || !/^[\w.-]+\/[\w.-]+$/.test(slug ?? '') || !/^\d+$/.test(id ?? '')) {
    if (problem) console.error(`onboard-owner: ${problem}`);
    console.error('usage: bin/onboard-owner <owner/name> --id <repository id> [--apply] [--merge all|1-2|none]');
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
  // The reviewer as main holds it; a runner that breaks the rule is the evidence's and the doctor's to name.
  const { kitLanded, settings, old, reviewer, unreadable } = gateState(slug, branch);
  if (unreadable) {
    console.error(`onboard-owner: ${TRUSTED} on ${branch} cannot be read as the kit's file with its reviewer line, so the reviewer is not known and the gate's ruleset cannot be chosen: nothing changes`);
    return 2;
  }
  if (merge && !kitLanded) {
    console.error(`onboard-owner: --merge moves the switch of the kit's gate, and the kit is not on ${branch} yet: nothing changes`);
    return 2;
  }
  if (reviewer === 'entire' && kitLanded) {
    const app = maybe(`apps/${ENTIRE_APP.slug}`);
    if (app?.id !== ENTIRE_APP.id) {
      console.error(`onboard-owner: Entire's App ${ENTIRE_APP.slug} is ${app ? `id ${app.id}` : 'unknown to GitHub'}, not id ${ENTIRE_APP.id}: the gate would pin another App's check, so nothing changes`);
      return 2;
    }
  }
  const kit = wanted({ kitLanded, branch, reviewer });
  const names = new Set([...kit.rulesets.map((r) => r.name), ...kit.drop]);
  const now = current(slug, agent, names);
  // The gate's two review parameters are the merge switch (#333): the position --merge names, else the live ruleset's own,
  // else the kit's (1-2); a put-back of a changed ruleset never resets them.
  const review = merge ? PARAMETERS[merge] : reviewOf(now.rulesets.find((r) => r.name === GATE_NAME));
  const want = kitLanded && review ? withReview(kit, review) : kit;
  console.log(`onboard-owner: ${slug} (id ${repo.id}, default branch ${branch}); the kit is ${kitLanded ? '' : 'not '}on ${branch}`);
  if (kitLanded) {
    console.log(`onboard-owner: the reviewer on ${branch} is ${reviewer || 'none'}${old ? ', from the repository variable GATE_REVIEWER, which its gate-trusted.yml reads until its kit update (#335)' : ', as its gate-trusted.yml holds it (#335)'}`);
    const before = switchNow(slug, branch);
    console.log(`onboard-owner: the merge switch on ${branch} ${before.position ? `is ${before.position}` : `could not be read (${before.problem})`}${merge ? `; --merge sets it to ${merge}` : ', and this run leaves it as it is'}`);
  }
  if (reviewer === 'entire')
    console.log(`onboard-owner: GATE_REVIEWER is entire: the gate requires verify, tier and ${ENTIRE_APP.check} from App ${ENTIRE_APP.slug} (id ${ENTIRE_APP.id}), not review or verdict`);
  if (reviewer === 'entire' && sharedRunners(settings).length)
    console.log('onboard-owner: the runners are shared under the Human\'s exception (#155, kit/.gate/enforced-rules.md), which holds ' +
      'only while there is no reviewer secret in the environment reviewer; this command does not read secrets, so that is his to keep');
  const live = now.rulesets.find((r) => r.name === GATE_NAME);
  // --merge writes the live gate ruleset back with its two review parameters changed and nothing else in it: whatever else
  // it holds, drift from the kit included, stays as it is. Every other difference from the kit (auto-merge, a missing
  // ruleset, the environment) is listed as not changed and left. It moves a switch that exists, so a gate not in force yet
  // is a plain run's to put in, and a gate with no pull_request rule has no switch to move.
  let calls = [];
  let leftAlone = [];
  if (merge) {
    if (!live) {
      console.error(`onboard-owner: --merge moves the switch of the ${GATE_NAME} ruleset, which is not in force on ${branch} yet: run without --merge first; nothing changes`);
      return 2;
    }
    const move = moveSwitch(live, PARAMETERS[merge]);
    if (!move) {
      console.error(`onboard-owner: --merge: the ${GATE_NAME} ruleset has no pull_request rule with both review parameters, so there is no switch to move: nothing changes`);
      return 2;
    }
    const [from, to] = [move.from, move.to];
    const same = from.required_approving_review_count === to.required_approving_review_count && from.require_code_owner_review === to.require_code_owner_review;
    if (!same)
      calls = [{
        what: `ruleset ${GATE_NAME}`, method: 'PUT', path: `repos/${slug}/rulesets/${live.id}`, body: move.body,
        shown: `PUT repos/${slug}/rulesets/${live.id}: required_approving_review_count ${from.required_approving_review_count} -> ${to.required_approving_review_count}, ` +
          `require_code_owner_review ${from.require_code_owner_review} -> ${to.require_code_owner_review}; the rest of the ruleset is left as it is`,
      }];
    leftAlone = plan(slug, agent, now, want).filter((c) => c.what !== `ruleset ${GATE_NAME}`);
  } else calls = plan(slug, agent, now, want);
  if (now.autoMerge) console.log('onboard-owner: allow auto-merge is on');
  for (const c of calls) console.log(`  change  ${c.what}: ${show(c)}`);
  for (const c of leftAlone) console.log(`  not changed  ${c.what}: --merge moves the merge switch only`);
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
  if (merge) {
    const set = reviewOf(have.rulesets.find((r) => r.name === GATE_NAME));
    const after = switchNow(slug, branch);
    if (set?.required_approving_review_count !== PARAMETERS[merge].required_approving_review_count || set?.require_code_owner_review !== PARAMETERS[merge].require_code_owner_review || after.position !== merge) {
      console.log(`onboard-owner: incomplete: the merge switch ${after.position ? `reads ${after.position}` : `could not be read (${after.problem})`}, not ${merge}`);
      return 1;
    }
    console.log(`onboard-owner: read back: the merge switch is ${merge}`);
    return 0;
  }
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
