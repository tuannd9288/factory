import { forcePushOn } from './force-push.mjs';
// The admin step of taking a repository in, run by Colly from the factory clone, on the Human's gh login, after his one
// approval of what it prints: it checks the repository is the one he names, by name and id, shows every change, and
// with --apply invites the agents' account (write), sets the factory's rulesets and turns
// on the repository's "Allow auto-merge" (#139), once the kit is on main sets an Actions event policy that allows the gate's
// workflows on pull_request_target the events main's own files give them (#337), then reads back what it set. On the factory's
// own repository it sets that policy alone. The gate's ruleset is the kit's, which requires verify and tier: no reviewer runs
// on Actions, and none is offered (FAC-100). A main still on the kit before FAC-100 whose gate-trusted.yml names the reviewer
// entire keeps the Entire variant (#155) until its kit update (FAC-102). The gate's settings are in the workflows on main, which
// bin/onboard fills in and a pull request changes (#335); this command sets none of them, since the Human's approval of
// that pull request is what changes one. Nor does it set the gate's merge switch (#333), the two review parameters of the
// gate's pull_request rule, unless --merge all|1-2|none says so: it takes them from the live ruleset when it puts one back,
// and from the kit's (1-2) when it makes one. With --merge it writes the live gate ruleset back with those two parameters changed and
// nothing else in it. It calls only gh against GitHub's API, with the factory's own files: never git,
// never the target's .envrc, scripts or hooks, so nothing the target holds runs with his authority. A second run changes
// nothing. See bin/onboard-owner for the arguments.
import { gh as runGh } from '../../kit/.gate/bin/lib/gh.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSITIONS, PARAMETERS, pagesOf, positionOf } from '../../kit/.gate/bin/lib/switch.mjs';
import { SETTINGS, TRUSTED, WORKFLOWS, readsVariables, sharedRunners, targetOf, valuesIn } from './gate-settings.mjs';
import { FACTORY_REPO } from './repos.mjs';
import { agentOf } from './node.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = {
  branches: join(here, '../rulesets/branches.json'),
  tags: join(here, '../rulesets/tags.json'),
  claims: join(here, '../rulesets/claims.json'),
  bootstrap: join(here, '../rulesets/bootstrap.json'),
  gate: join(here, '../../kit/.gate/ruleset.json'),
};
const GATE_NAME = 'factory-gate';
const CALL_MS = 60_000;
/** #337: from 2026-12-02 GitHub blocks pull_request_target in a public repository that has no Actions event policy allowing
 * it, and the gate's trusted jobs run on it. The repository gets one policy, by this name, that allows the gate's workflow files
 * that run on pull_request_target the events they run on. Its endpoints are documented for this API version, sent on each call. */
export const POLICY_NAME = 'factory gate: pull_request_target';
export const POLICY_VERSION = '2026-03-10';
const versioned = (version) => (version ? ['-H', `X-GitHub-Api-Version: ${version}`] : []);

/** The policy's body for what targetOf read from main: its files and their events. */
export const eventPolicy = ({ include, events }) => ({
  name: POLICY_NAME,
  enforcement: 'active',
  conditions: { workflow_path: { include, exclude: [] } },
  rules: [{ type: 'restrict_action_events', parameters: { allowed_events: events } }],
});
/** #155: Entire's GitHub App, which posts the check "Entire Gates": read by the Human on 2026-10-29 from that check on
 * factory-onboard-scratch's head 485678f. An App's id never changes; main() asks GitHub that the slug still names it. */
export const ENTIRE_APP = { slug: 'entire', id: 2626939, check: 'Entire Gates' };

/** The gate of a main still on the kit before FAC-100 whose GATE_REVIEWER is entire (#155): Entire reviews outside Actions,
 * so its check is required, pinned to its App, beside verify and tier, which that kit's tier waits for. FAC-102 moves each
 * such repository to the kit's gate; then main names no reviewer and this variant is chosen no more. */
export function entireGate(gate) {
  return {
    ...gate,
    rules: gate.rules.map((r) =>
      r.type !== 'required_status_checks'
        ? r
        : { ...r, parameters: { ...r.parameters, required_status_checks: [...r.parameters.required_status_checks, { context: ENTIRE_APP.check, integration_id: ENTIRE_APP.id }] } },
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

/** What the repository should hold: before the kit is on its default branch, a ruleset that refuses a rewrite on main and claims
 * (every branch with forcePush off), one on every tag that refuses creation, update and deletion but for a repository admin, one on the claim refs
 * (claim/<n>) that refuses deletion and rewrite for everyone, and a bootstrap one on main that asks the Human to approve
 * the last push; after, the kit's gate in place of the bootstrap one, in its Entire variant when main is on the kit before
 * FAC-100 with the reviewer entire, and the Actions event policy for the workflow files `target` names (#337), read from main
 * by gateState. */
export function wanted({ kitLanded, branch, reviewer, mergeMethod = 'squash', forcePush, target }) {
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const gate = () => {
    const value = reviewer === 'entire' ? entireGate(read(FILES.gate)) : read(FILES.gate);
    value.rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods = [mergeMethod];
    return value;
  };
  const branches = read(FILES.branches);
  if (!forcePushOn({ forcePush })) branches.conditions.ref_name.include = ['~ALL'];
  return {
    rulesets: [branches, read(FILES.tags), read(FILES.claims), kitLanded ? gate() : read(FILES.bootstrap)],
    drop: kitLanded ? [read(FILES.bootstrap).name] : [],
    branch,
    actionsPolicy: kitLanded && target?.include?.length ? eventPolicy(target) : null,
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

/** The repository variables that held the gate's settings before #335, GATE_REVIEWER with them, as the repository holds them;
 * an unset or empty one is absent. Only a main whose gate-trusted.yml predates #335 reads them, until its kit update. */
export function variablesOf(slug, read = gh) {
  const list = read(['variable', 'list', '--repo', slug, '--json', 'name,value']) ?? [];
  const names = [...SETTINGS.map(({ variable }) => variable), 'GATE_REVIEWER'];
  return Object.fromEntries(names.map((name) => [name, list.find((v) => v.name === name)?.value]).filter(([, value]) => value));
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
  if (!have.autoMerge) calls.push({ what: 'allow auto-merge', method: 'PATCH', path: repo, body: { allow_auto_merge: true } });
  calls.push(...policyCalls(slug, have, want));
  for (const name of want.drop) {
    const now = have.rulesets.find((x) => x.name === name);
    if (now) calls.push({ what: `ruleset ${name}, which the kit's gate replaces`, method: 'DELETE', path: `${repo}/rulesets/${now.id}` });
  }
  return calls;
}

/** A policy as the comparison reads it: its three lists (include, exclude, allowed_events) as sets, sorted, and a missing exclude
 * as the empty one sent, so GitHub's echo of the same policy in another order, or without the empty list, is no difference. */
const asSets = (p) => {
  const sort = (list) => (Array.isArray(list) ? [...list].sort() : list);
  const path = p.conditions?.workflow_path ?? {};
  return {
    ...p,
    conditions: { ...p.conditions, workflow_path: { ...path, include: sort(path.include), exclude: sort(path.exclude ?? []) } },
    rules: (p.rules ?? []).map((r) => (r.type === 'restrict_action_events' ? { ...r, parameters: { ...r.parameters, allowed_events: sort(r.parameters?.allowed_events) } } : r)),
  };
};

/** The call that brings the Actions event policy (#337) from have to want: made when absent, put back by its id when it differs. */
export function policyCalls(slug, have, want) {
  const body = want.actionsPolicy;
  if (!body) return [];
  const what = `Actions event policy "${POLICY_NAME}"`;
  const path = `repos/${slug}/actions/policies`;
  if (!have.actionsPolicy) return [{ what, method: 'POST', path, body, version: POLICY_VERSION }];
  return holds(asSets(body), asSets(have.actionsPolicy)) ? [] : [{ what, method: 'PUT', path: `${path}/${have.actionsPolicy.id}`, body, version: POLICY_VERSION }];
}

/** The repository's own Actions event policy of that name, read in full, or null: none, or no policies list at all (a 404). The list
 * finds it by name, but its entries carry no conditions and no rules (as GitHub answered on tuannd9288/factory, 2026-11-07), so the
 * policy itself is then read by its id; compared on a list entry, it never held, and every run put it back and read "incomplete". */
export function policyNow(slug, read = gh) {
  const found = maybe(`repos/${slug}/actions/policies?has_parents=false&per_page=100`, read, POLICY_VERSION)?.policies?.find((p) => p.name === POLICY_NAME);
  return found ? maybe(`repos/${slug}/actions/policies/${found.id}`, read, POLICY_VERSION) : null;
}

/** gh's answer as JSON, or null when it printed nothing, through the kit's one gh runner (FAC-85), whose ceiling is above Node's 1 MiB. */
export function gh(args, input) {
  const out = runGh(args, { input, timeout: CALL_MS });
  return out.trim() ? JSON.parse(out) : null;
}

/** A GET that answers null on 404 and throws on any other failure. `read` makes the call: bin/onboard-doctor passes one
 * that refuses anything but a read. `version` sends the API version header an endpoint is documented for. */
export function maybe(path, read = gh, version = undefined) {
  try {
    return read(['api', ...versioned(version), path]);
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
  return {
    // GitHub may answer 404 for an account that is not a collaborator yet, the case the invitation is for.
    collaborator: maybe(`${repo}/collaborators/${agent}/permission`, read)?.permission ?? 'none',
    // GitHub shows the setting to an admin only (identify has checked that), so an absent field reads as off.
    autoMerge: read(['api', repo])?.allow_auto_merge === true,
    invited: invitations.some((i) => i.invitee?.login?.toLowerCase() === agent.toLowerCase() && i.permissions === 'write'),
    rulesets: list.filter((r) => names.has(r.name)).map((r) => read(['api', `${repo}/rulesets/${r.id}`])),
    actionsPolicy: policyNow(slug, read),
  };
}

/** What the repository still lacks of `want`: the plan's calls by name. onboard-owner's read-back and the doctor both ask it. */
export function left(slug, agent, have, want) {
  return plan(slug, agent, have, want).map((c) => c.what);
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
 * read through the contents API, or with `fileAt(path)` (text, or null) where the caller holds the branch already. A branch
 * whose gate-trusted.yml still reads the repository variables (`old`, the kit before #335) has its settings there until its
 * kit update lands. `reviewer` is entire only on a main on the kit before FAC-100 that names it (#155), else undefined. */
export function gateState(slug, branch, read = gh, fileAt = undefined) {
  const at = (path) => `repos/${slug}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const kitLanded = maybe(at('.gate/kit-files'), read) !== null;
  const viaApi = (path) => {
    const file = maybe(at(path), read);
    return typeof file?.content === 'string' ? Buffer.from(file.content, 'base64').toString('utf8') : null;
  };
  const driverText = fileAt ? fileAt('.gate/driver.json') : (() => {
    const file = maybe(`repos/${slug}/contents/.gate/driver.json?ref=main`, read);
    return file === null ? null : Buffer.from(file.content, 'base64').toString('utf8');
  })();
  const driver = driverText ? JSON.parse(driverText) : {};
  forcePushOn(driver);
  const forcePush = driver.forcePush;
  const files = {};
  for (const path of kitLanded ? WORKFLOWS : []) {
    const text = (fileAt ?? viaApi)(path);
    if (typeof text === 'string') files[path] = text;
  }
  const mergeMethod = driver.merge === 'merge' ? 'merge' : 'squash';
  const settings = valuesIn(files);
  const variables = variablesOf(slug, read);
  const old = typeof files[TRUSTED] === 'string' && readsVariables(files[TRUSTED]);
  // The Actions event policy's files and events, from the same workflows (#337); { unreadable: path } when one is not in the kit's form.
  const target = targetOf(files);
  return { forcePush, kitLanded, files, settings, variables, old, mergeMethod, target, reviewer: settings.reviewer };
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

/** Makes the planned calls, in order, each with the API version its endpoint is documented for. */
function send(calls) {
  for (const c of calls) {
    const args = ['api', '-X', c.method, ...versioned(c.version), c.path];
    gh(c.body ? [...args, '--input', '-'] : args, c.body ? JSON.stringify(c.body) : undefined);
    console.log(`  done    ${c.what}`);
  }
}

/** The workflow files on the branch, by path, as the contents API gives the folder and each file. */
function workflowsOn(slug, branch) {
  const ref = `?ref=${encodeURIComponent(branch)}`;
  const files = {};
  for (const entry of maybe(`repos/${slug}/contents/.github/workflows${ref}`) ?? []) {
    if (entry.type !== 'file' || !/\.ya?ml$/.test(entry.name)) continue;
    const file = maybe(`repos/${slug}/contents/${entry.path}${ref}`);
    if (typeof file?.content === 'string') files[entry.path] = Buffer.from(file.content, 'base64').toString('utf8');
  }
  return files;
}

/** The factory's own repository (#337, option a): it keeps its own `factory` ruleset and runs none of the kit, so a run plans,
 * applies and reads back only its Actions event policy, for the workflows on its main that run on pull_request_target. */
function policyOnly(slug, branch, apply) {
  const target = targetOf(workflowsOn(slug, branch));
  if (target.unreadable) {
    console.error(`onboard-owner: ${target.unreadable} on ${branch} has no on: block in the kit's form, so the events its Actions event policy must allow are not known: nothing changes`);
    return 2;
  }
  const want = { actionsPolicy: target.include.length ? eventPolicy(target) : null };
  console.log(`onboard-owner: ${slug} is the factory's own repository: this run sets only its Actions event policy, for ${target.include.join(', ') || 'no workflow on pull_request_target'}`);
  const calls = policyCalls(slug, { actionsPolicy: policyNow(slug) }, want);
  for (const c of calls) console.log(`  change  ${c.what}: ${show(c)}`);
  if (!calls.length) console.log('  nothing to change');
  if (!apply) {
    if (calls.length) console.log('onboard-owner: dry run: nothing changed; rerun with --apply to make these changes');
    return 0;
  }
  send(calls);
  if (policyCalls(slug, { actionsPolicy: policyNow(slug) }, want).length) {
    console.log(`onboard-owner: incomplete: Actions event policy "${POLICY_NAME}"`);
    return 1;
  }
  console.log('onboard-owner: read back: the Actions event policy as planned');
  return 0;
}

export function linearCodeStep(slug) {
  return `onboard-owner: Human's manual step: open https://github.com/settings/installations, then Linear Code → Configure → tick ${slug} → Save`;
}

function main(argv) {
  const { slug, id, apply, merge, problem } = parseArguments(argv);
  if (problem || !/^[\w.-]+\/[\w.-]+$/.test(slug ?? '') || !/^\d+$/.test(id ?? '')) {
    if (problem) console.error(`onboard-owner: ${problem}`);
    console.error('usage: bin/onboard-owner <owner/name> --id <repository id> [--apply] [--merge all|1-2|none]');
    return 2;
  }
  const agent = agentOf();
  const who = identify('onboard-owner', { slug, id, agent });
  if (who.refusal) {
    console.error(who.refusal);
    return 2;
  }
  const { repo, login } = who;
  const branch = repo.default_branch;
  // The factory's own repository is his login's `factory`: its gate is its own, so the kit's rulesets never go there.
  if (slug.toLowerCase() === `${login}/${FACTORY_REPO}`.toLowerCase()) {
    if (merge) {
      console.error(`onboard-owner: --merge moves the kit's gate, which ${slug} does not run: nothing changes`);
      return 2;
    }
    return policyOnly(slug, branch, apply);
  }
  // A runner that breaks the rule is the evidence's and the doctor's to name.
  const { kitLanded, settings, reviewer, mergeMethod, forcePush, target } = gateState(slug, branch);
  if (target.unreadable) {
    console.error(`onboard-owner: ${target.unreadable} on ${branch} has no on: block in the kit's form, so the events its Actions event policy must allow are not known: nothing changes`);
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
  const kit = wanted({ kitLanded, branch, reviewer, mergeMethod, forcePush, target });
  const names = new Set([...kit.rulesets.map((r) => r.name), ...kit.drop]);
  const now = current(slug, agent, names);
  // The gate's two review parameters are the merge switch (#333): the position --merge names, else the live ruleset's own,
  // else the kit's (1-2); a put-back of a changed ruleset never resets them.
  const review = merge ? PARAMETERS[merge] : reviewOf(now.rulesets.find((r) => r.name === GATE_NAME));
  const want = kitLanded && review ? withReview(kit, review) : kit;
  console.log(`onboard-owner: ${slug} (id ${repo.id}, default branch ${branch}); the kit is ${kitLanded ? '' : 'not '}on ${branch}`);
  if (kitLanded) {
    const before = switchNow(slug, branch);
    console.log(`onboard-owner: the merge switch on ${branch} ${before.position ? `is ${before.position}` : `could not be read (${before.problem})`}${merge ? `; --merge sets it to ${merge}` : ', and this run leaves it as it is'}`);
  }
  if (reviewer === 'entire')
    console.log(`onboard-owner: ${TRUSTED} on ${branch} names the reviewer entire, as the kit did before FAC-100: the gate requires verify, tier and ${ENTIRE_APP.check} from App ${ENTIRE_APP.slug} (id ${ENTIRE_APP.id}) until its kit update (FAC-102)`);
  if (reviewer === 'entire' && sharedRunners(settings).length)
    console.log('onboard-owner: the runners are shared under the Human\'s exception (#155, kit/.gate/enforced-rules.md), which holds ' +
      'only while there is no reviewer secret in the environment reviewer; this command does not read secrets, so that is his to keep');
  const live = now.rulesets.find((r) => r.name === GATE_NAME);
  // --merge writes the live gate ruleset back with its two review parameters changed and nothing else in it: whatever else
  // it holds, drift from the kit included, stays as it is. Every other difference from the kit (auto-merge, a missing
  // ruleset) is listed as not changed and left. It moves a switch that exists, so a gate not in force yet
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
    if (!merge) console.log(linearCodeStep(slug));
    return 0;
  }
  send(calls);
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
  console.log(linearCodeStep(slug));
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
