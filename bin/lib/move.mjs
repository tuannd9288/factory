// `bin/factory-move <owner>/<repo> --team-key <KEY> --board <owner>/<number> [--apply] [--limit N]` (#406, sublayer 1b): moves a repository's
// open GitHub issues to its Linear team, once. It runs on the factory host: GitHub through the `gh` runner (a read, then one comment and one
// close for each issue), Linear through createLinear (bin/lib/linear.mjs), as the Factory app. It is not a `factory linear` verb.
// Without --apply it is a dry run: it reads everything, writes nothing and prints the plan, one line for each issue. --limit N moves only the
// first N issues not moved yet, by number. The repository must be in the registry (bin/lib/linear-repos.mjs) with the team key given.
//   board Status   FAC status    holder
//   Triage         Triage        none        (an issue with no board item is Triage too)
//   Todo           Todo          none
//   In Progress    In Progress   the app as delegate, and the comment "Taken by team lead." (bin/lib/linear-cli.mjs)
// Any other board Status refuses the whole run, before any write, naming the issue. FAC's statuses are found by name on the team.
// A FAC issue has the same title and no label and no assignee. Its description opens with "Moved from <GitHub URL>", then "Parent on GitHub:
// #n" when the parent does not move, then "**Sublayer:** <code>" taken from a `sublayer-*` label when the body has none, then the body as it
// is. Its created date is GitHub's. Each GitHub comment follows in order, verbatim, dated as GitHub dates it, shown as "<login> (via GitHub)".
// A parent that moves too is the issue's `parentId` (set later, by the end of a run, when the parent moved after the child).
// On GitHub, once the Linear side is complete (created, comments, holder): one comment "Moved to <KEY>: <URL>", then the issue is closed as
// not planned. Nothing is deleted.
// Resuming: $FACTORY_STATE/linear/moved/<owner>-<repo>.json records each step as it is done, written atomically after every step:
//   { version: 1, issues: { "<number>": { key, id, url, parentOf, comments, parent, held, ghComment, closed } } }
// `comments` counts the comments written, `parent` is whether `parentId` is set. A second run finishes what a first left half done and
// repeats no write. When the file is lost, an issue is looked for in the team by its first description line before one is created, and
// adopted; a map file that exists and does not parse refuses the run.
// Exit 0 done, 1 refused or failed (the reason is the first line of the message, never a token), 2 usage.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinear } from './linear.mjs';
import { announceTakeOn, commentsOfIssue, isHolderLine } from './linear-cli.mjs';
import { TEAM_KEY, onLinear } from './linear-repos.mjs';
import { redact } from './redact.mjs';

const LEAD_TEAM = 'lead';
const CALL_MS = 120_000;
const STATUS = {
  Triage: { fac: 'Triage', hold: false },
  Todo: { fac: 'Todo', hold: false },
  'In Progress': { fac: 'In Progress', hold: true },
};
const MOVED_TO = /^Moved to [A-Z][A-Z0-9]*-[1-9][0-9]*: /;

class Usage extends Error {}
class Refused extends Error {}

const ISSUES = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(states:OPEN,first:50,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
nodes{number title body createdAt url author{login} labels(first:100){nodes{name}} parent{number}
projectItems(first:20){nodes{project{number owner{... on User{login} ... on Organization{login}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}
pageInfo{hasNextPage endCursor}}}}`;
const COMMENTS = `query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$n){
comments(first:100,after:$after){nodes{author{login} createdAt body} pageInfo{hasNextPage endCursor}}}}}`;
const STATES = 'states(first: 100) { nodes { id name type position } }';

function ghRun(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CALL_MS, maxBuffer: 256 << 20 });
}

const firstLine = (error) => redact(String(error?.stderr || error?.message || error).trim().split('\n')[0]).slice(0, 200);

/** { verb-less } the command line as { repo, teamKey, board: { owner, number }, apply, limit }, or a thrown Usage. */
export function parse(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) args.push(a);
    else if (a === '--apply') flags.apply = true;
    else if (['--team-key', '--board', '--limit'].includes(a)) {
      if (a in flags) throw new Usage(`${a} is given twice`);
      if (argv[i + 1] === undefined) throw new Usage(`${a} needs a value`);
      flags[a] = argv[++i];
    } else throw new Usage(`${a} is not a flag of it`);
  }
  if (args.length !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(args[0])) throw new Usage('expects one argument, the repository as owner/name');
  if (!TEAM_KEY.test(flags['--team-key'] ?? '')) throw new Usage('--team-key is required, a team key such as FAC');
  const board = /^([\w.-]+)\/([1-9]\d*)$/.exec(flags['--board'] ?? '');
  if (!board) throw new Usage('--board is required, as owner/number');
  if ('--limit' in flags && !/^[1-9]\d*$/.test(flags['--limit'])) throw new Usage('--limit is a whole number of at least 1');
  return { repo: args[0], teamKey: flags['--team-key'], board: { owner: board[1], number: Number(board[2]) }, apply: flags.apply === true, limit: '--limit' in flags ? Number(flags['--limit']) : Infinity };
}

export const mapFile = (state, repo) => join(state, 'linear', 'moved', `${repo.replace('/', '-')}.json`);

/** The map as { version, issues }: empty when there is no file; throws when the file is there and does not read or parse. */
export function readMap(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, issues: {} };
    throw new Refused(`the map file ${file} exists but cannot be read (${e.code ?? 'error'}); nothing was changed`);
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    m = null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !m.issues || typeof m.issues !== 'object' || Array.isArray(m.issues)) {
    throw new Refused(`the map file ${file} exists but does not parse as a map; nothing was changed`);
  }
  return m;
}

function writeMap(file, map) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const done = (data, what) => {
  if (!data?.[what]?.success) throw new Refused(`Linear did not confirm ${what}`);
  return data[what];
};

export function createMove({ gh = ghRun, api, state }) {
  /** A GraphQL read; a number goes as -F, a string as -f, a null is left out. */
  const graphql = (query, vars) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) if (v !== null) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
    return JSON.parse(gh(args)).data;
  };

  async function readIssues(owner, name, board) {
    const out = [];
    let after = null;
    do {
      const page = graphql(ISSUES, { owner, name, after }).repository.issues;
      for (const n of page.nodes) {
        const item = n.projectItems.nodes.find((i) => i.project?.number === board.number && String(i.project.owner?.login).toLowerCase() === board.owner.toLowerCase());
        out.push({
          number: n.number, title: n.title, body: n.body ?? '', createdAt: n.createdAt, url: n.url, author: n.author?.login ?? null,
          labels: n.labels.nodes.map((l) => l.name), parent: n.parent?.number ?? null, board: item?.fieldValueByName?.name ?? null,
        });
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out.sort((a, b) => a.number - b.number);
  }

  /** Every comment of the issue, oldest first, as { login, createdAt, body }. */
  function readComments(owner, name, n) {
    const out = [];
    let after = null;
    do {
      const page = graphql(COMMENTS, { owner, name, n, after }).repository.issue.comments;
      for (const c of page.nodes) out.push({ login: c.author?.login ?? 'ghost', createdAt: c.createdAt, body: c.body ?? '' });
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  const descriptionOf = (issue, { parentStays }) => {
    const head = [`Moved from ${issue.url}`];
    if (parentStays) head.push(`Parent on GitHub: #${issue.parent}`);
    if (!/^[ \t]*\*{0,2}Sublayer:/im.test(issue.body)) {
      const code = issue.labels.map((l) => /^sublayer-([\w.-]+)$/.exec(l)?.[1]).find(Boolean);
      if (code) head.push(`**Sublayer:** ${code}`);
    }
    return `${head.join('\n')}\n\n${issue.body}`;
  };

  async function run({ repo, teamKey, board, apply, limit }, log = () => {}) {
    const [owner, name] = repo.split('/');
    let entry;
    try {
      entry = onLinear(repo, state);
    } catch (e) {
      throw new Refused(e.message);
    }
    if (entry?.key !== teamKey) throw new Refused(`${repo} is not in the registry with team ${teamKey}; run factory linear onboard first; nothing was done`);
    const file = mapFile(state, repo);
    const map = readMap(file);
    const issues = await readIssues(owner, name, board);
    for (const i of issues) {
      if (i.board !== null && !Object.hasOwn(STATUS, i.board)) throw new Refused(`issue #${i.number} has the board status "${i.board}", which has no place in FAC; nothing was written`);
    }
    const team = (await api.request(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name ${STATES} } } }`, { key: teamKey }))?.teams?.nodes?.[0];
    if (!team) throw new Refused(`Linear has no team with key ${teamKey}`);
    const stateOf = (issue) => STATUS[issue.board ?? 'Triage'];
    for (const fac of new Set(issues.map((i) => stateOf(i).fac))) {
      if (!team.states.nodes.some((s) => s.name === fac)) throw new Refused(`team ${teamKey} has no status named ${fac}; nothing was written`);
    }
    const open = new Set(issues.map((i) => i.number));
    const moves = (n) => open.has(n) || Boolean(map.issues[n]?.key);
    const todo = issues.filter((i) => !map.issues[i.number]?.closed).slice(0, limit);
    const comments = new Map(todo.map((i) => [i.number, readComments(owner, name, i.number)]));
    const toCopy = (i) => comments.get(i.number).filter((c) => !MOVED_TO.test(c.body));
    const lines = todo.map((i) => {
      const parent = i.parent === null ? 'none' : `#${i.parent} (${moves(i.parent) ? 'moves' : 'stays on GitHub'})`;
      return `#${i.number} | ${i.title} | ${stateOf(i).fac} | holder ${stateOf(i).hold ? LEAD_TEAM : 'none'} | parent ${parent} | ${toCopy(i).length} comments`;
    });
    if (!apply) return { ok: true, applied: false, count: todo.length, lines };

    const save = () => writeMap(file, map);
    mkdirSync(join(state, 'linear', 'moved'), { recursive: true });
    const moved = [];
    for (const issue of todo) {
      const status = team.states.nodes.find((s) => s.name === stateOf(issue).fac);
      const copy = toCopy(issue);
      let e = map.issues[issue.number];
      if (!e?.key) {
        e = (await adopt(issue, team, comments.get(issue.number))) ?? (await create(issue, status, team, map, moves));
        map.issues[issue.number] = e;
        save();
      }
      for (let k = e.comments; k < copy.length; k++) {
        done(await api.commentCreate({ issueId: e.id, body: copy[k].body, createdAt: copy[k].createdAt, team: `${copy[k].login} (via GitHub)` }), 'commentCreate');
        e.comments = k + 1;
        save();
      }
      if (stateOf(issue).hold && !e.held) {
        await announceTakeOn(api, e.id, e.key, LEAD_TEAM);
        e.held = true;
        save();
      }
      if (!e.ghComment && !comments.get(issue.number).some((c) => c.body.startsWith(`Moved to ${e.key}: `))) {
        gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue.number}/comments`, '-f', `body=Moved to ${e.key}: ${e.url}`]);
      }
      e.ghComment = true;
      save();
      if (!e.closed) {
        gh(['api', '-X', 'PATCH', `repos/${repo}/issues/${issue.number}`, '-f', 'state=closed', '-f', 'state_reason=not_planned']);
        e.closed = true;
        save();
      }
      moved.push({ number: issue.number, key: e.key });
      log(`#${issue.number} -> ${e.key}`);
    }
    // A child that moved before its parent gets its parentId once the parent is in the map.
    for (const [n, e] of Object.entries(map.issues)) {
      const parent = e.parentOf === null || e.parentOf === undefined ? null : map.issues[e.parentOf];
      if (e.key && !e.parent && parent?.id) {
        done(await api.request('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: e.id, input: { parentId: parent.id } }), 'issueUpdate');
        e.parent = true;
        save();
        log(`#${n} -> parent ${parent.key}`);
      }
    }
    return { ok: true, applied: true, count: moved.length, moved };
  }

  /** The issue's FAC twin that a lost map file did not record: found by its first description line, exactly. */
  async function adopt(issue, team, ghComments) {
    const line = `Moved from ${issue.url}`;
    const found = (await api.request('query($filter: IssueFilter) { issues(filter: $filter, first: 50) { nodes { id identifier url description } } }',
      { filter: { team: { key: { eq: team.key } }, description: { contains: line } } }))?.issues?.nodes ?? [];
    const twin = found.find((n) => String(n.description ?? '').split('\n')[0] === line);
    if (!twin) return null;
    const there = await commentsOfIssue(api, twin.identifier);
    return {
      key: twin.identifier, id: twin.id, url: twin.url, parentOf: issue.parent, comments: there.filter((c) => !c.body.split('\n').some(isHolderLine)).length,
      parent: false, held: there.some((c) => c.body.split('\n').some(isHolderLine)), ghComment: ghComments.some((c) => c.body.startsWith(`Moved to ${twin.identifier}: `)), closed: false,
    };
  }

  async function create(issue, status, team, map, moves) {
    const parent = issue.parent === null ? undefined : map.issues[issue.parent];
    const stay = issue.parent !== null && !moves(issue.parent);
    const made = done(await api.issueCreate({
      teamId: team.id, title: issue.title, description: descriptionOf(issue, { parentStays: stay }), stateId: status.id, createdAt: issue.createdAt,
      ...(parent?.id ? { parentId: parent.id } : {}), delegate: STATUS[issue.board ?? 'Triage'].hold, team: team.name,
    }), 'issueCreate');
    if (!made.issue?.id) throw new Refused('Linear did not name the issue it created');
    return { key: made.issue.identifier, id: made.issue.id, url: made.issue.url, parentOf: issue.parent, comments: 0, parent: Boolean(parent?.id), held: false, ghComment: false, closed: false };
  }

  return { run };
}

/** The command on the factory host: prints the plan or the moves, returns the exit code. */
export async function main(argv, env = process.env, { api, gh } = {}) {
  let opts;
  try {
    opts = parse(argv);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    console.error('usage: factory-move <owner>/<repo> --team-key <KEY> --board <owner>/<number> [--apply] [--limit N] (see bin/lib/move.mjs)');
    return 2;
  }
  const state = env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory');
  try {
    const out = await createMove({ gh, api: api ?? createLinear({ state }), state }).run(opts, (line) => console.log(line));
    if (!out.applied) for (const l of out.lines) console.log(l);
    console.log(JSON.stringify({ ok: true, applied: out.applied, count: out.count }));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: firstLine(e) }));
    return 1;
  }
}

// Node loads the main module by its real path: started through a symlinked directory, argv[1] still names this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
