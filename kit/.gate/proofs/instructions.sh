# Proof for the instructions check: AGENTS.md grows past 150 lines.
# Says: at most 150
for i in $(seq 1 151); do echo "padding line $i"; done >>AGENTS.md
git commit -qam "gate proof: instructions"
