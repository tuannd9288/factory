#!/usr/bin/env bash
# Makes the small Node repository the pack probe's scratch repository starts from: a function, its test, one commit on
# main. The Human puts it on GitHub (the steps in the hand-back of issue 6; probes/pack-contract.md is now the canary's oracle, not this probe's).
#   probes/pack-seed.sh <new folder>
set -euo pipefail
dir=${1:?usage: probes/pack-seed.sh <new folder>}
[ -e "$dir" ] && { echo "pack-seed: $dir exists; nothing done"; exit 1; }
mkdir -p "$dir/src" "$dir/test"
cd "$dir"
git init -q -b main
printf '{ "name": "pack-scratch", "private": true, "type": "module" }\n' >package.json
printf '# pack-scratch\n\nA scratch repository for the factory'"'"'s pack conformance probe.\n' >README.md
printf 'export function add(a, b) {\n  return a + b;\n}\n' >src/math.js
printf "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\n\ntest('adds', () => {\n  assert.equal(add(2, 3), 5);\n});\n" >test/math.test.js
git add -A
git commit -q -m "Start the pack scratch repository"
echo "pack-seed: $dir is ready: gh repo create <owner>/<name> --private --source $dir --push"
