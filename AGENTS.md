# Instructions for coding agents

For every coding agent working here (Codex, Claude Code, any other). `CLAUDE.md` imports this file.

## This repo is public

Write every file as if it were already published, because it is (or will be), with its history.

- **Nothing private.** No local paths (use `~` or repo-relative ones), no personal email addresses, no ids from the author's own tools (task ledger ids), no content copied from private repos. `test/privacy.test.js` fails on these, so the test suite blocks the commit.
- **Fixtures are synthetic.** When a real private file shows a problem, write a small made-up fixture that reproduces it, and describe the real case in prose without its contents.
- **Private terms** you want caught go in `~/.config/privacy-guard/terms.txt` (one per line), outside the repo, so the list itself is never committed.
