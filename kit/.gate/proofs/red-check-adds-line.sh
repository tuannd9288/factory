# Proof for red-check: a deletion that also adds a line, so it is not a pure deletion.
# Run: PATH="$PWD/.gate-proof-bin:$PATH" scripts/red-check --base HEAD~1
# Says: check 1: gate-proof/lib\.js adds a source line
# A fake npx stands in for knip, so the proof reaches no network; it prints the report knip 6.42.1 would, as JSON.
# The paths are built from parts: a tracked file that names a path is what check 2 looks for, and this file is tracked.
d=gate-proof n=lib
mkdir -p $d .gate-proof-bin
printf '#!/bin/sh\ncat <<'"'"'JSON'"'"'\n%s\nJSON\nexit 1\n' "$(printf '{"issues":[{"file":"%s/%s.js","files":[],"exports":[{"name":"dropped","line":2,"col":14,"pos":40}],"types":[]}]}' "$d" "$n")" >.gate-proof-bin/npx
chmod +x .gate-proof-bin/npx
echo '{}' >knip.json
printf 'export const kept = 1;\nexport const dropped = 2;\n' >$d/$n.js
git add knip.json $d
git commit -qm "gate proof: base"
printf 'export const kept = 1;\n// the helper moved\n' >$d/$n.js
git add -A $d
git commit -qm "gate proof: red-check"
