# Probe helpers for the scratch repository PROBE_REPO (owner/name): each probe is a branch in its own worktree off
# origin/main, committed without the local hooks (the gate in CI is what is measured), pushed, and opened as a pull
# request. PROBE_HOME holds a clone of it at root/<name>, and the worktrees. Every body says "Team: probe" and
# "Issue: none": the kit's verify reads Team:, its tier reads Issue:, and a probe works on no issue, so takes no claim.
REPO=${PROBE_REPO:?set PROBE_REPO to the scratch repository, owner/name}
SP=${PROBE_HOME:?set PROBE_HOME to a folder holding a clone of $REPO at root/${REPO#*/}}
R=$SP/root/${REPO#*/}
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
probe_start() { # name
  git -C "$R" fetch -q origin main
  git -C "$R" worktree add -q -B "$1" "$SP/wt/$1" origin/main >/dev/null 2>&1 || return 1
  cd "$SP/wt/$1"
}
probe_commit() { # message [trailer]
  git add -A && git commit -q -m "$1" ${2:+-m "$2"}
}
probe_open() { # name title body
  git push -q -u origin "$1" >/dev/null 2>&1 || { echo "push failed: $1"; return 1; }
  gh pr create --repo "$REPO" --head "$1" --title "$2" --body "$3

Team: probe
Issue: none

🤖 Generated with [Claude Code](https://claude.com/claude-code)" 2>&1 | tail -1
}
