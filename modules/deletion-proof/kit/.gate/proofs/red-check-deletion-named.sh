# Proof for red-check with the deletion-proof module: a deleted file that a tracked file still names.
# Run: PATH="$PWD/.gate-proof-bin:$PATH" scripts/red-check --base HEAD~1
# Says: check 2: gate-proof/used\.js is still named in
# A fake npx stands in for knip, so the proof reaches no network; it prints the report knip 6.42.1 would, as JSON. The paths
# are built from parts: a tracked file that names a path is what check 2 looks for, and this file is tracked.
d=gate-proof n=used
mkdir -p $d .gate-proof-bin
printf '#!/bin/sh\ncat <<'"'"'JSON'"'"'\n%s\nJSON\nexit 1\n' '{"issues":[]}' >.gate-proof-bin/npx
chmod +x .gate-proof-bin/npx
echo '{}' >knip.json
printf '/.gate/\nknip.json\n' >.gate/protected
printf 'export const used = 1;\n' >$d/$n.js
printf 'see %s/%s.js\n' $d $n >$d/notes.md
git add knip.json .gate/protected $d
git commit -qm "gate proof: base"
rm $d/$n.js
git add -A $d
git commit -qm "gate proof: red-check"
