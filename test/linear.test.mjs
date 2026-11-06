// bin/lib/linear.mjs (#403): the factory's one way to reach Linear as the "Factory" app. No network: `fetchFn` is a fake Linear. Every id,
// secret and token below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActive, readLines, record } from '../bin/lib/events.mjs';
import { accountList, accountRefusal, tokenAccounts, tokenDir } from '../bin/lib/token.mjs';

const lib = () => import('../bin/lib/linear.mjs');
const SECRET = 'invented-client-secret-0001';
const DAY = 86_400_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linear-'));
  const agentProfiles = join(root, 'profiles');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  return { root, agentProfiles, state };
}

async function configure(f) {
  const { writeAppFile } = await import('../bin/lib/token.mjs');
  writeAppFile(f.agentProfiles, 'linear-app', 'client-id', 'invented-client-id-0001');
  writeAppFile(f.agentProfiles, 'linear-app', 'client-secret', SECRET);
}

const json = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });

/** A fake Linear: the token endpoint mints lin_1, lin_2, ...; a new mint ends every earlier token (the real finding of 2026-11-04). */
function fakeLinear({ expiresIn = 30 * DAY / 1000, mintStatus = 200, echoSecret = false, deadMints = false } = {}) {
  const s = { minted: 0, valid: new Set(), calls: [], mints: [], appId: 'app-user-1', onCall: null };
  s.fetchFn = async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(init.body);
      s.mints.push(Object.fromEntries(form));
      if (mintStatus !== 200) return json(mintStatus, { error: echoSecret ? `bad secret ${form.get('client_secret')}` : 'invalid_client' });
      s.minted += 1;
      s.valid = deadMints ? new Set() : new Set([`lin_${s.minted}`]);
      return json(200, { access_token: `lin_${s.minted}`, token_type: 'Bearer', expires_in: expiresIn, scope: form.get('scope') });
    }
    const token = init.headers.authorization.replace('Bearer ', '');
    const body = JSON.parse(init.body);
    s.calls.push({ token, ...body });
    s.onCall?.(token);
    if (!s.valid.has(token)) {
      return echoSecret
        ? json(400, { errors: [{ message: `You need to authenticate (${token})`, extensions: { code: 'AUTHENTICATION_ERROR' } }] })
        : json(401, { errors: [{ message: 'You need to authenticate', extensions: { code: 'AUTHENTICATION_ERROR' } }] });
    }
    if (body.query.includes('viewer')) return json(200, { data: { viewer: { id: s.appId } } });
    return json(200, { data: { ok: true } });
  };
  return s;
}

const make = async (f, linear, extra = {}) => {
  const { createLinear } = await lib();
  const raised = [];
  const api = createLinear({ ...f, fetchFn: (...a) => linear.fetchFn(...a), raise: (reason) => raised.push(reason), team: 'factory-otter', ...extra });
  return { api, raised };
};

test('mint asks for the one fixed set of scopes, stores the token with its expiry in the token store, mode 600, and prints nothing', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear);
  const { SCOPES } = await lib();
  const token = await api.token();
  assert.equal(token, 'lin_1');
  assert.equal(linear.mints.length, 1);
  assert.equal(linear.mints[0].grant_type, 'client_credentials');
  assert.equal(linear.mints[0].scope, SCOPES.join(','));
  const file = join(tokenDir(f.agentProfiles), 'linear-app', 'access.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.token, 'lin_1');
  assert.ok(stored.expiresAt > Date.now() + 29 * DAY);
});

test('two callers with an empty store mint once and use the same token (the lock, and the re-read after it)', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const a = (await make(f, linear)).api;
  const b = (await make(f, linear)).api;
  const [x, y] = await Promise.all([a.token(), b.token()]);
  assert.equal(linear.minted, 1);
  assert.equal(x, y);
  assert.equal(await a.token(), 'lin_1');
  assert.equal(linear.minted, 1);
  assert.ok(!existsSync(join(tokenDir(f.agentProfiles), 'linear-app', 'mint.lock')));
});

test('without the app\'s credentials nothing is minted, the caller gets a plain error and no condition is raised', async () => {
  const f = fixture();
  const linear = fakeLinear();
  const { api, raised } = await make(f, linear);
  await assert.rejects(() => api.token(), /not configured/);
  assert.equal(await api.renew(), 'unconfigured');
  assert.equal(linear.mints.length, 0);
  assert.deepEqual(raised, []);
});

test('renew mints ahead of the end (7 days), not before, and every caller then reads the new token', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const t0 = Date.now();
  const early = (await make(f, linear, { now: () => t0 })).api;
  await early.token();
  assert.equal(await early.renew(), 'kept');
  const later = (await make(f, linear, { now: () => t0 + 22 * DAY })).api;
  assert.equal(await later.renew(), 'kept');
  const due = (await make(f, linear, { now: () => t0 + 23 * DAY + 1 })).api;
  assert.equal(await due.renew(), 'renewed');
  assert.equal(linear.minted, 2);
  const other = (await make(f, linear, { now: () => t0 + 22 * DAY })).api;
  assert.equal(await other.token(), 'lin_2');
});

test('a token past its end is minted anew when a caller asks', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const t0 = Date.now();
  await (await make(f, linear, { now: () => t0 })).api.token();
  const { api } = await make(f, linear, { now: () => t0 + 31 * DAY });
  assert.equal(await api.token(), 'lin_2');
});

test('an authentication failure with the same stored token: one mint under the lock, one retry', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api, raised } = await make(f, linear);
  await api.token(); // lin_1
  linear.valid = new Set(); // Colly minted from the same app: lin_1 is dead, and the store still holds it
  const r = await api.request('query { x }');
  assert.deepEqual(r, { ok: true });
  assert.equal(linear.minted, 2);
  assert.equal(linear.calls.filter((c) => c.token === 'lin_1').length, 1);
  assert.equal(linear.calls.filter((c) => c.token === 'lin_2').length, 1);
  assert.deepEqual(raised, []);
});

test('an authentication failure: the caller re-reads the store and retries with the token another caller stored there, with no mint', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear);
  await api.token(); // lin_1 stored
  const { writeAppFile } = await import('../bin/lib/token.mjs');
  // while the request with lin_1 is out, another process mints lin_2 and stores it
  linear.onCall = (token) => {
    if (token !== 'lin_1') return;
    linear.onCall = null;
    linear.valid = new Set(['lin_2']);
    writeAppFile(f.agentProfiles, 'linear-app', 'access.json', `${JSON.stringify({ token: 'lin_2', expiresAt: Date.now() + 30 * DAY })}\n`);
  };
  assert.deepEqual(await api.request('query { x }'), { ok: true });
  assert.equal(linear.mints.length, 1);
  assert.deepEqual(linear.calls.map((c) => c.token), ['lin_1', 'lin_2']);
});

test('a 4002-style failure that a mint does not mend stops loudly: one mint, two requests, one condition raised, an error thrown', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear({ deadMints: true });
  const { api, raised } = await make(f, linear);
  await assert.rejects(() => api.request('query { x }'), /authenticat/i);
  // the first call mints (nothing stored), the request fails, the stored token is the same, one mint, one retry
  assert.equal(linear.mints.length, 2);
  assert.equal(linear.calls.length, 2);
  assert.equal(raised.length, 1);
  await assert.rejects(() => api.request('query { x }'), /authenticat/i);
  assert.ok(linear.calls.length <= 4);
  assert.ok(linear.mints.length <= 4);
});

test('a refused mint is a loud stop too, and the error holds no secret or token', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear({ mintStatus: 401, echoSecret: true });
  const { api, raised } = await make(f, linear);
  let message = '';
  await api.token().catch((e) => { message = e.message; });
  assert.ok(message.length > 0);
  assert.ok(!message.includes(SECRET));
  assert.equal(raised.length, 1);
  assert.ok(!raised[0].includes(SECRET));
});

test('a non-auth error whose text holds the token sent and the client secret is scrubbed from the message and the events', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api, raised } = await make(f, linear);
  const good = linear.fetchFn;
  linear.fetchFn = async (url, init) => (url.endsWith('/oauth/token')
    ? good(url, init)
    : json(200, { errors: [{ message: `bad input for ${init.headers.authorization.replace('Bearer ', '')} and ${SECRET} and lin_oauth_abcdefghijklmnop12` }] }));
  let message = '';
  await api.request('query { x }').catch((e) => { message = e.message; });
  assert.match(message, /Linear answered HTTP 200/);
  for (const s of ['lin_1', SECRET, 'lin_oauth_abcdefghijklmnop12']) assert.ok(!message.includes(s));
  const events = existsSync(join(f.state, 'events.jsonl')) ? readFileSync(join(f.state, 'events.jsonl'), 'utf8') : '';
  for (const s of ['lin_1', SECRET]) assert.ok(!events.includes(s));
  assert.deepEqual(raised, []);
});

test('any success clears the raised condition, a first-send success included, and writes a line only when it was raised', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { createLinear } = await lib();
  const api = createLinear({ ...f, fetchFn: linear.fetchFn, team: 'factory-otter' });
  await api.token();
  record({ state: f.state, found: [{ key: 'linear-auth-failed', scope: 'linear', top: true, text: 'raised' }], read: new Set() });
  assert.ok(readActive(f.state).conditions['linear-auth-failed']);
  await api.request('query { x }');
  assert.equal(linear.calls.length, 1); // no retry was needed
  assert.equal(readActive(f.state).conditions['linear-auth-failed'], undefined);
  assert.equal(readLines(f.state).filter((e) => e.type === 'clear').length, 1);
  await api.request('query { x }');
  assert.equal(readLines(f.state).length, 2); // the start and the clear, nothing from the second success
});

test('a symlinked app folder is refused: nothing is written through it, read from it or locked in it', async () => {
  const f = fixture();
  const away = join(f.root, 'away');
  mkdirSync(away);
  mkdirSync(tokenDir(f.agentProfiles), { recursive: true });
  symlinkSync(away, join(tokenDir(f.agentProfiles), 'linear-app'));
  const { writeAppFile } = await import('../bin/lib/token.mjs');
  assert.throws(() => writeAppFile(f.agentProfiles, 'linear-app', 'client-secret', SECRET), /symlink/);
  assert.deepEqual(readdirSync(away), []);
  writeFileSync(join(away, 'client-id'), 'invented-client-id-0001\n');
  writeFileSync(join(away, 'client-secret'), `${SECRET}\n`);
  const linear = fakeLinear();
  const { api } = await make(f, linear);
  await assert.rejects(() => api.token(), /symlink/);
  assert.equal(await api.renew().catch((e) => e.message.includes('symlink')), true);
  assert.equal(linear.mints.length, 0);
  assert.deepEqual(readdirSync(away).sort(), ['client-id', 'client-secret']);
});

test('commentCreate passes the team as createAsUser and no icon until one is hosted', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear);
  await api.commentCreate({ issueId: 'issue-1', body: 'hello' });
  const call = linear.calls.at(-1);
  assert.ok(call.query.includes('commentCreate'));
  assert.deepEqual(call.variables.input, { issueId: 'issue-1', body: 'hello', createAsUser: 'factory-otter' });
  await api.commentCreate({ issueId: 'issue-1', body: 'other', team: 'factory-pudding' });
  assert.equal(linear.calls.at(-1).variables.input.createAsUser, 'factory-pudding');
});

test('with an icon url set, writes carry displayIconUrl', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear, { iconUrl: 'https://example.invalid/factory.png' });
  await api.commentCreate({ issueId: 'issue-1', body: 'hello' });
  assert.equal(linear.calls.at(-1).variables.input.displayIconUrl, 'https://example.invalid/factory.png');
});

test('issueCreate carries createAsUser and the app as delegate; a write with no team name is refused', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear);
  await api.issueCreate({ teamId: 'team-1', title: 'T', stateId: 'state-1', delegate: true });
  const create = linear.calls.at(-1);
  assert.ok(create.query.includes('issueCreate'));
  assert.deepEqual(create.variables.input, { teamId: 'team-1', title: 'T', stateId: 'state-1', createAsUser: 'factory-otter', delegateId: 'app-user-1' });
  const none = (await make(f, linear, { team: '' })).api;
  await assert.rejects(() => none.commentCreate({ issueId: 'issue-1', body: 'x' }), /team/);
});

test('delegateToApp sets the app as the delegate of an issue a Lead holds', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear);
  await api.delegateToApp('issue-1');
  const call = linear.calls.at(-1);
  assert.ok(call.query.includes('issueUpdate'));
  assert.deepEqual(call.variables, { id: 'issue-1', input: { delegateId: 'app-user-1' } });
});

test('the default raise writes a start line and a top condition to the events, and a mend clears it', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear({ mintStatus: 401 });
  const { createLinear } = await lib();
  const api = createLinear({ ...f, fetchFn: linear.fetchFn, team: 'factory-otter' });
  await assert.rejects(() => api.token());
  const starts = readLines(f.state).filter((e) => e.type === 'start' && e.kind === 'linear-auth-failed');
  assert.equal(starts.length, 1);
  assert.ok(readActive(f.state).conditions['linear-auth-failed'].top);
  await assert.rejects(() => api.token());
  assert.equal(readLines(f.state).filter((e) => e.type === 'start').length, 1); // a condition that holds writes nothing more
  const good = createLinear({ ...f, fetchFn: fakeLinear().fetchFn, team: 'factory-otter' });
  await good.token();
  assert.equal(readActive(f.state).conditions['linear-auth-failed'], undefined);
  assert.equal(readLines(f.state).filter((e) => e.type === 'clear').length, 1);
});

test('the app\'s folder is no Claude account: tokenAccounts and accountList skip it, and the name is refused as an account', async () => {
  const f = fixture();
  await configure(f);
  const { writeToken } = await import('../bin/lib/token.mjs');
  writeToken(f.agentProfiles, 'real-account', 'sk-ant-invented');
  assert.deepEqual(tokenAccounts(f.agentProfiles), ['real-account']);
  assert.deepEqual(accountList(f).map((a) => a.name), ['real-account']);
  assert.notEqual(accountRefusal('linear-app'), null);
  assert.deepEqual(readdirSync(tokenDir(f.agentProfiles)).sort(), ['.real-account.added', 'linear-app', 'real-account']);
});

test('a bare team name is refused before a Linear request', async () => {
  const f = fixture();
  await configure(f);
  const linear = fakeLinear();
  const { api } = await make(f, linear, { team: 'lead' });
  await assert.rejects(api.commentCreate({ issueId: 'issue-1', body: 'hello' }), /full team name/);
  await assert.rejects(api.issueCreate({ teamId: 'team-1', title: 'T', team: 'lead' }), /full team name/);
  assert.equal(linear.calls.length, 0);
  assert.equal(linear.mints.length, 0);
});
