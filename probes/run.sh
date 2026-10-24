#!/usr/bin/env bash
# Opens the probes of plan.md as pull requests on the scratch repository PROBE_REPO, each from the then-current
# origin/main, with auto-merge on. Usage: run.sh C1 C2 D5 ...   Appends "id<TAB>number<TAB>branch" to prs.tsv.
# PROBE_ROUND=N opens each as probe/<id>-rN, beside the pull request of an earlier round, which keeps its branch.
source "$(dirname "$0")/drive.sh"
source "$(dirname "$0")/probes.sh"
OUT=$SP/prs.tsv

for id in "$@"; do
  branch="probe/$(echo "$id" | tr 'A-Z' 'a-z')${PROBE_ROUND:+-r$PROBE_ROUND}"
  ( probe_start "$branch" || { echo "start failed: $id"; exit 1; }
    T="" B=""
    "p_$id" || { echo "build failed: $id"; exit 1; }
    url=$(probe_open "$branch" "$T" "$B") || exit 1
    gh pr merge "$branch" --repo "$REPO" --auto --merge >/dev/null 2>&1 || echo "auto-merge not set: $id"
    printf '%s\t%s\t%s\n' "$id" "${url##*/}" "$branch" >> "$OUT"
    echo "$id ${url##*/}" )
done
