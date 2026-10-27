#!/usr/bin/env bash
# Attack 9: for every merge on the scratch repository's main after <since> (the commit the ruleset was imported on;
# 9dcc0e86 in the first run), the merged tree is the judged head's tree, the head already held main, and every check
# the kit's ruleset requires succeeded on that head.   PROBE_REPO=owner/name PROBE_HOME=... tree.sh <since>
REPO=${PROBE_REPO:?set PROBE_REPO to the scratch repository, owner/name}
R=${PROBE_HOME:?set PROBE_HOME}/root/${REPO#*/}
since=${1:?usage: tree.sh <commit the ruleset was imported on>}
kit=$(dirname "$0")/../kit
names=$(node "$kit/.gate/bin/lib/policy.mjs" checks --rules "$kit" | jq -Rnc '[inputs]') || exit 2
need=$(echo "$names" | jq length)
git -C "$R" fetch -q origin
for m in $(git -C "$R" rev-list --first-parent --merges "$since"..origin/main | tail -r); do
  h=$(git -C "$R" rev-parse "$m^2"); b=$(git -C "$R" rev-parse "$m^1")
  same=no; git -C "$R" diff --quiet "$h" "$m" && same=yes
  held=no; git -C "$R" merge-base --is-ancestor "$b" "$h" && held=yes
  green=$(gh api "repos/$REPO/commits/$h/check-runs?per_page=100" --jq "[.check_runs[] | select(.app.slug==\"github-actions\" and (.name|IN($names[])) and .conclusion==\"success\") | .name] | unique | length")
  printf '%s %s tree=%s held-main=%s required-green=%s/%s %s\n' "${m:0:8}" "${h:0:8}" "$same" "$held" "$green" "$need" "$(git -C "$R" log -1 --format=%s "$m")"
done
