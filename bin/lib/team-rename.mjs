// #416, sublayer 0d: the Human runs --apply; dry run reads and prints the moves only.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './checkout.mjs';
import { parseTeam, TEAM } from './names.mjs';
import { teamsOf } from './team-names.mjs';
import { leadTeams, readProcesses } from './top.mjs';
import { onLinear } from './linear-repos.mjs';
import { createLinear } from './linear.mjs';
import { announceReleaseOn, announceTakeOn, commentsOfIssue, holderOf } from './linear-cli.mjs';

function command(file, args, cwd) {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${file}: ${r.stderr?.trim() || r.error?.message || r.status}`);
  return r.stdout;
}

export async function renameTeam(repo, old, next, { apply = false, home = process.env.HOME, root = ROOT,
  state = process.env.FACTORY_STATE ?? join(home, '.local/state/factory'),
  runs = process.env.FACTORY_RUNS ?? join(home, 'factory-runs'),
  profiles = process.env.AGENT_PROFILES ?? join(home, '.agent-profiles'), processes = readProcesses,
  api, run = command, log = console.log } = {}) {
  if (!parseTeam(`${repo}-${old}`) || !TEAM.test(next) || old === next) throw new Error('usage: factory-team-rename <repo> <old> <new> [--apply]');
  if (leadTeams(repo, processes).includes(old)) throw new Error(`the Lead of ${repo}-${old} is running; stop it first`);
  if (teamsOf(repo, { home, root, state, runs, processes }).includes(next)) throw new Error(`${repo}-${next} already exists`);
  const moves = [];
  const folder = repo === 'factory' ? root : join(root, repo);
  for (const [label, from, to] of [
    ['run folder (including transcripts)', join(runs, `${repo}-${old}`), join(runs, `${repo}-${next}`)],
    ['local Lead socket record', join(state, 'lead-here', `${repo}-${old}.socket`), join(state, 'lead-here', `${repo}-${next}.socket`)],
    ['team Claude profile', join(profiles, 'factory', `${repo}-${old}`), join(profiles, 'factory', `${repo}-${next}`)],
  ]) {
    if (existsSync(to)) throw new Error(`${to} already exists`);
    if (existsSync(from)) moves.push({ label: `${label}: ${from} -> ${to}`, apply: () => { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); } });
  }
  // Onboarded repositories use a shared <owner>/<repo>/claude profile via .envrc. Its path is independent of the team.
  log('repository Claude profile: kept at the same path (.envrc is unchanged)');
  const accounts = join(state, 'accounts');
  const before = existsSync(accounts) ? readFileSync(accounts, 'utf8') : '';
  const oldRow = `factory/${repo}-${old}`;
  const newRow = `factory/${repo}-${next}`;
  const after = before.split('\n').map((line) => {
    const i = line.indexOf('=');
    return i > 0 && line.slice(0, i).trim() === oldRow ? `${newRow}${line.slice(i)}` : line;
  }).join('\n');
  if (after !== before) moves.push({ label: `account row: ${oldRow} -> ${newRow}`, apply: () => {
    if (readFileSync(accounts, 'utf8') !== before) throw new Error('accounts changed since the plan was read');
    const tmp = `${accounts}.${process.pid}.tmp`;
    writeFileSync(tmp, after, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, accounts);
  } });
  if (!moves.length) throw new Error(`no local state for ${repo}-${old}`);
  // Read GitHub claims even after migration: old claims may still name the team.
  const claim = join(folder, '.gate/bin/claim');
  if (existsSync(claim)) {
    for (const line of run(claim, ['--list'], folder).trim().split('\n')) {
      const [n, , holder] = line.split('\t');
      if (holder === old && /^[1-9]\d*$/.test(n)) moves.push({ label: `GitHub claim #${n}: ${old} -> ${next}`, apply: () => run(claim, ['--handoff', n, old, next], folder) });
    }
  }
  const linear = onLinear(repo, state);
  if (linear) {
    api ??= createLinear({ state, agentProfiles: profiles });
    let after = null;
    do {
      const page = (await api.request('query($team: ID!, $after: String) { issues(filter: { team: { id: { eq: $team } } }, first: 100, after: $after) { nodes { id identifier } pageInfo { hasNextPage endCursor } } }', { team: linear.teamId, after }))?.issues;
      if (!page) throw new Error('Linear did not list the issues');
      for (const issue of page.nodes) {
        if (holderOf(await commentsOfIssue(api, issue.identifier)) !== old) continue;
        moves.push({ label: `Linear ${issue.identifier}: release ${old}`, apply: () => announceReleaseOn(api, issue.id, issue.identifier, old) });
        moves.push({ label: `Linear ${issue.identifier}: take ${next}`, apply: () => announceTakeOn(api, issue.id, issue.identifier, next) });
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  if (!apply) { for (const m of moves) log(`would move ${m.label}`); return; }
  for (let i = 0; i < moves.length; i++) {
    try { await moves[i].apply(); log(`moved ${moves[i].label}`); }
    catch (e) {
      for (const m of moves.slice(i)) log(`not completed ${m.label}`);
      throw new Error(`${moves[i].label}: ${e.message}; earlier moves remain applied; inspect this step before continuing`);
    }
  }
}

export async function main(argv, env = process.env) {
  const [repo, old, next, ...flags] = argv;
  if (argv.length < 3 || flags.length > 1 || flags.some((f) => f !== '--apply')) { console.error('usage: factory-team-rename <repo> <old> <new> [--apply]'); return 2; }
  try {
    await renameTeam(repo, old, next, { apply: flags.includes('--apply'), home: env.HOME, root: env.FACTORY_ROOT ?? ROOT,
      state: env.FACTORY_STATE ?? join(env.HOME, '.local/state/factory'), runs: env.FACTORY_RUNS ?? join(env.HOME, 'factory-runs'), profiles: env.AGENT_PROFILES ?? join(env.HOME, '.agent-profiles') });
    return 0;
  } catch (e) { console.error(e.message); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
