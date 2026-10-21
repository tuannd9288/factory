# Proof for the policy check: a path joins .gate/protected while CODEOWNERS does not list it.
# Says: gate-proof/ is not among the last lines
echo 'gate-proof/' >>.gate/protected
git commit -qam "gate proof: policy"
