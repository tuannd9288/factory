# Proof for red-check: a deleted file that another tracked file still names.
# Run: PATH="$PWD/.gate-proof-bin:$PATH" scripts/red-check --base HEAD~1
# Says: check 2: gate-proof/gone\.js is still named in gate-proof/guide\.md
# A fake npx stands in for knip, so the proof reaches no network; it prints the report knip 6.42.1 would, as JSON.
# The paths are built from parts: a tracked file that names a path is what check 2 looks for, and this file is tracked.
d=gate-proof n=gone
mkdir -p $d .gate-proof-bin
printf '#!/bin/sh\ncat <<'"'"'JSON'"'"'\n%s\nJSON\nexit 1\n' "$(printf '{"issues":[{"file":"%s/%s.js","files":[{"name":"%s/%s.js"}],"exports":[],"types":[]}]}' "$d" "$n" "$d" "$n")" >.gate-proof-bin/npx
chmod +x .gate-proof-bin/npx
echo '{}' >knip.json
printf 'export const gone = 1;\n' >$d/$n.js; printf 'The helper lives in %s/%s.js.\n' $d $n >$d/guide.md
git add knip.json $d
git commit -qm "gate proof: base"
rm $d/$n.js
git add -A $d
git commit -qm "gate proof: red-check"
