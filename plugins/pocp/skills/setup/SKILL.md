---
name: setup
description: Set up POCP (Proof of Change Protocol) in a repository that doesn't use it yet, one with no .proof/rules.json. Use when the user runs /pocp:setup, asks to set up POCP, or asks how to stop coding agents from editing or weakening tests to make CI pass.
---

Set up POCP in this repository with the user. POCP checks that the tests a change was supposed
to pass actually ran on the exact code being committed and merged. When a change edits existing
tests, it runs the old tests on the new code and holds risky test edits for a person. Work through
the steps below in order. Ask before anything that commits, pushes or changes GitHub settings.

**1. Check where things stand**

- If `.proof/rules.json` already exists, POCP is set up. Run `pocp doctor` (or
  `npx pocp doctor`), report what it says is missing, and stop here.
- POCP needs a git repository, Node 20 or later and a POSIX shell. Check with
  `git rev-parse --show-toplevel` and `node --version`. If something is missing, say what and stop.
- If the working tree has uncommitted changes, ask the user to commit or stash them first.

**2. Find the test command**

Look for the command that runs this project's tests: `scripts.test` in `package.json`, `pytest`,
`go test ./...`, `cargo test`, a `make test` or `make check` target, or a CI workflow that runs
tests. Show the user the command you found and the source folders it covers, and confirm both.
If there are no tests, say that POCP needs a check to run and stop.

**3. Ask where the checks run**

Give the user these two options, one line each, and let them choose:

- **GitHub CI** (`pocp init --hooks --github`): CI re-runs every check on a clean machine and can
  block merges. It needs a GitHub `origin` and a logged-in `gh`, and costs about one extra test
  run of Actions minutes per pull request.
- **Local only** (`pocp init --local`): the git hooks on this machine are the gate. Nothing runs
  in CI and nothing blocks a merge.

**4. Install and initialize**

- Node project (a `package.json` at the root): `npm install --save-dev proof-of-change`, then use
  `npx pocp …`. Anything else: ask before running `npm install -g proof-of-change`, then use `pocp …`.
- With GitHub CI, first make a branch: `git checkout -b adopt-pocp`.
- Run the `init` command the user chose. It creates `.proof/` and prints the test layout it found.

**5. Write the first rule**

In `.proof/rules.json`, replace `"requirements": []` with one rule that maps the source folders
from step 2 to the test command, and keep the rest of the file as `init` wrote it:

```json
"requirements": [
  { "id": "tests", "globs": ["src/**"],
    "obligation": { "kind": "test", "run": "npm test" } }
]
```

Use the real folders and command. Add `"cwd"` to the obligation if the command must run in a
subfolder. Then run `pocp rules check` and fix anything it reports.

**6. Commit, with the user's go-ahead**

- Stage the changes and run `pocp fix --intent "Adopt POCP"`, then `git commit -m "Adopt POCP"`.
- With GitHub CI, push the branch and open a pull request only if the user says to. Once it has
  merged, `pocp ci required --apply` makes GitHub block merges until the `pocp` status is green.
- Finish with `pocp doctor` and tell the user what it reports.

**Never**

- Add `pocp-approve-*` labels, run `pocp approve`, or pass `--accept-*` flags. Approvals are the
  user's.
- Commit with `--no-verify` or change `core.hooksPath` to get past the gate.
- Write rules that cover nothing, or point a rule at a command that doesn't run the tests, just
  to get set up.

From then on, the `pocp` skill covers everyday work in the repository.
