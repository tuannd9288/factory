// The factory's one way to reach Linear as the "Factory" app (#403, sublayer 1b): the only code that talks to Linear's API. The Lead's reads and
// writes (#404), the sweep's readers (#405) and the daemon's listener (#414) all come through here.
// Decision verbs (#365, sublayer 1e) use Colly instead: read tokens/colly for each request, with no mint or Factory fallback.
//   One token source on each node. Linear keeps up to 1000 client-credentials tokens of one app alive at once when they share their scopes; a
//   mint with other scopes, or a rotated client secret, revokes every token of the app (linear.app/developers/oauth-2-0-authentication, "Client
//   credentials tokens", read 2026-11-07; seen 2026-11-04: a read-scoped token died with 4002 "You need to authenticate" when one with other
//   scopes was minted). So every token is minted with one fixed set of scopes (SCOPES), each node mints its own, and every caller on a node
//   reads that node's from the store for each request; none keeps its own copy. A change to SCOPES revokes every node's token at its first
//   mint, and a node still on the old set mints it back: every node must run the same main.
//   The store (bin/lib/token.mjs, #311): ~/.agent-profiles/tokens/linear-app/ holds `client-id` and `client-secret` (stored by
//   `factory login linear-app <client-id|client-secret>`) and `access.json` { token, expiresAt, scope }, each mode 600 in a folder of mode 700.
//   The folder is no file, so tokenAccounts, accountList, the table of `factory` and `factory use` never see it; the name is refused as an account.
//   The mint (client credentials, 30 days) runs under tokens/linear-app/mint.lock, a folder made with mkdir. After taking it the caller re-reads
//   access.json: a token another caller stored meanwhile, and not one this caller found dead, is used and nothing is minted.
//   Renewal: `renew()` mints when less than RENEW_AHEAD_MS (7 days) is left. Each node's daemon pass runs it once a minute (bin/lib/daemon-pass.mjs),
//   so a node's token is replaced for every caller on it long before it ends. A node with no credentials stored is not an error: renew says
//   'unconfigured'.
//   An authentication failure (HTTP 401, or an error whose code says authentication, or a message that says "authenticate"): the caller re-reads
//   the store and retries once with a token another caller stored there; if it still fails, it mints once under the lock and retries once; if that
//   fails too it raises the condition `linear-auth-failed` (a `start` line in events.jsonl and a line in `factory colly --brief`, bin/lib/events.mjs) and
//   throws. A refused mint raises it too. Any success after that clears it. Nothing here loops: a request makes three sends and two mints at most
//   (token() may mint, then the first send, the send with a token another caller stored, the retry's mint and the send with its token).
//   A symlinked tokens/linear-app is refused: nothing is read from it or written to it.
//   Nothing printed, thrown or written holds the secret or a token: messages are built from a status and a code, and scrubbed of the values in play.
//   Writes show their team: every comment and issue passes createAsUser (the team's full name), so Linear shows "<repo>-<team> (via Factory)"
//   with the app's own icon.
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readActive, record } from './events.mjs';
import { parseTeam } from './names.mjs';
import { redact } from './redact.mjs';
import { APP_FOLDERS, appDir, readTokenFile, tokenDir, writeAppFile } from './token.mjs';

export const APP = APP_FOLDERS[0];
export const TOKEN_URL = 'https://api.linear.app/oauth/token';
export const GRAPHQL_URL = 'https://api.linear.app/graphql';
/** The one set of scopes every token is minted with. Changing it changes every caller's token at the next mint. */
export const SCOPES = ['read', 'write', 'issues:create', 'comments:create', 'app:assignable'];
export const RENEW_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** A token with less than this left is not used for a request. */
export const GRACE_MS = 60_000;
export const CONDITION = 'linear-auth-failed';
/** No request waits longer, so a hung connection cannot stall the daemon's pass. */
const REQUEST_MS = 20_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const first = (error) => String(error?.message ?? error).split('\n')[0];

/** Whether this node's store holds the app's client id and secret (FAC-38): both files present and not empty, in a folder that is no symlink.
 * Their contents are not read. `factory linear` runs on a node that holds them, else on the factory host. */
export function appStored(agentProfiles) {
  const folder = appDir(agentProfiles, APP);
  try {
    return !lstatSync(folder).isSymbolicLink() && ['client-id', 'client-secret'].every((name) => statSync(join(folder, name)).size > 0);
  } catch {
    return false;
  }
}

/** A failure that is Linear's refusal of the token, from the HTTP status and the parsed body. */
export function isAuthFailure(status, body) {
  if (status === 401) return true;
  return (body?.errors ?? []).some((e) => /AUTHENTICATION/i.test(`${e?.extensions?.code ?? ''}${e?.extensions?.type ?? ''}`) || /authenticate|\b4002\b/i.test(String(e?.message ?? '')));
}

export function createLinear({
  agentProfiles = process.env.AGENT_PROFILES ?? join(process.env.HOME, '.agent-profiles'),
  state = process.env.FACTORY_STATE ?? join(process.env.HOME, '.local/state/factory'),
  fetchFn = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
  team = process.env.FACTORY_TEAM,
  raise = null,
  colly = false,
} = {}) {
  const folder = appDir(agentProfiles, APP);
  const lockDir = join(folder, 'mint.lock');
  let appId = null;

  /** Whether the app's folder is no symlink (a missing folder is none either). */
  const plain = () => {
    try {
      return !lstatSync(folder).isSymbolicLink();
    } catch {
      return true;
    }
  };
  const symlinked = () => `${folder} is a symlink; nothing was read from it or written to it`;

  const secrets = () => (plain() ? ['client-id', 'client-secret'].map((n) => readTokenFile(join(folder, n)).token).filter(Boolean) : []);
  /** The text with the secrets, and any token in play, hidden, then redacted, one line, at most 200 characters. */
  const scrub = (text, extra = []) => {
    let out = String(text);
    for (const s of [...secrets(), ...extra]) if (s) out = out.split(s).join('[hidden]');
    return redact(out).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
  };
  const fail = (message, extra = []) => new Error(scrub(message, extra));

  const credentials = () => {
    if (!plain()) return null;
    const id = readTokenFile(join(folder, 'client-id'));
    const secret = readTokenFile(join(folder, 'client-secret'));
    return id.token && secret.token ? { id: id.token, secret: secret.token } : null;
  };

  /** access.json as { token, expiresAt, scope }, or null for none or one that does not read. */
  const readStored = () => {
    if (!plain()) return null;
    try {
      const s = JSON.parse(readFileSync(join(folder, 'access.json'), 'utf8'));
      return typeof s?.token === 'string' && /^[\x21-\x7e]+$/.test(s.token) && Number.isFinite(s.expiresAt) ? s : null;
    } catch {
      return null;
    }
  };
  const lasts = (stored, ahead, failed = []) => Boolean(stored) && stored.expiresAt - now() > ahead && !failed.includes(stored.token);

  /** Clears the condition once something works again. */
  const settle = () => {
    try {
      if (readActive(state).conditions[CONDITION]) record({ state, found: [], read: new Set(['linear']), now: now() });
    } catch {
      // the events could not be written: nothing is cleared, nothing fails
    }
  };
  const alarm = (reason) => {
    if (raise) return raise(reason);
    record({ state, found: [{ key: CONDITION, scope: 'linear', top: true, text: `the Factory app's Linear token fails: ${reason}` }], read: new Set(), now: now() });
  };
  /** Raises the condition and returns the error to throw. The reason is scrubbed first. */
  const loud = (message, extra = []) => {
    const error = fail(message, extra);
    try {
      alarm(error.message);
    } catch {
      // the events could not be written: the error still goes up
    }
    return error;
  };

  async function withLock(fn) {
    if (!plain()) throw fail(symlinked());
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lockDir);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        continue;
      }
      if (Date.now() > until) throw fail('the mint lock is held');
      await sleep(25);
    }
    try {
      return await fn();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  /** The stored token if it lasts `ahead` and is not one in `failed`; else a new one, minted under the lock after a re-read of the store.
   * Returns { token, minted }. */
  async function mint({ ahead = GRACE_MS, failed = [] } = {}) {
    if (!plain()) throw fail(symlinked());
    if (!credentials()) throw fail('the Factory app is not configured: its client id and secret are not stored');
    return withLock(async () => {
      const stored = readStored();
      if (lasts(stored, ahead, failed)) return { token: stored.token, minted: false };
      const c = credentials();
      if (!c) throw fail('the Factory app is not configured: its client id and secret are not stored');
      let res;
      let body = null;
      try {
        res = await fetchFn(TOKEN_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_MS),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret, scope: SCOPES.join(',') }).toString(),
        });
        body = JSON.parse(await res.text());
      } catch (error) {
        if (!res) throw loud(`the token request did not reach Linear: ${first(error)}`);
      }
      const token = body?.access_token;
      if (res.status !== 200 || typeof token !== 'string' || !Number.isFinite(body.expires_in)) throw loud(`Linear refused the token request (HTTP ${res.status})`);
      writeAppFile(agentProfiles, APP, 'access.json', `${JSON.stringify({ token, expiresAt: now() + body.expires_in * 1000, scope: body.scope ?? SCOPES.join(',') })}\n`);
      appId = null;
      settle();
      return { token, minted: true };
    });
  }

  /** The token every caller uses: the stored one, or a new one when none lasts. */
  async function token() {
    const stored = readStored();
    return lasts(stored, GRACE_MS) ? stored.token : (await mint()).token;
  }

  /** Mints when less than RENEW_AHEAD_MS is left: 'renewed', 'kept', or 'unconfigured' when no credentials are stored. Throws (after raising the
   * condition) when the mint fails. */
  async function renew() {
    if (!plain()) throw fail(symlinked());
    if (!credentials()) return 'unconfigured';
    if (lasts(readStored(), RENEW_AHEAD_MS)) return 'kept';
    return (await mint({ ahead: RENEW_AHEAD_MS })).minted ? 'renewed' : 'kept';
  }

  async function send(bearer, query, variables) {
    const res = await fetchFn(GRAPHQL_URL, { method: 'POST', signal: AbortSignal.timeout(REQUEST_MS), headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ query, variables }) });
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      // not JSON: the status says what it was
    }
    return { status: res.status, body };
  }

  /** One GraphQL request; the `data` of the answer. */
  async function request(query, variables = {}) {
    // Colly's key is stored by the Human with `factory store colly`. Never mint or fall back to Factory credentials.
    if (colly) {
      const { token: key } = readTokenFile(join(tokenDir(agentProfiles), 'colly'));
      if (!key) throw new Error('the Colly app key is not stored or is unreadable');
      let r;
      try {
        r = await send(key, query, variables);
      } catch {
        throw new Error('the Colly request did not reach Linear');
      }
      if (r.status >= 400 || r.body?.errors?.length) throw new Error(`Linear refused the Colly request (HTTP ${r.status})`);
      return r.body?.data;
    }
    const used = await token();
    const tried = [used];
    const done = (r) => {
      if (r.status >= 400 || r.body?.errors?.length) throw fail(`Linear answered HTTP ${r.status}: ${r.body?.errors?.[0]?.message ?? 'no data'}`, tried);
      settle();
      return r.body?.data;
    };
    let r = await send(used, query, variables);
    if (!isAuthFailure(r.status, r.body)) return done(r);
    const stored = readStored();
    if (lasts(stored, GRACE_MS) && !tried.includes(stored.token)) {
      tried.push(stored.token);
      r = await send(stored.token, query, variables);
      if (!isAuthFailure(r.status, r.body)) return done(r);
    }
    const fresh = (await mint({ failed: tried })).token;
    tried.push(fresh);
    r = await send(fresh, query, variables);
    if (!isAuthFailure(r.status, r.body)) return done(r);
    throw loud(`Linear fails authentication with a token minted just now (HTTP ${r.status})`, tried);
  }

  const teamOf = (given) => {
    const name = given ?? team;
    if (!parseTeam(name) && !/^[^\s]+ \(via GitHub\)$/.test(name ?? '')) throw fail('a write needs the full team name <repo>-<team> (FACTORY_TEAM, or the team argument)');
    return name;
  };
  const asTeam = (given) => colly ? {} : ({ createAsUser: teamOf(given) });

  /** The app's own user id (the delegate), read once for each token. */
  async function appUserId() {
    appId ??= (await request('query { viewer { id } }'))?.viewer?.id ?? null;
    if (!appId) throw fail('Linear did not name the app\'s user');
    return appId;
  }

  /** `createdAt`, when given, dates the comment (bin/factory-move gives a moved comment its GitHub date). */
  async function commentCreate({ issueId, body, team: given, createdAt }) {
    const input = { issueId, body, ...(createdAt ? { createdAt } : {}), ...asTeam(given) };
    return request('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }', { input });
  }

  /** `delegate: true` sets the app as the new issue's delegate. */
  async function issueCreate({ delegate = false, team: given, ...fields }) {
    const input = { ...fields, ...asTeam(given), ...(delegate ? { delegateId: await appUserId() } : {}) };
    return request('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input });
  }

  return { token, mint, renew, request, commentCreate, issueCreate, appUserId };
}
