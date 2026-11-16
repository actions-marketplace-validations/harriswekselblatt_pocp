# Changelog

## 1.3.1 (2026-11-16)

Upgrading: re-run `pocp init --github --force`, which rewrites `pocp.yml` and `pocp-status.yml`
and removes `pocp-labels.yml`, then commit `.github/workflows`. Until then your workflows work
as in 1.3.0, and the verify action warns on each run that passes an approval.

### Changed

- **No more `pull_request_target`.** From December 2, 2026, GitHub blocks `pull_request_target`
  workflows by default in public repositories, and `pocp-labels.yml`, which removed approval
  labels on every push, ran on it. Now one rule (`src/label-freshness.js`) decides whether a
  label counts for a head: its last application is by someone with write access, after the
  head's first run and after the latest force-push, or it carries over to a clean merge of the
  base ("Update branch"). verify applies it when `pocp.yml` passes `label-freshness: github`
  (the job needs `actions: read` and `pull-requests: read`; the token reaches verify's process
  only, never a check), so a label left on from before a push no longer passes verify, whether a
  push or another label starts the run, and whether or not the `pocp` status is live. The
  reporter applies the same rule, and removes the labels it finds stale with `github.token`
  (`pull-requests: write`). `pocp-status.yml` runs on `workflow_run` only, and
  `pocp-labels.yml` is gone: nothing to allow in the repository's Actions settings.
- `pocp.yml` passes every approval label on every event, with the head's sha; verify decides
  whether it counts. "Update branch" keeps its approvals without the `pocp` status live too.
- `pocp doctor` flags a `pocp.yml` without `label-freshness` and a leftover `pocp-labels.yml`
  (a problem while `verify` is the required check, a warning with the status live), in place of
  1.3.0's check for blocked `pull_request_target` runs. `init --github --force` removes
  `pocp-labels.yml`; `ci off` / `on` still switch it while it's there.

### Not yet checked

- A pull request from a fork. Its token is read-only; the label rule reads the pull request's
  events, its runs and each labeller's permission. Tested on GitHub with same-repository pull
  requests only. If GitHub refuses a read, verify refuses the approval (it never passes one it
  couldn't check), so the risk is a fork's approvals waiting, not passing.

## 1.3.0 (2026-11-16)

Upgrading: re-run `pocp init --github --force` to get the new `pocp-status.yml` (the reporter
App needs it; without the App it posts as before).

### Added

- **The reporter can post as its own GitHub App.** Until now the `pocp` status was posted as
  GitHub Actions, like every workflow, so a branch pushed to the repository (by an agent using
  your token, say) could edit a workflow and post its own `pocp: success`. The example
  `pocp-status.yml` now runs in a `pocp-reporter` environment and, when
  `POCP_REPORTER_CLIENT_ID` is set, posts with a token from your own App whose key lives only in
  that environment. Limit the environment to your default branch and pin the required `pocp`
  check to the App (docs/STATUS.md, "Give the reporter its own identity"). It needs a public
  repository or GitHub Pro or Team. New config key `ci.reporter_app_id` (the App ID):
  `pocp ci required --apply` requires `pocp` from that App only, keeping every other check's
  source, and `--check` and `pocp doctor` report a required `pocp` check that any source or
  GitHub Actions can post. Changing or removing the key is a policy loosening.
- **Local mode: POCP without CI.** For repositories where CI isn't available or wanted, such as
  a free private repository whose Actions jobs fail for billing. `pocp init --local` sets
  `ci.mode: "local"` and installs the hooks. `pocp ci off` disables POCP's workflows on GitHub
  and sets the mode; `pocp ci on` reverses both, with no workflow file to commit. Run
  `pocp verify --require-coverage --rerun main..HEAD` before merging to recover most of what CI
  checked, including commits made with `--no-verify`. The trade, which `pocp doctor` states: no
  independent re-run, nothing blocks a merge, and you trust your own machine. Approvals are
  `--accept-*` flags on that verify, which anything on your machine can pass, an agent included;
  the gate, `pocp fix` and verify name you, not CI and a label, as the approver. Switching to
  local mode is a policy loosening. `pocp doctor` also recognises Actions jobs GitHub doesn't
  start for billing reasons and suggests `pocp ci off`.

### Changed

- **Every next step says who acts first.** Gate, `pocp fix` and verify output, the job summary
  and `verify --json` (new `next_steps: [{ by, code, why, next }]`) lead with who takes the step:
  the author, a maintainer, a re-run (a check didn't finish) or infra (e.g. ssh-keygen missing).
  A maintainer's label step names the pull request and `pocp approve owner/repo#N`, marked as the
  maintainer's, never the author's or an agent's. In verify findings, `by` is now `rerun` for
  checks that didn't finish and `infra` for an unavailable signature check (was `agent`).
- **A hung mutant's retry is capped.** Deep mode retried a timed-out mutant run at 3× its limit
  with no ceiling (a 10-minute limit could spend 40 minutes on one hung mutant). The retry now
  gets at most 5× the check's measured time on the new code, or 30 s if that's more. A retry
  that hits the cap is not measured, so the result is inconclusive, never a pass.
- **The test guard's result records where its time went** (`timings`: setup, baselines, mutant
  runs and retries, snapshots). For profiling only; nothing reads it to decide a verdict.
- Messages no longer promise CI or a push where there is none: the pre-commit hook's message
  when pocp can't be found says "pocp verify still flags it", and in local mode the advice not to
  rewrite history says to keep the commit and approve it before merging.

### Fixed

- **A commit that edits only a test keeps the rule's `cwd`.** With no rule covering the test
  file, `pocp fix` borrowed the repository's most-required test command but dropped the rule's
  settings, so a check that runs in a subfolder (QUICKSTART's own `"cwd": "tests"`) ran at the
  root, couldn't start, and `fix` advised re-running forever. It now borrows the rule's whole
  check (`cwd`, `timeout_ms`, `inputs`, ...), and two rules with the same command in different
  folders are no longer counted as one. The test guard's changed-tests run carries the whole
  check too. `pocp ci-run --dir tests/` now matches a rule's `"cwd": "tests"` in verify, and a
  folder outside the repository is refused.
- **`pocp approve` no longer says "nothing to approve" while the `pocp` status waits for an
  approval.** When verify passed with a label the reporter won't count for this head, `pocp
  approve` (and `pocp approvals`) read the `pocp` status, list the label, and on your
  confirmation remove it and add it back. They also skip a verify run that was skipped (such as
  one for an edited description) instead of letting it hide the run that asked for approval,
  and say so when the status waits for a maintainer but no run says what for.
- **"Update branch" no longer drops an approval because the base gained a proof record.** The
  reporter's carry-over rule treated every file under `.proof/` as policy, so a base that had
  merged any other pull request (which adds a `.proof/packets/` record) voided every carried
  approval. Proof records no longer count; config, rules and the pull request's own packets
  still void it.
- **A pull request no longer needs `pocp-approve-policy` because the base tightened its policy.**
  `verify base..head` compared every commit's policy with the base's current one, so when the
  base added a setting (say `ci.reporter_app_id`) while a pull request was open, the pull
  request's older commits counted as removing it. In a range, a commit now answers only for
  loosenings its parent didn't already have. The head still answers for everything it loosens
  against the base, and a loosening made in one commit and reverted later is still flagged.
- **An approval label no longer counts for a head brought back by a force-push.** The reporter
  counted a label applied after the head's first run. If the author force-pushed another head,
  a maintainer labelled that one, and the author force-pushed back, the label counted for code
  nobody approved. `pocp-labels.yml` removed it on that push, but nothing else did. Now a label
  counts only if it was also applied after the pull request's latest force-push, and the same
  holds for "Update branch" carry-over.
- **Fixes from the new-user walkthrough on GitHub and with no remote:**
  - In a repository with no remote, `init --local`, `ci off` and `doctor` printed
    `pocp verify … origin/main..HEAD`, which fails there. They now print a base that exists:
    `origin/<branch>` when there is an origin, else the local default branch.
  - Without `--base`, `doctor` judged an adoption branch against itself when `origin/HEAD` wasn't
    set (a repository pushed rather than cloned). It now asks GitHub for the default branch, then
    tries `main` and `master`.
  - With no `ci.reporter_app_id`, `ci required --check` and `doctor` reported an unpinned `pocp`
    check as a gap to fix with `ci required --apply`, which can't fix it. It is now a note that
    points to the optional App setup in docs/STATUS.md.
  - When verify waits only for a label, the job summary's heading names it. Before the
    adoption pull request merges, this summary is the only place that says so.
  - After approving, `pocp approve` says a new push needs a new approval (it said the label
    stays on through later pushes).
  - The `pocp` status for an approval label added before the head commit says so, instead of
    blaming write access.

### Known limit

- **GitHub's `pull_request_target` block.** From December 2, 2026, GitHub blocks
  `pull_request_target` workflows by default in public repositories with no Actions event
  policy. `pocp-labels.yml` runs on it, so approval labels then stay on after a push. With the
  `pocp` status live, the reporter still refuses them, and this is only untidy. With `verify` as
  the required check, allow `pull_request_target` in the repository's Actions settings, or turn
  the status live. `pocp doctor` reports the block, and docs/STATUS.md explains it. 1.3.1
  removes the dependence on `pull_request_target`.

- **Deep mode doesn't defend against deception planned across pull requests.** An agent can
  first weaken an assertion and add a test that "catches" every planted bug by reading the
  source, which deep mode accepts, then add the bug in a later pull request. That is an agent
  working against its owner over time, outside POCP's threat model; POCP has no defence against
  it. Deep mode still catches the corner-cutting it is built for: breaking code and weakening
  the test that caught it in the same pull request (docs/THREAT-MODEL.md, "Out of scope";
  `test/e2e-guard-known-gap.test.js` pins the gap). Fast mode sends every test edit to a person,
  so the attack doesn't apply there.

## 1.2.3 (2026-11-10)

### Fixed

- **A test change whose CI re-run disagrees with a local pass can be approved again.** When the
  test-change check passed locally but its CI re-run didn't (for example an inconclusive deep-mode
  sample), verify added a second blocking finding that no label could clear. In block mode the
  re-run's own verdict now decides, with its usual approval, and the disagreement stays visible
  as a warning. A failing required check still blocks, and attest mode is unchanged.
- **Standalone test files are recognised as tests.** `test.js`, `test-unit.mjs` and the same
  names in other JavaScript/TypeScript extensions (AVA's defaults, also inside packages) are now
  guarded like `*.test.js`, and left out of the planted-bug sample. Before, a change could edit
  such a file without the old-tests check seeing it. A source file named `test-*.js` (for
  example `test-setup.js`) now counts as test setup too: editing it goes to review.

## 1.2.2 (2026-11-10)

### Fixed

- **A kept approval no longer covers changes the base branch made after it was given.** With
  the `pocp` status live, an approval kept across "Update branch" now needs the base branch to
  have changed nothing under `.proof/` and none of the files the approval covers since the
  approved head branched off. Before, a merge that kept the pull request's own copy of a policy
  file let a policy approval also cover a rule added on the base branch. Upgrading is
  recommended if you use the `pocp` status.

## 1.2.1 (2026-11-10)

### Changed

- **`pocp init --github` creates the approval labels** on GitHub through your `gh` login,
  leaving existing ones alone. Before, `pocp doctor` printed the commands to run by hand.
- **Fewer workflow runs.** The status and label workflows, and verify with the `pocp` status
  live, skip events that can't change the result: labels other than `pocp-approve-*`, and pull
  request edits that don't change the base. Skipped jobs use no Actions minutes. Update with
  `pocp init --github --force`.

## 1.2.0 (2026-11-09)

### Changed

- **`pocp help` shows six everyday commands** (`init`, `doctor`, `fix`, `status`, `verify`,
  `approve`) when run in a terminal; `pocp help advanced` (or `--all`) lists every command.
  When its output isn't a terminal, `pocp help` still prints the full list, so workflows that
  read it to detect verify options keep working. `pocp approve` is the everyday name for
  `pocp approvals`, and `pocp approve owner/repo#12` approves one pull request; `approvals`
  keeps working. Every command keeps working by name.
- **One answer approves everything a pull request is waiting for.** `pocp approvals --approve`
  now shows every listed approval together (each with its diff) and adds all of them after one
  confirmation, in a single label edit. It also finds pull requests waiting for approval when the
  `pocp` status is live, where the verify job passes on a wait.
- **A new install no longer shows a red failure while it waits for an approval.** On a GitHub
  repository, `pocp init --github` turns the `pocp` status on (`POCP_STATUS_LIVE`) through the
  user's `gh` login, and writes `pocp` as the required check. `pocp ci required --apply` then
  requires `pocp` in place of `verify` and turns the status on, in the safe order: the variable
  is never set while `verify` is required. On a free plan's private repository it says that
  nothing blocks a merge. `--no-live` keeps report-only mode.
- **Updating a pull request's branch no longer removes its approvals.** With the `pocp` status
  live, a push that only merges the base branch into an approved head keeps the tests, policy
  and coverage approval labels. The reporter counts them for the new head only when that merge
  changed nothing the pull request changes and no `.proof/` file; the new head is still verified
  again from scratch. Adopters pick this up by updating `pocp-labels.yml` and `pocp.yml`
  (`pocp init --github --force`). See docs/STATUS.md.

### Fixed

- **A bug fix that adds an assertion to the module's own test is no longer held as a test-setup
  change.** A module that a test named after it imports is now treated as the code under test.
- **An assertion helper with its own unit test stays test support,** so changing it still needs
  the guard's check or a maintainer's approval. Upgrading is recommended.

## 1.1.2 (2026-11-09)

### Packaging

- **Install from npm:** `npm install --save-dev proof-of-change` (the command is `pocp`). The
  README and QUICKSTART use it; `pocp init --github` pins v1.1.2. Published by the release
  workflow with npm provenance.

### Added

- **Warnings for unknown policy keys.** POCP ignores keys it doesn't know in
  `.proof/rules.json` and `.proof/config.json`, so a misspelled setting (`"fail_one"` for
  `"fail_on"`) was silently off. `rules check`, `doctor`, the gate and verify now warn about each
  one, with the key it probably meant. Nothing passes or blocks differently. Keys that start with
  `$` are comments and are never reported.

## 1.1.1 (2026-11-09)

### Packaging

- **The npm package is named `proof-of-change`.** npm refuses `pocp` as too close to existing
  package names. The command it installs is still `pocp`. 1.1.0 was released on GitHub only.

## 1.1.0 (2026-11-08)

Security and reliability fixes from an audit on 2026-11-07. Upgrade from 1.0.0: some changes
that verified before are now held for review, on purpose.

### Security

- **Fast mode no longer passes any test edit on its own.** Every change to tests or test setup,
  including added lines and new test files, goes to a person. Text rules couldn't show that an
  edit still tests what it did. Deep mode (`guard.mutants` above 0) is the automatic path.
- **New test files are guarded.** They run with the old tests and can change their outcome; deep
  mode now requires the suite with them to still catch every sampled bug.
- **Repository settings can't hide changes from POCP's diffs** (attributes that mark files as
  binary, submodule ignore settings, diff prefix settings).
- **`verify` refuses shallow clones** and ranges whose sides share no history, instead of
  guessing a base.
- **The `pocp` status needs complete data and a run tied to this pull request and base.** An
  incomplete file list, another open pull request on the same head, a newer unfinished run, or a
  moved head or base keeps it pending.
- **Green comes only from verify's exit status.** In `pocp.yml` the verify step's output now only
  chooses between waiting, inconclusive and failed. Update your `pocp.yml` (`pocp init --github
  --force`): the reporter needs its `pocp-run` and `verified` steps, and keeps a run from an older
  workflow pending.
- **Isolated checks: `verify --isolate`.** On Linux runners with passwordless sudo, every check
  verify runs (re-runs, the test guard's runs, and `--install`'s dependency install) runs as a
  fresh unprivileged user that can't reach the verifier, the job's files and tokens, or verify's
  processes, and everything it starts is killed when it ends. If isolation can't be set up,
  verify fails. The action's new `isolate` input defaults to `true`, and the example workflow
  asks for it; install dependencies with the new `install` input instead of an earlier step.
  Without it, verify says its checks ran with the cooperative runner, which isn't the secure
  profile. docs/THREAT-MODEL.md lists what this does and doesn't cover.
- **Approval labels count only when a writer applied them**, last, after the head's first run.
- **The reporter never leaves or revives a stale green.** A newer run that doesn't say which pull
  request it checked holds the status; a base, label or shared-head change seen right before
  writing writes pending over any older green; retargeting re-runs verify.
- `ci.require_up_to_date` asks for GitHub's "up to date before merging", so the merged code is
  the code that was verified; `pocp ci required --check` reports it when missing.
- `**` globs match paths containing a newline.
- Checks no longer inherit git's repository variables (`GIT_DIR`, `GIT_INDEX_FILE`, …) from hooks.
- Workflows pin actions by commit SHA, set job timeouts, and drop checkout credentials.

- **Branch protection covers the whole plan by default.** `ci.require_up_to_date` (GitHub's
  "require branches to be up to date") is on unless a repository turns it off, and `pocp init`
  writes it. `pocp doctor` now reports every gap `pocp ci required --check` does (admins exempt,
  branches not up to date, pushes without a pull request), not only missing check names. Merge
  queues aren't supported yet, and on a free plan's private repository POCP is advisory; both
  are documented.

### Changed

- **`verify` is faster.** Its re-runs and the test guard run side by side, and repeated git calls
  are gone: POCP's own verify went from about 15 to about 8.5 minutes.
- **A failed check shows why.** `verify` prints the end of a failed check's output in the CI
  log (size-capped; never stored in proof records).

### Added

- **`decideVerify(result)` in the library.** It says what a `verify` or `verifyRange` result
  that isn't verified is waiting for (failed, inconclusive, or the approvals it needs), the
  same decision the CLI reports as `approval` in `--json` and through `--exit-detail`. The CLI
  now uses it too, and the decision reads only typed facts about each finding, never its text
  or the remedy's wording. CLI output is unchanged.

### Fixed

- **A malformed packet is reported, not a crash.** A packet file that is valid JSON but not the
  shape POCP needs (missing obligations or touches, an obligation without an id or kind, an
  `id` that differs from its file name) made `verify` stop with a JavaScript error (exit 3).
  Verify now reports it as a blocking `missing_packet` finding ("… is malformed: …"), and
  `status`, `show` and other local commands give a clear error naming the file and the field
  (exit 2), as they already did for invalid JSON. A packet whose `id` doesn't match its file
  name no longer verifies.
- **The pull request that adopts POCP verifies in CI.** Committing what `pocp init --hooks`
  creates passed the gate, but `verify --require-coverage` (the shipped CI invocation) then
  failed it: the new `.proof/config.json` and `.proof/rules.json` counted as an uncovered policy
  change. Creating the first policy is now adoption in verify too, as it already was in the gate,
  but only when neither the commit's parent nor the policy that judges it has any policy file.
  Removing, corrupting or editing an existing policy, CI file changes, and the rest of an adoption
  commit are checked as before.
- Adding several approval labels at once no longer leaves the `pocp` status stuck on "Waiting
  for verify." Each label starts a run and all but one are cancelled while queued; the reporter
  took the newest of those step-less runs as the latest word. A run cancelled before its verify
  job ran any POCP step now says nothing, like a skipped run. One cancelled after it started
  evaluating still holds an older success at pending.
- Committing the files `pocp init` creates no longer fails as a policy loosening.
- `pocp --version`, `-v`, `-h`, `pocp help <command>`; unknown options are reported instead of
  taking the next argument as their value.
- A check that exits in time is never recorded as timed out, and a leftover background process
  can't hold a run open.
- A check that didn't finish (timeout, signal, can't start) is reported as unfinished, not as
  "fails on this code"; unfinished test-guard results are not cached.
- A missing or failing `ssh-keygen` is reported as unavailable, not as an edited record.
- The store lock can no longer be taken by two processes at once, including while an abandoned
  lock is being broken; each acquisition has its own token.

### Packaging

- `init --github` and the docs pin v1.1.0.
- `package.json` has repository, bugs and homepage; a tag-triggered release workflow publishes
  with npm provenance.
