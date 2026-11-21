# POCP for Claude Code

Coding agents sometimes make a failing build pass by editing the test instead of fixing the code. [POCP](https://github.com/harriswekselblatt/pocp) (Proof of Change Protocol) catches that. It checks that the tests a change was supposed to pass actually ran on the exact code being committed and merged. When a change edits existing tests, it runs the old tests against the new code and holds risky test edits for a person to approve.

This plugin connects Claude Code to POCP.

![An agent breaks add() and edits the test so npm test passes; POCP reports that the old test fails on the new code and holds the change; the agent puts the test back and fixes add()](https://raw.githubusercontent.com/harriswekselblatt/pocp/main/docs/demo.svg)

## What it does

- **Sets POCP up.** Run `/pocp:setup` in any git repository. Claude finds your test command, asks whether checks should run in GitHub CI or only on your machine, installs POCP, writes a first rule and runs `pocp doctor`. It asks before committing, pushing or changing GitHub settings.
- **Keeps Claude working with POCP, not around it.** In a repository that uses POCP (one with `.proof/rules.json`), a hook refuses the commands that skip it: `git commit --no-verify` or a `core.hooksPath` change, a force-push over proven commits, approving its own test or policy change (adding a `pocp-approve-*` label, including on a new pull request, `pocp approve`, `--accept-*`), and switching checks off on GitHub without a pull request (`pocp ci off`, `pocp init --local`, `gh workflow disable`, `--disable-billing-failed`). Each refusal tells Claude what to do instead.
- **Explains every approval hold in plain English.** When a command's output shows POCP holding a change for you (the `pocp` status "Waiting for approval" in `gh pr checks`, POCP's comment on the pull request, `pocp fix`, `pocp gate`, the pre-commit hook), a second hook gives Claude POCP's full reason for each label: what adding it means and why the change needs it. The status line on GitHub is cut to 140 characters, so Claude is told to give you, before anything of its own, the exact command, then what the label means, then why, and never to add the label itself.
- **Teaches the workflow.** A skill shows Claude how to open a packet, prove a change with `pocp fix`, and when to hand a decision to you.

In a repository without POCP, the hooks do nothing, unless the command is aimed at one that has it (`cd <repo> && …` or `git -C <repo> …`). The plugin reads and sends nothing over the network. Each hook is one dependency-free script that checks for `.proof/rules.json`: [scripts/guard.mjs](scripts/guard.mjs) reads the command Claude is about to run; [scripts/explain-hold.mjs](scripts/explain-hold.mjs) reads a finished command's output and adds only POCP's own fixed sentences, never text from the output, so a pull request comment can't speak through it.

## Limits

The hook guards against an agent cutting corners, not one set on hiding what it does. A command built at run time, for example with `eval` or a script file, isn't read. CI re-running every check is what enforces POCP. POCP doesn't prove your code is correct.

## Requirements

Git, Node 20 or later, and a POSIX shell. POCP works with any test command and any language.

MIT licensed. Full documentation: [github.com/harriswekselblatt/pocp](https://github.com/harriswekselblatt/pocp).
