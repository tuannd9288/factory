#!/usr/bin/env bash
# Builds each probe in a throwaway worktree without pushing. For C*: runs verify and red-check as the agent would.
source "$(dirname "$0")/drive.sh"
source "$(dirname "$0")/probes.sh"
for id in "$@"; do
  branch="dry/$(echo "$id" | tr 'A-Z' 'a-z')"
  ( probe_start "$branch" || { echo "$id: start failed"; exit 1; }
    T="" B=""
    "p_$id" >/dev/null 2>&1 || { echo "$id: BUILD FAILED"; exit 1; }
    case $id in
      C*) printf '%s\n' "$B" > "$SP/body-$id.txt"
          v=$(env -u GIT_CONFIG_COUNT scripts/verify 2>&1 | tail -1); r=$(env -u GIT_CONFIG_COUNT scripts/red-check --base origin/main --body "$SP/body-$id.txt" 2>&1 | head -1)
          t=$(env -u GIT_CONFIG_COUNT scripts/tier --base origin/main | head -1)
          echo "$id: $t | $v | $r" ;;
      *) echo "$id: built" ;;
    esac )
  git -C "$R" worktree remove --force "$SP/wt/$branch" 2>/dev/null; git -C "$R" branch -q -D "$branch" 2>/dev/null
done
