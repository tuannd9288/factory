The rows of the kit's `.gate/enforced-rules.md` that a repository with this pack's `scripts/ship` and `scripts/live-verify`
adds to its own copy of that file (a tier-3 path), after the pack's scripts are in. They left the kit with the scripts (#132).

| Rule | Enforced by |
|---|---|
| Auto-merge only on a base of `main`; a pull request opens only after a local pass; a tier 3 is armed, then stops until the Human approves; `needs-human` stops before arming | `scripts/ship`, on the stamp `red-check` leaves; a push is never refused |
| Auto-merge armed only while a live PASS or PASS+NOTES covers the head or its patch (with no driver on `main`, the pull request author's unedited `not run as a user: no driver` note for the head covers it in place of a verdict); disarmed on the next `ship` once a patch moved past its verdict | `scripts/ship`, on `scripts/live-verify --covered`; the ledger lists each merged pull request no verdict covered |
