#!/usr/bin/env node
// PreToolUse hook for Claude's Bash tool, in repositories that use POCP (.proof/rules.json).
// It refuses the commands that go around POCP rather than through it, and says what to do
// instead. It guards against an agent cutting corners, not one set on hiding what it does: a
// command built at run time (eval, a script file) isn't read.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event = {};
try {
  event = JSON.parse(input || '{}');
} catch {
  process.exit(0);
}
if (event.tool_name !== 'Bash') process.exit(0);
const raw = String(event.tool_input?.command || '');
const cwd = event.cwd || process.cwd();
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).stdout?.trim();
if (!root || !fs.existsSync(path.join(root, '.proof', 'rules.json'))) process.exit(0);

// The command without its quoted strings, so a commit message mentioning "-n" isn't a flag.
const bare = raw.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
// One command of a pipeline or list: up to the next ; & | or newline.
const SEG = String.raw`[^;&|\n]*`;

const RULES = [
  {
    test: () => new RegExp(String.raw`\bgit\b${SEG}\bcommit\b${SEG}(--no-verify\b|\s-[A-Za-z]*n[A-Za-z]*\b)`).test(bare),
    why: '`git commit --no-verify` skips POCP\'s gate, and CI then fails the commit as uncovered.',
    instead: 'Run `pocp fix --intent "<what the change does>"`, then commit normally.',
  },
  {
    test: () => /core\.hookspath/i.test(raw),
    why: 'Changing core.hooksPath turns off POCP\'s git hooks.',
    instead: 'Commit through the hooks: `pocp fix --intent "<what the change does>"`, then `git commit`.',
  },
  {
    test: () => new RegExp(String.raw`\bgit\b${SEG}\bpush\b${SEG}(--force(-with-lease)?\b|\s-[A-Za-z]*f[A-Za-z]*\b|\s\+[^\s]+)`).test(bare),
    why: 'A force-push rewrites proven commits, which invalidates their proofs.',
    instead: 'Push new commits on top. To bring in the base branch, merge it rather than rebasing.',
  },
  {
    test: () => /pocp-approve-/.test(raw) && (/--add-label\b/.test(raw) || (/\bgh\s+api\b/.test(raw) && /labels/.test(raw))),
    why: 'POCP approval labels are a person\'s decision; an agent adding one approves its own change.',
    instead: 'Push the change and tell the user which label it needs and why. They add it.',
  },
  {
    test: () => /\bpocp\s+approve\b/.test(bare) || new RegExp(String.raw`\bapprovals\b${SEG}--approve\b`).test(bare),
    why: '`pocp approve` is for a person at a terminal, not an agent.',
    instead: 'Run `pocp approvals` to list what is waiting, and ask the user to approve.',
  },
  {
    test: () => /--accept-(test-change|policy-change|uncovered|inconclusive)\b/.test(bare),
    why: 'The --accept-* flags record a maintainer\'s approval; an agent passing them approves its own change.',
    instead: 'Run verify without them and report what it says is waiting for a person.',
  },
  {
    test: () => new RegExp(String.raw`\bgh\s+pr\s+merge\b${SEG}--admin\b`).test(bare),
    why: '`gh pr merge --admin` merges past the required checks, POCP\'s included.',
    instead: 'Use `gh pr merge --auto` so it merges once the checks pass.',
  },
  {
    test: () => new RegExp(String.raw`\bpocp\b${SEG}\bhooks\s+uninstall\b`).test(bare),
    why: 'Uninstalling POCP\'s hooks turns off its gate.',
    instead: 'Leave the hooks in place; ask the user if they want them removed.',
  },
  // Switches on GitHub's side that take effect at once, with no pull request for anyone to review:
  // a workflow disabled while billing blocks it stays disabled, and its checks silently stop.
  {
    test: () => new RegExp(String.raw`\bpocp\b${SEG}\bci\s+off\b`).test(bare) || new RegExp(String.raw`\bpocp\b${SEG}\binit\b${SEG}--local\b`).test(bare),
    why: 'Switching to local mode turns off POCP\'s checks on GitHub at once, with no pull request to review.',
    instead: 'Ask the user to run it themselves if they want local mode.',
  },
  {
    test: () => /--disable-billing-failed\b/.test(bare)
      || new RegExp(String.raw`\bgh\s+workflow\s+disable\b`).test(bare)
      || (/\bgh\s+api\b/.test(raw) && /actions\/workflows\/[^\s'"]+\/disable\b/.test(raw)),
    why: 'Disabling a GitHub workflow stops its checks at once, with no pull request to review, and it stays off after the cause is fixed.',
    instead: 'Tell the user which workflows fail and why, and ask them to run the command themselves (`pocp doctor` lists them).',
  },
];

const hit = RULES.find((r) => r.test());
if (hit) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `POCP: ${hit.why} ${hit.instead}`,
    },
  }));
}
process.exit(0);
