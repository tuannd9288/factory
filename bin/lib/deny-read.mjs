// The paths no agent may read (INN-39 item 2): one list, rendered for each harness that runs here, so a new harness renders it rather than
// copying it. It imports nothing, so every launcher can read it.
//   Who renders it: the seats (bin/lib/seat.mjs: their command sandbox and their Read rules), the pack Lead (packs/pstack/bin/lead.mjs), the
//   MacBook Lead and Colly (bin/lib/factory.mjs), `factory codex` (packs/pstack/bin/codex-step.mjs), and kit/.claude/settings.json.
//   The kit's file is a rendering, not a copy: Claude Code in a served repository reads that file, which has no bin/lib, and onboard and
//   kit-update insert its lines as they are. test/deny-read.test.mjs fails when its bytes differ from `node bin/lib/deny-read.mjs kit`.
//   An entry is a path under home, under the work folder (`base: 'work'`), or under the profiles folder (`base: 'profiles'`: under
//   ~/.agent-profiles and, when a launcher gives it, under the profiles folder by its absolute path).
//   Applicability is explicit: each entry names a scope, and a scope names the channels that deny it, the roles when not every role, and
//   why. Each difference between harnesses is a named scope, never an exception. A channel is a harness and the way it reads:
//     file    Claude Code's file tools (Read rules) in the factory's own sessions: every seat role, both Leads, Colly
//     kit     Claude Code's file tools in a served repository's sessions (kit/.claude/settings.json), which Claude Code also merges into the
//             sandbox of a session there
//     shell   Claude Code's command sandbox (sandbox.filesystem.denyRead) of the seats, the MacBook Lead and Colly
//     codex   Codex's permission profile, which binds its commands, its only way to read
//   Residual gaps the list does not close: the Read rules bind Claude Code's file tools, so the pack Lead's shell, which runs in no
//   sandbox, and a hook, an MCP server or the status line of any session read what the user can read; `factory codex`, where a seat is
//   granted it, runs Codex outside Claude's sandbox, bounded by this list through another enforcer. A command a sandbox excludes
//   (sandbox.excludedCommands) runs with no filesystem restriction, so an exclusion is a gap until a probe shows it bounded (the excluded
//   command chained with a read of a synthetic denied file, which must be refused); naming a factory command does not bound it, since every
//   verb and every program a verb runs would read what the user reads. The seats exclude none and set allowUnsandboxedCommands false (their
//   sandbox object is pinned whole in test/seat-sandbox.test.mjs), but a work folder's own .claude/settings.json is a settings layer too.
//   Open gaps of the MacBook Lead's and Colly's sandboxes (bin/lib/factory.mjs), each until its probe shows it bounded:
//     `factory *` (both): every verb runs with full access, Colly's Monitors (`factory events`) among them; the permission rules
//       (tokenStoreDeny and Colly's denies) are the only guard left on the verbs that touch the token store, and `factory gh`, with the
//       agents' GitHub token in this node's store, sends a local file it is given.
//     `<bin/seat> *` (the MacBook Lead as the agents' user): bin/seat reads the tokens by design, and it takes any file as the brief, so a
//       brief outside the work and run folders reaches the model; the probe is a seat started on a synthetic denied file.
//   Not here: commands (`Bash(...)` rules, bin/lib/seat.mjs); the gate's reviewer on CI, which denies the runner's system folders
//   (kit/.gate/bin/lib/claude-reviewer.mjs).
export const SCOPES = {
  all: { channels: ['file', 'kit', 'shell', 'codex'], why: 'a credential or a login: no channel reads it' },
  'file-tools': { channels: ['file', 'kit'], why: 'named beside the whole profiles folder (#178), which every sandbox denies whole' },
  'not-the-shell': { channels: ['file', 'kit', 'codex'], why: "a repository's tests may load its .env files in a seat's shell" },
  'factory-file-tools': {
    channels: ['file'],
    why: "all of ~/.config for the factory's own file tools, as before; a sandbox, which the kit's rules reach too, would stop git, which reads ~/.config/git, so the shells, Codex and the kit name each store instead (INN-39, his question 1)",
  },
  'seats-only': { channels: ['file'], roles: ['seat'], why: "a Lead's transcript copies are its own (#185)" },
};

export const DENIED = [
  { path: '.env*', base: 'work', scope: 'not-the-shell', why: "a repository's own secrets" },
  // The kit denies it whole too: INN-39, his question 2.
  { path: '.agent-profiles', scope: 'all', why: 'the token store, the archive and every profile' },
  { path: 'tokens', base: 'profiles', scope: 'file-tools', why: "the teams' tokens and the agents' GitHub token" },
  { path: 'archive', base: 'profiles', scope: 'file-tools', why: 'the tokens moved aside at logout' },
  { path: 'seats/1/oauth-token', base: 'profiles', scope: 'file-tools', why: "seat 1's old token file" },
  { path: '.claude', scope: 'all', why: "Claude Code's own folder and its login" },
  { path: '.claude*', scope: 'all', why: '~/.claude.json and other Claude homes, such as ~/.claude-acc<N> and ~/.claude-profiles' },
  { path: '.codex', scope: 'all', why: "Codex's own folder and its login" },
  { path: '.codex*', scope: 'all', why: 'other Codex homes' },
  { path: '.config/gh', scope: 'all', why: "gh's login" },
  // Nothing in the factory reads it; piggery's own pig-credit runs outside any factory session.
  { path: '.config/claude-credit', scope: 'all', why: 'the Team API key file on the MacBook (anthropic.env)' },
  { path: '.ssh', scope: 'all', why: 'ssh keys' },
  { path: '.local/share/claude', scope: 'all', why: "Claude Code's data" },
  { path: '.cursor', scope: 'all', why: "Cursor's login" },
  { path: '.config', scope: 'factory-file-tools', why: "every tool's settings and logins" },
  { path: 'factory-runs/*/transcripts', scope: 'seats-only', why: "the copies of a Lead's transcripts" },
];

/** Whether `channel` denies `entry` for `role` (a role matters only to a scope that names its roles). */
export const deniedBy = (entry, channel, role = null) => {
  const scope = SCOPES[entry.scope];
  return scope.channels.includes(channel) && (!scope.roles || scope.roles.includes(role));
};

const baseOf = (e) => e.base ?? 'home';
const both = (p) => [`Read(${p})`, `Read(${p}/**)`];

/** Claude Code's Read rules of `channel` (`file`, or `kit`) for `role` (`seat`, `lead` or `colly`): a home entry as itself, which names a
 * file such as ~/.claude.json, and with /**, which names what a folder holds; a work entry as ./<path>; a profiles entry under
 * ~/.agent-profiles. With `profiles`, the profiles folder by its absolute path too, whole and with its entries, for one outside home. */
export const readRules = ({ channel = 'file', role = null, profiles = null } = {}) => [
  ...DENIED.filter((e) => deniedBy(e, channel, role)).flatMap((e) => ({
    work: () => [`Read(./${e.path})`],
    home: () => both(`~/${e.path}`),
    profiles: () => [...both(`~/.agent-profiles/${e.path}`), ...(profiles ? both(`/${profiles}/${e.path}`) : [])],
  })[baseOf(e)]()),
  ...(profiles ? [`Read(/${profiles}/**)`] : []),
];

const homeOf = (channel) => DENIED.filter((e) => baseOf(e) === 'home' && deniedBy(e, channel)).map((e) => e.path);

/** The absolute paths the seats' command sandbox denies: the home entries of the shell, and the profiles folder. */
export const sandboxPaths = (home, profiles = null) => [...new Set([...homeOf('shell').map((p) => `${home}/${p}`), ...(profiles ? [profiles] : [])])];

/** Codex's deny paths: its home entries and the profiles folder, a glob twice, as itself and with /**, since Codex's `*` stops at one path
 * part; a work entry anywhere on the disk, since Codex reads every folder. */
export const codexPaths = (home, profiles) => [
  ...[...new Set([...homeOf('codex').map((p) => `${home}/${p}`), profiles])].flatMap((p) => (p.includes('*') ? [p, `${p}/**`] : [p])),
  ...DENIED.filter((e) => baseOf(e) === 'work' && deniedBy(e, 'codex')).map((e) => `/**/${e.path}`),
];

/** kit/.claude/settings.json's text: the kit's Read rules alone, two spaces, a final newline. */
export const kitSettings = () => `${JSON.stringify({ permissions: { deny: readRules({ channel: 'kit' }) } }, null, 2)}\n`;

if (process.argv[1]?.endsWith('/deny-read.mjs') && process.argv[2] === 'kit') process.stdout.write(kitSettings());
