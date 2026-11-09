# Sourced by the bin wrappers that a non-login ssh command or a launchd job starts with a PATH that may not hold node, pi or codex
# (FAC-85, fix 10): the places Homebrew puts them are added, and a wrapper with no node stops here. bin/factory-queue, bin/factory-ledger
# and bin/factory-daemon do not source it: launchd starts the first two, and the queue the daemon, with the job's PATH, which holds gh's
# and node's folders; their `plist` says so when gh is not on the PATH it was given, and the Watcher pass the daemon starts keeps the
# PATH it has under the Watcher's freeze (docs/decisions.md).
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
command -v node >/dev/null 2>&1 || { echo "$(basename "$0"): node is not on PATH ($PATH)" >&2; exit 127; }
