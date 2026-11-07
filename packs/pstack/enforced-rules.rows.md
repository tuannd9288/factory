The rows of the kit's `.gate/enforced-rules.md` that a repository with this pack's `scripts/ship`
adds to its own copy of that file (a tier-3 path), after the pack's scripts are in. They left the kit with the scripts (#132).

| Rule | Enforced by |
|---|---|
| Auto-merge only on a base of `main`; a pull request opens only after a local pass; a tier 3 is armed, then stops until the Human approves; `needs-human` stops before arming | `scripts/ship`, on the stamp `red-check` leaves; a push is never refused |
