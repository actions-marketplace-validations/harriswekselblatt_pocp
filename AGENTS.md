# Instructions for coding agents

For every coding agent working here (Codex, Claude Code, any other). `CLAUDE.md` imports this file.

## This repo is public

Write every file as if it were already published, because it is (or will be), with its history.

- **Nothing private.** No local paths (use `~` or repo-relative ones), no personal email addresses, no ids from the author's own tools (task ledger ids), no content copied from private repos. `test/privacy.test.js` fails on these, so the test suite blocks the commit.
- **Fixtures are synthetic.** When a real private file shows a problem, write a small made-up fixture that reproduces it, and describe the real case in prose without its contents.
- **Private terms** you want caught go in `~/.config/privacy-guard/terms.txt` (one per line), outside the repo, so the list itself is never committed.

## This repo uses POCP

POCP checks its own changes. Work the way [`examples/agent-instructions.md`](examples/agent-instructions.md) says (`pocp fix` before every commit; never add a `pocp-approve-*` label yourself). Above all, when POCP holds a change for the maintainer:

When POCP says a person must approve, tell the user three things, in this order, before
anything of your own: (1) the exact command to run, (2) what the label means ("Adding it
means: …"), (3) why this change needs it, in POCP's words. Take them from POCP's full
reason, not the pull request's `pocp` status: that line is cut to 140 characters, so on its
own it is never enough. The full reason is the `why:` lines and the approve command that
`pocp fix` and `pocp gate` print, `hold.command` and `hold.items[]` (`reason`, `means`) from
`pocp gate --json`, `pocp fix --json` or `pocp approvals --json`, `pocp approvals`, or POCP's
hold comment on the pull request (it also names the files and test lines to look at). Don't
shorten, soften or reword it, and never hand over a bare label command or the status line
alone: the person adding the label needs to know what they are accepting.
