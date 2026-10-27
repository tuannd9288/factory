# Proof for the native check: the repository's own verify fails. The proof is the same for every repository.
# Says: native
. .gate/config.sh
printf '#!/bin/sh\nexit 1\n' >"$GATE_NATIVE"
git commit -qam "gate proof: native"
