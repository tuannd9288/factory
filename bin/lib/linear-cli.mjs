// `factory linear <verb>` (#404, sublayer 1b): the steps a Lead needs on a repository on Linear, and the one step that puts a repository there.
// It runs on the factory host and calls Linear itself through createLinear (bin/lib/linear.mjs, #403), which reads the app's token in this
// process; on the MacBook bin/lib/factory.mjs runs the same command on the host by ssh. No free-form GraphQL is offered.
//   take <KEY> --team <team>                    the app becomes the delegate, no person is assigned, the issue moves to its team's first `started`
//                                               status, and one comment names the team; refused when the app is already the delegate (the lock)
//   read <KEY>                                  title, description, status, delegate, assignee and every comment, as JSON
//   comment <KEY> --team <team> --body-file -   one comment, shown as "<team> (via Factory)"
//   ask <KEY> --team <team> --body-file -       status Needs Human, the Human assigned, one comment (the question and its tick boxes)
//   answered <KEY> --team <team>                the assignee removed, the issue back in the first `started` status
//   list --team-key <KEY> [--status <type>]...  the team's open issues (default types triage, backlog, unstarted, started); a read
//   create --team-key <KEY> --title <t> --status <name> --body-file - [--delegate]   an issue with an explicit status, never Triage by accident
//   onboard <repo> --key <KEY> --name <name>    the repository's team (copied from FAC) and its Needs Human status, and the registry
// One JSON object on stdout. Exit 0 done, 1 Linear refused or failed (the reason is in `error`, never a token), 2 usage.
// The Human is found, never stored: the one workspace owner who is not an app; any other count refuses.
// The registry, $FACTORY_STATE/linear/repos.json { "<repo>": { key, teamId } }, is written only by `onboard`, atomically; a repository
// not in it is on GitHub. `onLinear(repo)` reads it.
import { join } from 'node:path';
import { createLinear } from './linear.mjs';
import { onLinear, readRegistry, registryFile, writeRegistry } from './linear-repos.mjs';

export const NEEDS_HUMAN = 'Needs Human';
const FIRST_TEAM = 'FAC';
const COLOR = '#f2994a';
const KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_BODY = 60_000;

export { onLinear, readRegistry, registryFile };

class Usage extends Error {}
class Refused extends Error {}

const SHAPES = {
  take: { args: 1, flags: { '--team': 'value' } },
  read: { args: 1, flags: {} },
  comment: { args: 1, flags: { '--team': 'value', '--body-file': 'value' } },
  ask: { args: 1, flags: { '--team': 'value', '--body-file': 'value' } },
  answered: { args: 1, flags: { '--team': 'value' } },
  create: { args: 0, flags: { '--team-key': 'value', '--title': 'value', '--status': 'value', '--body-file': 'value', '--delegate': 'bool' } },
  onboard: { args: 1, flags: { '--key': 'value', '--name': 'value' } },
  list: { args: 0, flags: { '--team-key': 'value', '--status': 'repeat' } },
};
/** The status types of the shared view 'Active (all teams)': what `list` shows unless `--status` narrows it. */
export const OPEN_TYPES = ['triage', 'backlog', 'unstarted', 'started'];
const REQUIRED = {
  take: ['--team'], comment: ['--team', '--body-file'], ask: ['--team', '--body-file'], answered: ['--team'],
  create: ['--team-key', '--title', '--status', '--body-file'], onboard: ['--key', '--name'], list: ['--team-key'],
};

/** { verb, args, flags } or a thrown Usage. A flag is given once; a body comes on stdin only, since a path names a file on the caller's Mac. */
export function parse(argv) {
  const [verb, ...rest] = argv;
  const shape = SHAPES[verb];
  if (!shape) throw new Usage(`unknown verb ${verb ?? '(none)'}`);
  const args = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const kind = a.startsWith('--') ? shape.flags[a] : undefined;
    if (a.startsWith('--')) {
      if (!kind || (a in flags && kind !== 'repeat')) throw new Usage(`${verb}: ${kind ? `${a} is given twice` : `${a} is not a flag of it`}`);
      const value = kind === 'bool' ? true : rest[++i];
      if (value === undefined) throw new Usage(`${verb}: ${a} needs a value`);
      flags[a] = kind === 'repeat' ? [...(flags[a] ?? []), value] : value;
    } else args.push(a);
  }
  if (args.length !== shape.args) throw new Usage(`${verb}: expects ${shape.args} argument${shape.args === 1 ? '' : 's'}`);
  for (const f of REQUIRED[verb] ?? []) if (!(f in flags)) throw new Usage(`${verb}: ${f} is required`);
  if ('--body-file' in flags && flags['--body-file'] !== '-') throw new Usage(`${verb}: the body comes on stdin: --body-file -`);
  if (verb === 'onboard' ? !WORD.test(args[0]) : shape.args === 1 && !KEY.test(args[0])) throw new Usage(`${verb}: ${args[0]} is not a ${verb === 'onboard' ? 'repository name' : 'issue key such as FAC-12'}`);
  if ('--team' in flags && !WORD.test(flags['--team'])) throw new Usage(`${verb}: --team is a plain name`);
  for (const f of ['--team-key', '--key']) if (f in flags && !TEAM_KEY.test(flags[f])) throw new Usage(`${verb}: ${f} is a team key such as FAC`);
  if (verb === 'list') for (const t of flags['--status'] ?? []) if (!OPEN_TYPES.includes(t)) throw new Usage(`list: --status is one of ${OPEN_TYPES.join(', ')}`);
  for (const f of verb === 'list' ? [] : ['--title', '--status', '--name']) if (f in flags && (!flags[f].trim() || flags[f].length > 200 || /[\x00-\x1f]/.test(flags[f]))) throw new Usage(`${verb}: ${f} is one line of 1 to 200 characters`);
  return { verb, args, flags };
}

const STATES = 'states(first: 100) { nodes { id name type position } }';
const firstStarted = (states) => states.filter((s) => s.type === 'started' && s.name !== NEEDS_HUMAN).sort((a, b) => a.position - b.position)[0];

export function createCli({ api, state, readStdin }) {
  const q = (query, vars) => api.request(query, vars);

  async function issueTeam(key) {
    const issue = (await q(`query($id: String!) { issue(id: $id) { id identifier delegate { id } team { id key ${STATES} } } }`, { id: key }))?.issue;
    if (!issue) throw new Refused(`Linear has no issue ${key}`);
    return issue;
  }
  const stateNamed = (issue, name) => {
    const s = issue.team.states.nodes.find((x) => x.name === name);
    if (!s) throw new Refused(`team ${issue.team.key} has no status named ${name}`);
    return s;
  };
  const started = (issue) => {
    const s = firstStarted(issue.team.states.nodes);
    if (!s) throw new Refused(`team ${issue.team.key} has no status of type started`);
    return s;
  };
  const update = (id, input) => q('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier } } }', { id, input });
  const done = (data, what) => {
    if (!data?.[what]?.success) throw new Refused(`Linear did not confirm ${what}`);
    return data[what];
  };

  /** The Human: the one workspace owner who is not an app. Any other count refuses and names the count. */
  async function human() {
    const nodes = (await q('query { users(filter: { owner: { eq: true }, app: { eq: false } }, first: 10) { nodes { id } } }'))?.users?.nodes ?? [];
    if (nodes.length !== 1) throw new Refused(`expected exactly one workspace owner who is not an app, found ${nodes.length}; nothing was written`);
    return nodes[0].id;
  }

  /** The lock of a repository with no gate to claim in (#407 makes the gate read Linear): an issue whose delegate is already the app is held. */
  async function take({ args: [key], flags }) {
    const issue = await issueTeam(key);
    const to = started(issue);
    const delegateId = await api.appUserId();
    if (issue.delegate?.id === delegateId) throw new Refused(`${key} is held: the Factory app is already its delegate; another Lead has it, take another issue`);
    done(await update(issue.id, { delegateId, assigneeId: null, stateId: to.id }), 'issueUpdate');
    const c = done(await api.commentCreate({ issueId: issue.id, body: `Taken by team ${flags['--team']}.`, team: flags['--team'] }), 'commentCreate');
    return { ok: true, key, status: to.name, delegate: 'app', assignee: null, team: flags['--team'], commentId: c.comment?.id ?? null };
  }

  async function read({ args: [key] }) {
    const comments = [];
    let issue = null;
    let after = null;
    do {
      const data = await q(`query($id: String!, $after: String) { issue(id: $id) { identifier title description url state { name type } delegate { id name } assignee { id name }
        comments(first: 100, after: $after) { nodes { id body createdAt user { id name } botActor { name } } pageInfo { hasNextPage endCursor } } } }`, { id: key, after });
      issue = data?.issue;
      if (!issue) throw new Refused(`Linear has no issue ${key}`);
      for (const c of issue.comments.nodes) comments.push({ id: c.id, author: c.user?.name ?? c.botActor?.name ?? null, authorId: c.user?.id ?? null, createdAt: c.createdAt, body: c.body });
      after = issue.comments.pageInfo.hasNextPage ? issue.comments.pageInfo.endCursor : null;
    } while (after);
    return {
      ok: true, key: issue.identifier, title: issue.title, description: issue.description ?? '', url: issue.url, status: issue.state?.name ?? null, statusType: issue.state?.type ?? null,
      delegate: issue.delegate ? { id: issue.delegate.id, name: issue.delegate.name } : null, assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name } : null, comments,
    };
  }

  const bodyOf = async () => {
    const body = await readStdin();
    if (!body.trim()) throw new Usage('the body on stdin is empty');
    if (body.length > MAX_BODY) throw new Usage(`the body is over ${MAX_BODY} characters`);
    return body;
  };

  async function comment({ args: [key], flags }) {
    const body = await bodyOf();
    const issue = await issueTeam(key);
    const c = done(await api.commentCreate({ issueId: issue.id, body, team: flags['--team'] }), 'commentCreate');
    return { ok: true, key, commentId: c.comment?.id ?? null };
  }

  async function ask({ args: [key], flags }) {
    const body = await bodyOf();
    const issue = await issueTeam(key);
    const to = stateNamed(issue, NEEDS_HUMAN);
    const assigneeId = await human();
    done(await update(issue.id, { stateId: to.id, assigneeId }), 'issueUpdate');
    const c = done(await api.commentCreate({ issueId: issue.id, body, team: flags['--team'] }), 'commentCreate');
    return { ok: true, key, status: to.name, assigned: 'human', commentId: c.comment?.id ?? null };
  }

  async function answered({ args: [key] }) {
    const issue = await issueTeam(key);
    const to = started(issue);
    done(await update(issue.id, { assigneeId: null, stateId: to.id }), 'issueUpdate');
    return { ok: true, key, status: to.name, assignee: null };
  }

  async function create({ flags }) {
    const body = await bodyOf();
    const teamKey = flags['--team-key'];
    const team = (await q(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name ${STATES} } } }`, { key: teamKey }))?.teams?.nodes?.[0];
    if (!team) throw new Refused(`Linear has no team with key ${teamKey}`);
    const status = team.states.nodes.find((s) => s.name === flags['--status']);
    if (!status) throw new Refused(`team ${teamKey} has no status named ${flags['--status']}`);
    const r = done(await api.issueCreate({ teamId: team.id, title: flags['--title'], description: body, stateId: status.id, delegate: flags['--delegate'] === true, team: team.name }), 'issueCreate');
    return { ok: true, key: r.issue?.identifier ?? null, status: status.name, delegate: flags['--delegate'] === true ? 'app' : null };
  }

  async function list({ flags }) {
    const teamKey = flags['--team-key'];
    const types = flags['--status']?.length ? [...new Set(flags['--status'])] : OPEN_TYPES;
    const issues = [];
    let after = null;
    do {
      const data = await q(`query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) {
        nodes { identifier title updatedAt state { name type } delegate { name } assignee { name } } pageInfo { hasNextPage endCursor } } }`,
      { filter: { team: { key: { eq: teamKey } }, state: { type: { in: types } } }, after });
      const page = data?.issues;
      if (!page) throw new Refused('Linear did not answer the list');
      for (const n of page.nodes) issues.push({ key: n.identifier, title: n.title, status: n.state?.name ?? null, statusType: n.state?.type ?? null, delegate: n.delegate?.name ?? null, assignee: n.assignee?.name ?? null, updatedAt: n.updatedAt });
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return { ok: true, teamKey, statusTypes: types, count: issues.length, issues };
  }

  const BY_HAND = `Linear refused the app. By hand, in about a minute: in Linear create the team with this key and name, choosing "copy settings from" Factory (${FIRST_TEAM}); then check it has a status named "${NEEDS_HUMAN}" of type Started, adding it if not; then run this command again.`;

  async function onboard({ args: [repo], flags }) {
    const key = flags['--key'];
    const find = async (k) => (await q(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name ${STATES} } } }`, { key: k }))?.teams?.nodes?.[0] ?? null;
    let team = await find(key);
    let createdTeam = false;
    if (!team) {
      const from = await find(FIRST_TEAM);
      if (!from) throw new Refused(`team ${FIRST_TEAM}, the one to copy settings from, was not found; nothing was created`);
      let made;
      try {
        made = done(await q('mutation($from: String, $input: TeamCreateInput!) { teamCreate(copySettingsFromTeamId: $from, input: $input) { success team { id key name } } }', { from: from.id, input: { key, name: flags['--name'] } }), 'teamCreate');
      } catch (e) {
        throw new Refused(`${e.message}. ${BY_HAND} Key ${key}, name ${flags['--name']}.`);
      }
      createdTeam = true;
      team = (await find(key)) ?? { ...made.team, states: { nodes: [] } };
    }
    let createdState = false;
    const have = team.states.nodes.find((s) => s.name === NEEDS_HUMAN);
    if (have && have.type !== 'started') throw new Refused(`team ${key} has a status ${NEEDS_HUMAN} of type ${have.type}, not started; nothing was changed in it`);
    if (!have) {
      try {
        done(await q('mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }', { input: { teamId: team.id, name: NEEDS_HUMAN, type: 'started', color: COLOR } }), 'workflowStateCreate');
      } catch (e) {
        throw new Refused(`${e.message}. ${BY_HAND}`);
      }
      createdState = true;
    }
    const registry = readRegistry(state);
    const now = { key, teamId: team.id };
    const had = registry[repo];
    const changed = !had || had.key !== now.key || had.teamId !== now.teamId;
    if (changed) writeRegistry(state, { ...registry, [repo]: now });
    return {
      ok: true, repo, key, teamId: team.id, createdTeam, createdState, registered: changed,
      ...(createdTeam ? { next: `Grant the Factory app the team ${key} with one click: Settings → AI & Agents.` } : {}),
    };
  }

  const verbs = { take, read, comment, ask, answered, create, onboard, list };
  /** Runs one verb; { code, out } with `out` the JSON object. */
  return async function run(argv) {
    let parsed;
    try {
      parsed = parse(argv);
    } catch (e) {
      return { code: 2, out: { ok: false, error: e.message } };
    }
    try {
      return { code: 0, out: await verbs[parsed.verb](parsed) };
    } catch (e) {
      const first = String(e?.message ?? e).split('\n')[0];
      return { code: e instanceof Usage ? 2 : 1, out: { ok: false, error: first } };
    }
  };
}

async function stdinText() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** The command on the factory host: prints the JSON, returns the exit code. A tty on stdin gives an empty body, which a verb that needs one refuses. */
export async function main(argv, env = process.env, { api, readStdin = () => (process.stdin.isTTY ? Promise.resolve('') : stdinText()) } = {}) {
  const state = env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory');
  const run = createCli({ api: api ?? createLinear({ state }), state, readStdin });
  const { code, out } = await run(argv);
  console.log(JSON.stringify(out));
  if (code === 2) console.error('usage: factory linear take|read|list|comment|ask|answered|create|onboard ... (see bin/lib/linear-cli.mjs)');
  return code;
}
