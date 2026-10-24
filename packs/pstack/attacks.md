### Attack 23: two pstack pins in one profile

A scratch config directory holds the plugin registry and is never logged in; whether `claude plugin` needs a login
there is untested, and if it asks, the Human runs the two installs. A is the pin, f713f14 (0.15.25); B is 1e5c90a
(0.15.24), whose `pstack/` differs in 15 files.

```
T=$(mktemp -d); C=$T/cfg; mkdir -p "$C"
A=f713f14203cd6420cec13cd7c55c32d598dbab68; B=1e5c90a4b6f249917bd21fe361b3a2a7deb741b8
for r in a b; do git init -q "$T/$r" && mkdir "$T/$r/.claude"; done
# $T/a/.claude/settings.json pins A, $T/b/.claude/settings.json pins B:
#   {"extraKnownMarketplaces":{"<name>":{"source":{"source":"settings","name":"<name>","plugins":[{"name":"pstack",
#     "source":{"source":"git-subdir","url":"cursor/plugins","path":"pstack","sha":"<A or B>"}}]}}},
#    "enabledPlugins":{"pstack@<name>":true}}
# case 1: <name> is pstack-pin in both; case 2: pstack-f713f14 in a, pstack-1e5c90a in b.
(cd "$T/a" && CLAUDE_CONFIG_DIR=$C claude plugin install "pstack@<name of a>" --scope project)
(cd "$T/b" && CLAUDE_CONFIG_DIR=$C claude plugin install "pstack@<name of b>" --scope project)
for r in a b a; do (cd "$T/$r" && CLAUDE_CONFIG_DIR=$C claude plugin list --json); done
jq . "$C/plugins/installed_plugins.json" "$C/plugins/known_marketplaces.json"
ls "$C"/plugins/cache/*/pstack/; find "$C/plugins/cache" -name .orphaned_at
git -C "$T/a" status --porcelain; git -C "$T/b" status --porcelain
```

Then the session half, on the writer profile with the scratch registry: the Human opens `claude` once in `$T/a` and
`$T/b` on the writer profile and accepts the trust dialog, then

```
for r in a b; do (cd "$T/$r" && CLAUDE_CONFIG_DIR=<writer profile> CLAUDE_CODE_PLUGIN_CACHE_DIR=$C/plugins \
  claude -p --max-turns 1 --output-format stream-json --verbose "reply ok" \
  | jq -c 'select(.type=="system" and .subtype=="init") | .plugins'); done
```

A case passes when each repository lists and loads the pstack built from its own commit (the `init` event's
`plugins[].path`), both cache directories exist with no `.orphaned_at`, `known_marketplaces.json` is the same after
the third listing as after the second, and both `git status` are empty: an install that rewrites
`.claude/settings.json` is a tier-3 change each time, and `--scope local` writes the untracked
`.claude/settings.local.json` instead. If the listing shows pstack and the session does not, it does not load under
`-p`, which decides unattended runs.
