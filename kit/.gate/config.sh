# The repository's gate settings, sourced by scripts/verify, scripts/red-check and scripts/prove-check.
# The kit ships defaults for a Node repository that tests with node --test; a repository changes them when it joins.

# Runs the named test files, or every test when none is named, and writes JUnit XML to "$GATE_REPORT".
# NODE_TEST_CONTEXT is dropped so a run started from inside another node --test still writes its own report.
gate_tests() {
  env -u NODE_TEST_CONTEXT node --test --test-reporter=junit --test-reporter-destination="$GATE_REPORT" "$@"
}

# The fast checks of the pre-commit hook (lint, format, types), given the staged files. "Could not run" is a failure.
gate_fast() {
  :
}

# Makes a checkout ready to run tests: dependencies, generated files. Runs in CI before verify, and in red-check's
# copy of the base before its tests. The argument is the checkout's directory.
gate_prepare() {
  :
}

# The repository's own checks, each a function check_<name> in this file that fails on a problem, with a fixture
# .gate/proofs/<name>.patch that makes it fail. Space-separated names.
GATE_CHECKS=""

# Paths whose change is a source change, for red-check; tests are told apart by .gate/handin.json's "tests" patterns.
GATE_SOURCE='\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|scala|php|swift|cs|c|cc|cpp|h|hpp|sh)$'
export GATE_SOURCE
