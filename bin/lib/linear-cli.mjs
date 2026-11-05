// `factory linear <verb>` (#404, sublayer 1b): the steps a Lead needs on a repository on Linear, and the one step that puts a repository there.
// It runs on the factory host and calls Linear itself through createLinear (bin/lib/linear.mjs, #403), which reads the app's token in this
// process; on the MacBook bin/lib/factory.mjs runs the same command on the host by ssh. No free-form GraphQL is offered.
//   take <KEY> --team <team>                    the app becomes the delegate, no person is assigned, the issue moves to its team's first `started`
//                                               status, and one comment "Taken by team <team>." names the holder; the holder is the earliest such
//                                               comment after the last "Released by team" one, and a take is refused when it is another team's
//   release <KEY> --team <team>                 the holder only: the delegate cleared, the first `unstarted` status, a "Released by team" comment
//   read <KEY>                                  title, description, status, delegate, assignee and every comment, as JSON
//   comment <KEY> --team <team> --body-file -   one comment, shown as "<team> (via Factory)"
//   ask <KEY> --team <team> --body-file -       status Needs Human, the Human assigned, one comment (the question and its tick boxes)
//   answered <KEY> --team <team>                the assignee removed, the issue back in the first `started` status
//   list --team-key <KEY> [--status <type>]...  the team's open issues (default types triage, backlog, unstarted, started); a read
//   create --team-key <KEY> --title <t> --status <name> --body-file - [--delegate --team <team>]   an issue with an explicit status, never Triage
//                                               by accident; --delegate (which needs --team) also posts the holder comment a take posts
//   comment and ask refuse a body with a line that reads as a holder or release comment (those are for take, release and create)
//   onboard <repo> --key <KEY> --name <name>    the repository's team (copied from FAC) and its Needs Human status, and the registry
// One JSON object on stdout. Exit 0 done, 1 Linear refused or failed (the reason is in `error`, never a token), 2 usage.
// Scope: take, comment, ask, answered, create and list act only on a team that is in the registry, never on INN or any other team; read does
// not. `--team` is a team name of the factory's grammar (bin/lib/names.mjs). A corrupt registry file refuses every verb that reads it.
// The Human is found, never stored: the one workspace owner who is not an app; any other count refuses.
// The registry, $FACTORY_STATE/linear/repos.json { "<repo>": { key, teamId } }, is written only by `onboard`, atomically; a repository
// not in it is on GitHub. `onLinear(repo)` reads it.
import { join } from 'node:path';
import { createLinear } from './linear.mjs';
import { TEAM_KEY, onLinear, readRegistry, registryFile, updateRegistry } from './linear-repos.mjs';
import { TEAM } from './names.mjs';

export const NEEDS_HUMAN = 'Needs Human';
const FIRST_TEAM = 'FAC';
const COLOR = '#f2994a';
const KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$/;
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
  release: { args: 1, flags: { '--team': 'value' } },
  create: { args: 0, flags: { '--team': 'value', '--team-key': 'value', '--title': 'value', '--status': 'value', '--body-file': 'value', '--delegate': 'bool' } },
  onboard: { args: 1, flags: { '--key': 'value', '--name': 'value' } },
  list: { args: 0, flags: { '--team-key': 'value', '--status': 'repeat' } },
};
/** The status types of the shared view 'Active (all teams)': what `list` shows unless `--status` narrows it. */
export const OPEN_TYPES = ['triage', 'backlog', 'unstarted', 'started'];
const REQUIRED = {
  take: ['--team'], comment: ['--team', '--body-file'], ask: ['--team', '--body-file'], answered: ['--team'], release: ['--team'],
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
  if (verb === 'create' && flags['--delegate'] && !('--team' in flags)) throw new Usage('create: --delegate needs --team, the team that holds the issue');
  if ('--body-file' in flags && flags['--body-file'] !== '-') throw new Usage(`${verb}: the body comes on stdin: --body-file -`);
  if (verb === 'onboard' ? !WORD.test(args[0]) : shape.args === 1 && !KEY.test(args[0])) throw new Usage(`${verb}: ${args[0]} is not a ${verb === 'onboard' ? 'repository name' : 'issue key such as FAC-12'}`);
  if ('--team' in flags && !TEAM.test(flags['--team'])) throw new Usage(`${verb}: --team is a team name: a lowercase letter, then at most 31 lowercase letters and digits`);
  for (const f of ['--team-key', '--key']) if (f in flags && !TEAM_KEY.test(flags[f])) throw new Usage(`${verb}: ${f} is a team key such as FAC`);
  if (verb === 'list') for (const t of flags['--status'] ?? []) if (!OPEN_TYPES.includes(t)) throw new Usage(`list: --status is one of ${OPEN_TYPES.join(', ')}`);
  for (const f of verb === 'list' ? [] : ['--title', '--status', '--name']) if (f in flags && (!flags[f].trim() || flags[f].length > 200 || /[\x00-\x1f]/.test(flags[f]))) throw new Usage(`${verb}: ${f} is one line of 1 to 200 characters`);
  return { verb, args, flags };
}

const TAKEN = 'Taken by team';
const RELEASED = 'Released by team';
const TAKEN_LINE = new RegExp(`^${TAKEN} ([a-z][a-z0-9]{0,31})\\.\\s*$`);
const RELEASED_LINE = new RegExp(`^${RELEASED} ([a-z][a-z0-9]{0,31})(?:\\.|\\s\\()`);

/** Whether a line reads as a holder or a release comment line. */
export const isHolderLine = (line) => TAKEN_LINE.test(line) || RELEASED_LINE.test(line);

/** The team that holds an issue, or null: the earliest "Taken by team X." comment after the last "Released by team Y" one, from comments of
 * { body, createdAt } in any order. The delegate is the one shared app for every team, so only these comments say which team holds it. */
export function holderOf(comments) {
  const ordered = comments.map((c, i) => ({ c, i })).sort((a, b) => (a.c.createdAt < b.c.createdAt ? -1 : a.c.createdAt > b.c.createdAt ? 1 : a.i - b.i));
  let who = null;
  for (const { c } of ordered) {
    const line = String(c.body ?? '').split('\n')[0];
    if (RELEASED_LINE.test(line)) who = null;
    else if (!who) who = TAKEN_LINE.exec(line)?.[1] ?? null;
  }
  return who;
}

const done = (data, what) => {
  if (!data?.[what]?.success) throw new Refused(`Linear did not confirm ${what}`);
  return data[what];
};

/** Every comment of an issue, oldest first, as { body, createdAt }. */
export async function commentsOfIssue(api, key) {
  const all = [];
  let after = null;
  do {
    const page = (await api.request('query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { body createdAt } pageInfo { hasNextPage endCursor } } } }', { id: key, after }))?.issue?.comments;
    if (!page) throw new Refused(`Linear did not give the comments of ${key}`);
    all.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return all;
}

/** The holder comment of a take, and the read-back after it: when another named team's comment came first, refuse. A read-back with no
 * holder (its own comment not yet visible) is success. Used by `take`, by `create --delegate` and by bin/factory-move (#406). */
export async function announceTakeOn(api, issueId, key, team) {
  const commentId = done(await api.commentCreate({ issueId, body: `${TAKEN} ${team}.`, team }), 'commentCreate').comment?.id ?? null;
  const first = holderOf(await commentsOfIssue(api, key));
  if (first && first !== team) throw new Refused(`${key} is held by team ${first}, whose take came first; take another issue`);
  return commentId;
}

const STATES = 'states(first: 100) { nodes { id name type position } }';
const firstStarted = (states) => states.filter((s) => s.type === 'started' && s.name !== NEEDS_HUMAN).sort((a, b) => a.position - b.position)[0];

export function createCli({ api, state, readStdin }) {
  const q = (query, vars) => api.request(query, vars);

  /** A write or a list acts only on the team of a repository in the registry, so a Lead cannot touch INN or any other team. */
  const inScope = (teamKey) => {
    const keys = Object.values(readRegistry(state)).map((e) => e?.key);
    if (!keys.includes(teamKey)) throw new Refused(`team ${teamKey} is not the team of a repository on Linear (not in the registry); nothing was done`);
  };

  /** The issue with its team; with `scoped`, refused unless its team is a repository's. */
  async function issueTeam(key, { scoped = true } = {}) {
    const issue = (await q(`query($id: String!) { issue(id: $id) { id identifier delegate { id } team { id key ${STATES} } } }`, { id: key }))?.issue;
    if (!issue) throw new Refused(`Linear has no issue ${key}`);
    if (scoped) inScope(issue.team.key);
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
  /** The Human: the one workspace owner who is not an app. Any other count refuses and names the count. */
  async function human() {
    const nodes = (await q('query { users(filter: { owner: { eq: true }, app: { eq: false } }, first: 10) { nodes { id } } }'))?.users?.nodes ?? [];
    if (nodes.length !== 1) throw new Refused(`expected exactly one workspace owner who is not an app, found ${nodes.length}; nothing was written`);
    return nodes[0].id;
  }

  const commentsOf = (key) => commentsOfIssue(api, key);
  const announceTake = (issueId, key, team) => announceTakeOn(api, issueId, key, team);

  /** The lock of a repository with no gate to claim in (#407 makes the gate read Linear). An issue is held by the team of the earliest
   * holder comment. Another team's issue is refused with nothing written, whether the app is still its delegate or not: that team takes
   * it again or releases it. The holder's own team may take it again, and so may anyone when no comment names a holder (its comment
   * failed). After its own comment, `take` reads the comments once more, so a lost race changes nothing more. */
  async function take({ args: [key], flags }) {
    const team = flags['--team'];
    const issue = await issueTeam(key);
    const to = started(issue);
    const delegateId = await api.appUserId();
    const who = holderOf(await commentsOf(key));
    if (who && who !== team) {
      throw new Refused(issue.delegate?.id === delegateId
        ? `${key} is held by team ${who}; take another issue`
        : `${key} is held by team ${who}, though its delegate is not set; that team releases it with factory linear release, or takes it again; take another issue`);
    }
    done(await update(issue.id, { delegateId, assigneeId: null, stateId: to.id }), 'issueUpdate');
    const commentId = who === team ? null : await announceTake(issue.id, key, team);
    return { ok: true, key, status: to.name, delegate: 'app', assignee: null, team, commentId };
  }

  /** For the holder only: clears the delegate, moves the issue to its team's first `unstarted` status and comments the release. */
  async function release({ args: [key], flags }) {
    const team = flags['--team'];
    const issue = await issueTeam(key);
    const who = holderOf(await commentsOf(key));
    if (who !== team) throw new Refused(who ? `${key} is held by team ${who}, not ${team}; only the holder releases it` : `${key} is held by no team; nothing to release`);
    const to = issue.team.states.nodes.filter((s) => s.type === 'unstarted').sort((a, b) => a.position - b.position)[0];
    if (!to) throw new Refused(`team ${issue.team.key} has no status of type unstarted`);
    done(await update(issue.id, { delegateId: null, stateId: to.id }), 'issueUpdate');
    const c = done(await api.commentCreate({ issueId: issue.id, body: `${RELEASED} ${team}.`, team }), 'commentCreate');
    return { ok: true, key, status: to.name, delegate: null, team, commentId: c.comment?.id ?? null };
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

  /** `comment` and `ask` post no line that holderOf would read as a holder or a release: those are for take, release and create. */
  const bodyForComment = async () => {
    const body = await bodyOf();
    if (body.split('\n').some(isHolderLine)) throw new Refused('the body has a line that reads as a holder comment (Taken by team … or Released by team …); only take, release and create post those; nothing was written');
    return body;
  };

  async function comment({ args: [key], flags }) {
    const body = await bodyForComment();
    const issue = await issueTeam(key);
    const c = done(await api.commentCreate({ issueId: issue.id, body, team: flags['--team'] }), 'commentCreate');
    return { ok: true, key, commentId: c.comment?.id ?? null };
  }

  async function ask({ args: [key], flags }) {
    const body = await bodyForComment();
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
    inScope(teamKey);
    const team = (await q(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name ${STATES} } } }`, { key: teamKey }))?.teams?.nodes?.[0];
    if (!team) throw new Refused(`Linear has no team with key ${teamKey}`);
    const status = team.states.nodes.find((s) => s.name === flags['--status']);
    if (!status) throw new Refused(`team ${teamKey} has no status named ${flags['--status']}`);
    const delegate = flags['--delegate'] === true;
    const r = done(await api.issueCreate({ teamId: team.id, title: flags['--title'], description: body, stateId: status.id, delegate, team: flags['--team'] }), 'issueCreate');
    // An issue created with the app as its delegate is held by the creating team, as a take would say.
    if (delegate) await announceTake(r.issue.id, r.issue.identifier, flags['--team']);
    return { ok: true, key: r.issue?.identifier ?? null, status: status.name, delegate: delegate ? 'app' : null };
  }

  async function list({ flags }) {
    const teamKey = flags['--team-key'];
    inScope(teamKey);
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
    // Before anything is created: a corrupt registry throws here, and a key that is another repository's is refused.
    const taken = (registry) => Object.entries(registry).find(([other, e]) => other !== repo && e?.key === key)?.[0];
    const clash = taken(readRegistry(state));
    if (clash) throw new Refused(`key ${key} is already the team of ${clash}; nothing was changed`);
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
    // Only a team this command made gets the status; a team that was already there (INN, say) must have it, or it is not a repository's team.
    if (!have && !createdTeam) throw new Refused(`team ${key} exists but has no status named ${NEEDS_HUMAN} of type started; nothing was changed`);
    if (!have) {
      try {
        done(await q('mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }', { input: { teamId: team.id, name: NEEDS_HUMAN, type: 'started', color: COLOR } }), 'workflowStateCreate');
      } catch (e) {
        throw new Refused(`${e.message}. ${BY_HAND}`);
      }
      createdState = true;
    }
    const now = { key, teamId: team.id };
    const changed = await updateRegistry(state, (registry) => {
      const other = taken(registry);
      if (other) throw new Refused(`key ${key} is already the team of ${other}; the registry was not changed`);
      const had = registry[repo];
      return !had || had.key !== now.key || had.teamId !== now.teamId ? { ...registry, [repo]: now } : null;
    });
    return {
      ok: true, repo, key, teamId: team.id, createdTeam, createdState, registered: changed,
      ...(createdTeam ? { next: `Grant the Factory app the team ${key} with one click: Settings → AI & Agents.` } : {}),
    };
  }

  const verbs = { take, release, read, comment, ask, answered, create, onboard, list };
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
  if (code === 2) console.error('usage: factory linear take|release|read|list|comment|ask|answered|create|onboard ... (see bin/lib/linear-cli.mjs)');
  return code;
}
