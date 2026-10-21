// The tier of a change, from the paths it touches: 3 for a path or a manifest line .gate/protected names, 2 for a
// .gate/load-bearing path or a dependency manifest, 1 otherwise. A policy file or a diff that cannot be read is an
// error (exit 2), never a tier.
//   node tier.mjs --rules <dir> --repo <dir> --base <rev> [--head <rev>] [--labels "tier-2,..."]
// <dir> of --rules holds the policy that decides (CI passes main's checkout); --repo is where the diff is read. The
// labels are every label the pull request ever had: tier-N only raises the result, so a tier never drops within a
// pull request, and needs-human (stuck after three rounds) makes it the Human's, tier 3.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { patternsOf, protectedOf } from './policy.mjs';

const opts = { rules: '.', repo: '.', base: null, head: 'HEAD', labels: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];

const DEPENDENCIES =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.(txt|in)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/;

const git = (args) => execFileSync('git', ['-C', opts.repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

let policy;
let loadBearing;
let paths;
try {
  policy = protectedOf(opts.rules);
  loadBearing = patternsOf(join(opts.rules, '.gate/load-bearing'));
  paths = git(['diff', '--name-only', '--no-renames', opts.base, opts.head]).split('\n').filter(Boolean);
} catch (error) {
  console.log(`tier: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  process.exit(2);
}

let tier = 1;
const why = [];
const raise = (n, reason) => {
  if (n > tier) tier = n;
  if (why.length < 12) why.push(`${n} ${reason}`);
};

/** The first changed line of <path> that a key line of .gate/protected matches, or undefined. */
function keyLine(path) {
  const keys = policy.keys.filter((k) => k.re.test(path));
  if (!keys.length) return undefined;
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', opts.base, opts.head, '--', path]);
  return diff
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    .find((l) => keys.some((k) => k.line.test(l.slice(1))));
}

for (const path of paths) {
  const guarded = policy.paths.find((p) => p.re.test(path));
  if (guarded) {
    raise(3, `${path} (protected: ${guarded.glob})`);
    continue;
  }
  const key = keyLine(path);
  if (key) {
    raise(3, `${path} (protected line: ${key.slice(1).trim().slice(0, 60)})`);
    continue;
  }
  const bearing = loadBearing.find((p) => p.re.test(path));
  if (bearing) raise(2, `${path} (load-bearing: ${bearing.glob})`);
  else if (DEPENDENCIES.test(path)) raise(2, `${path} (dependency manifest)`);
}
for (const label of opts.labels.split(',').map((l) => l.trim())) {
  const m = /^tier-([123])$/.exec(label);
  if (m) raise(Number(m[1]), `label ${label} from an earlier commit`);
  if (label === 'needs-human') raise(3, 'label needs-human: stuck after three rounds, the Human decides');
}
console.log(`tier ${tier}`);
for (const line of why.filter((w) => Number(w[0]) === tier)) console.log(`  ${line.slice(2)}`);
