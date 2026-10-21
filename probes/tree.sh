#!/usr/bin/env bash
# Attack 9: for every merge on scratch main after the ruleset (9dcc0e86), the merged tree is the judged head's tree,
# the head already held main, and the six required checks succeeded on that head.
R=${PROBE_HOME:?set PROBE_HOME}/root/factory-scratch
git -C $R fetch -q origin
for m in $(git -C $R rev-list --first-parent --merges 9dcc0e86..origin/main | tail -r); do
  h=$(git -C $R rev-parse "$m^2"); b=$(git -C $R rev-parse "$m^1")
  same=no; git -C $R diff --quiet "$h" "$m" && same=yes
  held=no; git -C $R merge-base --is-ancestor "$b" "$h" && held=yes
  green=$(gh api "repos/tuannd9288/factory-scratch/commits/$h/check-runs?per_page=100" --jq '[.check_runs[] | select(.app.slug=="github-actions" and (.name|IN("verify","rules","red-check","verify-trusted","review","verdict")) and .conclusion=="success") | .name] | unique | length')
  printf '%s %s tree=%s held-main=%s required-green=%s/6 %s\n' "${m:0:8}" "${h:0:8}" "$same" "$held" "$green" "$(git -C $R log -1 --format=%s "$m")"
done
