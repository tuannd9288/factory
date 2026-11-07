# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat model (omit Task `model`). Alias entries in a panel list still count toward its fan-out.
# `codex <effort>` as a value (the factory, #182): that seat is another model family and no Agent: run `factory codex --role <arena-runner|cross-judge|architect-runner|interrogate-reviewer> --effort <effort>` with its brief on stdin, adding `--write <its worktree>` for a seat that writes; its stdout is the seat's report. Exit 3: the seat waits for Codex; say so, and never run it on Claude.
# budget: large (xhigh)
feature, refactoring: inherit-parent
bug-fix: inherit-parent
perf-issue: inherit-parent
hillclimb: inherit-parent
judgment and prose: opus xhigh
hardest tasks: opus xhigh
how explorer: inherit-parent
how explainer: opus xhigh
why investigators: inherit-parent
why synthesizer: opus xhigh
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: opus xhigh
arena runners: opus xhigh, codex high
arena cross-judge pool: codex high
swarm workers: inherit-parent
architect runners: opus xhigh, codex high
interrogate reviewers: opus xhigh, codex high
