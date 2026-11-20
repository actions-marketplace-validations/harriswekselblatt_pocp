# GitHub responses for a workflow GitHub didn't start for billing

Recorded from GitHub's REST API on 2026-11-19, from a repository whose jobs GitHub had stopped starting
for billing, then scrubbed: the repository is `me/site`, and ids, SHAs, branch and title are
placeholders. Field names, nesting, `steps: []`, the annotation levels and GitHub's message text are as
GitHub returned them.

- `billing-jobs.json`: `GET repos/{repo}/actions/runs/{run}/jobs` for a run that failed for billing.
  Every job is `conclusion: "failure"` with no steps and no runner: GitHub never started it.
- `billing-annotations.json`: `GET repos/{repo}/check-runs/{job}/annotations` for one of those jobs.
  The billing message is a `failure` annotation; an unrelated `notice` comes with it.
- `ordinary-jobs.json`, `ordinary-annotations.json`: a job that ran and failed on its own (a
  recorded job's step list, the failing step renamed). It has steps, so it is never billing evidence.

Used by test/billing-workflows.test.js.
