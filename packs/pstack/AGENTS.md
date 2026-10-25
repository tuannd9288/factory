## Where pstack yields

pstack's playbooks run here when a session types `/pstack:<skill>`, at the prompt's start in `claude -p` too. Its
skills but `setup-pstack` refuse the model's own call; its agents `poteto-agent` and `comment-sicko` do not. They
yield at this point, where the gate's rule wins:

- Open the pull request only after `scripts/verify` and `red-check` pass locally; push the branch as often as you
  like before that. Every head the gate judges red is a round, and the third makes the change tier 3.
  (pstack `autopilot-full.md:10`)

