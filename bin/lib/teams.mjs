// The teams of the accounts file (#311): a row `factory/<repo>-<team>` is a team's when its repository is onboarded (the launcher's
// own test, refusal() in packs/pstack/bin/lead.mjs) or is the factory's own repository, `factory`, which is the checkout's root
// and not a folder under it. So `factory/lead-alpha`, an old Lead row, is not read as repository `lead`, team `alpha`, and a seat
// row is no team at all.
import { ROOT } from './checkout.mjs';
import { parseTeam } from './names.mjs';
import { refusal } from '../../packs/pstack/bin/lead.mjs';
import { readAccounts } from './token.mjs';

export const FACTORY_REPO = 'factory';

/** Whether repo can have teams: the factory itself, or an onboarded clone under root. */
export const repoOk = (repo, root = ROOT) => repo === FACTORY_REPO || refusal(repo, root) === null;

/** The teams the file names, sorted by name: { name, row, repo, team, account }. */
export function teamRows(state, root = ROOT) {
  return Object.entries(readAccounts(state))
    .flatMap(([row, account]) => {
      const name = row.startsWith('factory/') ? row.slice('factory/'.length) : null;
      const t = parseTeam(name);
      return t && repoOk(t.repo, root) ? [{ name, row, repo: t.repo, team: t.team, account }] : [];
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The distinct accounts of the teams, sorted. */
export const teamAccounts = (state, root = ROOT) => [...new Set(teamRows(state, root).map((t) => t.account))].sort();
