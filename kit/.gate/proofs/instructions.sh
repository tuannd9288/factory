# Proof for the instructions check: the Gate block loses its end marker.
# Says: malformed
grep -v '^<!-- factory:gate:end -->$' AGENTS.md >AGENTS.md.proof && mv AGENTS.md.proof AGENTS.md
git commit -qam "gate proof: instructions"
