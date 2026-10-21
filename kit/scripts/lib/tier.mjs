// The tier of a change, from the paths it touches: 3 for a path CODEOWNERS lists, 2 for a .gate/load-bearing path or a
// dependency manifest, 1 otherwise. A diff that cannot be read is tier 2.
//   node tier.mjs --rules <dir> --repo <dir> --base <rev> [--head <rev>] [--labels "tier-2,..."]
// <dir> of --rules holds the CODEOWNERS and .gate/load-bearing that decide (CI passes main's checkout); --repo is where
// the diff is read. A label tier-N only raises the result, so a tier never drops within a pull request.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const opts = { rules: '.', repo: '.', base: null, head: 'HEAD', labels: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];

const DEPENDENCIES =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.(txt|in)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/;

/** A gitignore-style pattern as a regex over repository paths. */
function globToRegex(glob) {
  let g = glob.trim();
  const anchored = g.startsWith('/') || g.replace(/\/$/, '').includes('/');
  g = g.replace(/^\//, '');
  const dir = g.endsWith('/');
  g = g.replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '(^|/)'}${re}${dir ? '/' : '(/|$)'}`);
}

function patternsOf(file, ownersOnly) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
    .filter((parts) => !ownersOnly || parts.length > 1)
    .map((parts) => ({ glob: parts[0], re: globToRegex(parts[0]) }));
}

const owned = patternsOf(join(opts.rules, '.github/CODEOWNERS'), true);
const loadBearing = patternsOf(join(opts.rules, '.gate/load-bearing'), false);

let tier = 1;
const why = [];
const raise = (n, reason) => {
  if (n > tier) tier = n;
  if (why.length < 12) why.push(`${n} ${reason}`);
};

let paths = [];
try {
  paths = execFileSync('git', ['-C', opts.repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', opts.base, opts.head], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .filter(Boolean);
} catch (error) {
  raise(2, `the diff could not be read: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
}
for (const path of paths) {
  const owner = owned.find((p) => p.re.test(path));
  if (owner) {
    raise(3, `${path} (CODEOWNERS: ${owner.glob})`);
    continue;
  }
  const bearing = loadBearing.find((p) => p.re.test(path));
  if (bearing) raise(2, `${path} (load-bearing: ${bearing.glob})`);
  else if (DEPENDENCIES.test(path)) raise(2, `${path} (dependency manifest)`);
}
for (const label of opts.labels.split(',')) {
  const m = /^tier-([123])$/.exec(label.trim());
  if (m) raise(Number(m[1]), `label ${label.trim()} from an earlier commit`);
}
console.log(`tier ${tier}`);
for (const line of why.filter((w) => Number(w[0]) === tier)) console.log(`  ${line.slice(2)}`);
