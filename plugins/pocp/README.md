# POCP for Claude Code

Coding agents sometimes make a failing build pass by editing the test instead of fixing the code. [POCP](https://github.com/harriswekselblatt/pocp) (Proof of Change Protocol) catches that. It checks that the tests a change was supposed to pass actually ran on the exact code being committed and merged. When a change edits existing tests, it runs the old tests against the new code and holds risky test edits for a person to approve.

This plugin connects Claude Code to POCP.

![An agent breaks add() and edits the test so npm test passes; POCP reports that the old test fails on the new code and holds the change; the agent puts the test back and fixes add()](https://raw.githubusercontent.com/harriswekselblatt/pocp/main/docs/demo.svg)

## What it does

- **Sets POCP up.** Run `/pocp:setup` in any git repository. Claude finds your test command, asks whether checks should run in GitHub CI or only on your machine, installs POCP, writes a first rule and runs `pocp doctor`. It asks before committing, pushing or changing GitHub settings.
- **Keeps Claude working with POCP, not around it.** In a repository that uses POCP (one with `.proof/rules.json`), a hook refuses the commands that skip it: `git commit --no-verify` or a `core.hooksPath` change, a force-push over proven commits, approving its own test or policy change (adding a `pocp-approve-*` label, including on a new pull request, `pocp approve`, `--accept-*`), and switching checks off on GitHub without a pull request (`pocp ci off`, `pocp init --local`, `gh workflow disable`, `--disable-billing-failed`). Each refusal tells Claude what to do instead.
- **Teaches the workflow.** A skill shows Claude how to open a packet, prove a change with `pocp fix`, and when to hand a decision to you.

In a repository without POCP, the hook does nothing, unless the command is aimed at one that has it (`cd <repo> && …` or `git -C <repo> …`). The plugin reads and sends nothing over the network. The hook is one dependency-free script, [scripts/guard.mjs](scripts/guard.mjs), that reads the command Claude is about to run and checks for `.proof/rules.json`.

## Limits

The hook guards against an agent cutting corners, not one set on hiding what it does. A command built at run time, for example with `eval` or a script file, isn't read. CI re-running every check is what enforces POCP. POCP doesn't prove your code is correct.

## Requirements

Git, Node 20 or later, and a POSIX shell. POCP works with any test command and any language.

MIT licensed. Full documentation: [github.com/harriswekselblatt/pocp](https://github.com/harriswekselblatt/pocp).
