# When red-check says "not a pure deletion"

Each refusal is one line, `red-check: not a pure deletion: <what>: <reason>`. Find yours below, do what it says, and
run `red-check --base origin/main` again. A refusal is never a reason to edit a tier-3 file in the same pull request.
When the fix is a tier-3 change, open it as its own pull request with your recommended answer. If the deletion cannot
wait, land it meanwhile with a test or a `No-red:` line.

| The line says | It means | Do |
|---|---|---|
| `config: <file> holds the key "<key>"` | The knip config has a key that can load code (`preprocessor`, a plugin section, `compilers`, or a key the gate does not know) | Tier 3: propose a data-only `knip.json` in its own pull request |
| `config: knip has no config` / `config: a JS or TS knip config` / `config: the knip config is in package.json` / `config: <file> could not be read as JSON` / `config: <file> is not a JSON object` | knip's config is not a JSON file the gate can trust | Tier 3: propose a `knip.json` of data keys |
| `config: <knip config> is not in .gate/protected` | A tier-1 change could have edited knip's own config | Tier 3: propose adding the config's name to `.gate/protected` and `.github/CODEOWNERS` |
| `check 1: <path> is modified, not deleted whole` / `is added, not deleted whole` / `changes type` | The change edits, adds or retypes a source file; only whole-file deletions get a machine proof | Move that edit to another pull request with a test |
| `check 2: <path> is still named in <file>` | A tracked file at the head mentions the deleted file | A doc or comment: delete the mention (under a tier-3 path that makes the pull request tier 3). Source: the code is used; put the file back |
| `check 3: knip did not list <path> as unused at the base` | knip thinks the file is used, or you deleted more than it listed | Put it back. Delete only what `knip-at-base report` lists |
| `check 3: the base could not be prepared for knip` / `check 3: knip could not run (exit <n>)` | The repository's `gate_prepare` or knip failed at the base | Run `knip-at-base report` to see the error; a broken base is not yours to work around in this pull request |
| `check 3: knip's JSON report could not be read` | knip printed something else than its JSON report | Run `knip-at-base report` and read what it printed |
| `check 3: the change deletes no file` | Nothing for knip to have listed | Not a deletion: use a test or `No-red:` |
