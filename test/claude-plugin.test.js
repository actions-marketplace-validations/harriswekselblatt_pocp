// The Claude Code plugin (plugins/pocp, listed by .claude-plugin/marketplace.json): its guard
// refuses the commands that go around POCP in a repository that uses it, and lets everything
// else through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleRepo, tmpRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'pocp');
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// The decision the guard returns for one Bash command run in `cwd`: 'deny' or 'allow'.
function decide(cwd, command, tool = 'Bash') {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'guard.mjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: 'allow' };
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

const DENIED = [
  'git commit --no-verify -m "x"',
  'git commit -nm "x"',
  'git add -A && git commit -n',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git config core.hooksPath /dev/null',
  'git push --force',
  'git push -f origin feature',
  'git push --force-with-lease origin feature',
  'git push origin +main',
  'gh pr edit 12 --add-label pocp-approve-tests',
  'gh pr edit 12 -R o/r --add-label "pocp-approve-policy"',
  'gh api repos/o/r/issues/12/labels -f "labels[]=pocp-approve-tests"',
  'pocp approve o/r#12',
  'npx pocp approvals --approve',
  'pocp verify main..HEAD --rerun --accept-test-change=abc123',
  'pocp verify main..HEAD --rerun --accept-policy-change abc123',
  'gh pr merge 12 --admin',
  'npx pocp hooks uninstall',
];

const ALLOWED = [
  'git commit -m "fix: drop the --no-verify and -n advice from the docs"',
  'git commit -am "x"',
  'git push',
  'git push origin feature',
  'gh pr edit 12 --remove-label pocp-approve-tests',
  'gh pr view 12 --json labels',
  'pocp verify main..HEAD --require-coverage --rerun',
  'pocp approvals',
  'pocp fix --intent "add a note"',
  'gh pr merge 12 --merge --auto',
  'npm test',
];

test('in a repository that uses POCP, the guard refuses commands that go around it, and says what to do instead', () => {
  const dir = sampleRepo({ deep: false });
  for (const command of DENIED) {
    const d = decide(dir, command);
    assert.equal(d.decision, 'deny', command);
    assert.match(d.reason, /^POCP: .+\. .+/, command);
  }
});

test('in a repository that uses POCP, ordinary commands pass', () => {
  const dir = sampleRepo({ deep: false });
  for (const command of ALLOWED) assert.equal(decide(dir, command).decision, 'allow', command);
});

test('outside a POCP repository, and for tools other than Bash, the guard does nothing', () => {
  const plain = tmpRepo();
  for (const command of DENIED) assert.equal(decide(plain, command).decision, 'allow', command);
  assert.equal(decide(sampleRepo({ deep: false }), 'git commit --no-verify', 'Edit').decision, 'allow');
});

test('the marketplace lists the plugin; names and the version stay in step with the package', () => {
  const market = json(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  const plugin = json(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace lists the plugin by its manifest name');
  assert.equal(path.resolve(ROOT, entry.source), PLUGIN);
  assert.equal(plugin.version, json(path.join(ROOT, 'package.json')).version);
  const hooks = json(path.join(PLUGIN, 'hooks', 'hooks.json')).hooks.PreToolUse[0];
  assert.equal(hooks.matcher, 'Bash');
  assert.match(hooks.hooks[0].args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard\.mjs$/);
});

test("the plugin's skill teaches the same workflow as examples/agent-instructions.md", () => {
  const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'pocp', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: pocp\ndescription: .+\n---\n/);
  const instructions = fs.readFileSync(path.join(ROOT, 'examples', 'agent-instructions.md'), 'utf8');
  assert.equal(body(skill), instructions.slice(instructions.indexOf('\n---\n') + 5).trim());
});
