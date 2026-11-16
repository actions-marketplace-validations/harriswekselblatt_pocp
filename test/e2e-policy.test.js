// Policy integrity in CI: a pull request can't loosen the rules it is judged by, however it
// phrases the change.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { git, packetId, pocp, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, commit } from './fixtures.js';
import { policyWeakening, strictUnion } from '../src/rules.js';
import { configWeakening, rulesWithDefaults, strictConfig, withDefaults } from '../src/store.js';

test('narrowing a requirement\'s glob is a loosening, and the base glob still applies', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  // Same check, but it now guards a folder that doesn't exist; the broken code escapes it.
  writeRules(dir, { triggers: { globs: [] }, requirements: [
    { id: 'math-tests', glob: 'src/none/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' },
  ] });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'narrow', '--touch', '.proof/rules.json', '--command', 'true']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(commit(dir, 'narrow the rule').status, 0, 'passes locally, by its own rules');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun-unsigned', '--json']);
  assert.equal(v.code, 1);
  const c = v.json.commits[0];
  assert.ok(c.policy.weakened.some((w) => /requirement "math-tests" no longer guards "src\/\*\*"/.test(w)), c.policy.weakened.join('; '));
  assert.ok(c.coverage.uncovered.includes('src/math.js'), 'the base glob still requires a packet for src/math.js');
  // Once approved, the head's rules are in force.
  const ok = pocp(dir, ['verify', `${base}..HEAD`, '--rerun-unsigned', '--accept-policy-change', '--json']);
  assert.equal(ok.json.commits[0].policy.accepted, true);
});

test('strict union keeps every glob a check guarded in the base', () => {
  const base = rulesWithDefaults({ requirements: [{ id: 'a', globs: ['src/**', 'lib/**'], obligation: { kind: 'test', run: 't' } }] });
  const head = rulesWithDefaults({ requirements: [{ id: 'a', glob: 'src/**', obligation: { kind: 'test', run: 't' } }] });
  const u = strictUnion(base, head);
  assert.equal(u.requirements.length, 1, 'merged into the head requirement, not duplicated');
  assert.deepEqual(u.requirements[0].globs, ['src/**', 'lib/**']);
  assert.deepEqual(policyWeakening(base, head), ['requirement "a" no longer guards "lib/**"']);
  // Moving a glob to another requirement with the same check is not a loosening.
  const split = rulesWithDefaults({ requirements: [
    { id: 'a', glob: 'src/**', obligation: { kind: 'test', run: 't' } },
    { id: 'b', glob: 'lib/**', obligation: { kind: 'test', run: 't' } },
  ] });
  assert.deepEqual(policyWeakening(base, split), []);
  // Widening is fine.
  const wider = rulesWithDefaults({ requirements: [{ id: 'a', globs: ['src/**', 'lib/**', 'bin/**'], obligation: { kind: 'test', run: 't' } }] });
  assert.deepEqual(policyWeakening(base, wider), []);
});

test('replacing the test guard\'s globs is a loosening; the base globs stay in force', () => {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'block' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'block mode');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeConfig(dir, { guard: { tests: 'block', test_globs: ['nothing/**'] } });
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'hide the gutted test');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(v.code, 1);
  const codes = v.json.commits[0].findings.map((f) => f.code);
  assert.ok(codes.includes('policy_loosened'), codes.join(','));
  assert.ok(codes.includes('test_change'), 'the gutted test is still guarded');
  assert.match(v.json.commits[0].policy.weakened.join(' '), /guard no longer treats "test\/\*\*" as a test file/);
});

test('config weakening: guard globs, area depth, environment', () => {
  const base = withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A'] } });
  assert.deepEqual(configWeakening(base, withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A'] } })), []);
  assert.deepEqual(configWeakening(base, withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A'] }, guard: { extra_test_globs: ['spec/**'] } })), [], 'adding guard globs is stricter');
  const w = configWeakening(base, withDefaults({ area_depth: 1, run: { env: 'inherit' }, guard: { runner_globs: [] } }));
  assert.ok(w.includes('area_depth lowered from 2'));
  assert.ok(w.includes('run.env changed from "minimal" to "inherit"'));
  assert.ok(w.some((x) => /guard no longer treats "\*\*\/jest\.config\.\*" as test setup/.test(x)));
  assert.deepEqual(configWeakening(base, withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A', 'SECRET'] } })), ['run.env_allow gained "SECRET"']);
  const s = strictConfig(base, withDefaults({ area_depth: 1, run: { env: 'inherit', env_allow: ['A', 'SECRET'] }, guard: { test_globs: ['spec/**'] } }));
  assert.equal(s.area_depth, 2);
  assert.equal(s.run.env, 'minimal');
  assert.deepEqual(s.run.env_allow, ['A']);
  assert.ok(s.guard.test_globs.includes('test/**') && s.guard.test_globs.includes('spec/**'));
});

test('verify says who acts first; a maintainer\'s label step names the pull request and pocp approve', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { triggers: { globs: [] }, requirements: [
    { id: 'math-tests', glob: 'src/none/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' },
  ] });
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'narrow', '--touch', '.proof/rules.json', '--command', 'true']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(commit(dir, 'narrow the rule').status, 0);
  const summary = path.join(dir, '.git', 'summary.md');
  const pr = { GITHUB_REF: 'refs/pull/12/merge', GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: summary };
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun-unsigned'], { env: pr });
  assert.equal(v.code, 1);
  const step = v.stdout.split('\n').find((l) => /policy_loosened/.test(l) && /next:/.test(l));
  assert.match(step, /^ {4}\[maintainer, not the author\] policy_loosened: .*next: a maintainer reviews it and adds the `pocp-approve-policy` label to o\/r#12 \(or runs: pocp approve o\/r#12\)$/);
  // pocp approve is only ever the maintainer's step, never the author's.
  for (const l of v.stdout.split('\n').filter((x) => /pocp approve/.test(x))) assert.match(l, /\[maintainer, not the author\]/);
  assert.match(fs.readFileSync(summary, 'utf8'), /- \*\*maintainer, not the author\*\* · `policy_loosened`: .*pocp approve o\/r#12/);
  const j = pocp(dir, ['verify', `${base}..HEAD`, '--rerun-unsigned', '--json'], { env: { ...pr, GITHUB_STEP_SUMMARY: '' } });
  const s = j.json.next_steps.find((x) => x.code === 'policy_loosened');
  assert.deepEqual(Object.keys(s), ['by', 'code', 'why', 'next'], 'who acts comes first');
  assert.equal(s.by, 'person');
  // Outside a pull request, no number is guessed.
  assert.match(pocp(dir, ['verify', `${base}..HEAD`, '--rerun-unsigned']).stdout, /to the pull request \(or runs: pocp approve owner\/repo#<number>\)/);
});

// Every policy_loosened finding in a range verify: per commit, the net change, the range.
const loosenedAt = (j) => [
  ...j.commits.map((c, i) => (c.findings.some((f) => f.code === 'policy_loosened') ? `commit ${i}` : null)),
  j.net?.findings?.some((f) => f.code === 'policy_loosened') ? 'net' : null,
  j.findings.some((f) => f.code === 'policy_loosened') ? 'range' : null,
].filter(Boolean);
const quiet = (dir, ...args) => git(dir, '-c', 'core.hooksPath=/dev/null', ...args);
const commitDoc = (dir, name) => {
  write(dir, `docs/${name}.md`, `${name}\n`);
  git(dir, 'add', '-A');
  quiet(dir, 'commit', '-q', '-m', `docs: ${name}`);
};
const setConfig = (dir, edit) => {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.proof/config.json'), 'utf8'));
  edit(cfg);
  write(dir, '.proof/config.json', `${JSON.stringify(cfg, null, 2)}\n`);
  git(dir, 'add', '-A');
};

test('the base tightening its policy while a pull request is open is not the pull request loosening it', () => {
  // PR #87's shape: its first commits predate the base adding ci.reporter_app_id and never
  // touch the config; it then merges the base, so its net change loosens nothing.
  const dir = sampleRepo({ hooks: true });
  quiet(dir, 'checkout', '-q', '-b', 'feature');
  commitDoc(dir, 'one');
  commitDoc(dir, 'two');
  quiet(dir, 'checkout', '-q', 'main');
  setConfig(dir, (c) => { c.ci = { ...c.ci, reporter_app_id: 12345 }; });
  quiet(dir, 'commit', '-q', '-m', 'name the reporter app');
  quiet(dir, 'checkout', '-q', 'feature');
  quiet(dir, 'merge', '-q', '--no-edit', 'main');
  commitDoc(dir, 'three');
  const v = pocp(dir, ['verify', 'main..HEAD', '--json']);
  assert.equal(v.json.commits.length, 3);
  assert.deepEqual(loosenedAt(v.json), [], JSON.stringify(v.json.commits.map((c) => c.policy.weakened)));
  // The earlier commits are still judged under the base's rules.
  assert.equal(v.json.commits[0].policy.from, git(dir, 'rev-parse', 'main'));
});

test('a loosening kept to the head still needs approval, even when later commits don\'t touch policy', () => {
  const dir = sampleRepo({ hooks: true });
  setConfig(dir, (c) => { c.guard = { ...c.guard, tests: 'block' }; });
  quiet(dir, 'commit', '-q', '-m', 'block mode');
  quiet(dir, 'checkout', '-q', '-b', 'feature');
  setConfig(dir, (c) => { c.guard.tests = 'warn'; });
  quiet(dir, 'commit', '-q', '-m', 'lower the guard');
  commitDoc(dir, 'after');
  const v = pocp(dir, ['verify', 'main..HEAD', '--json']);
  assert.equal(v.code, 1);
  assert.deepEqual(loosenedAt(v.json), ['commit 0', 'commit 1'], 'the loosening commit and the head both answer for it');
  assert.match(v.json.commits[1].policy.weakened.join(' '), /guard\.tests lowered from "block" to "warn"/);
  const ok = pocp(dir, ['verify', 'main..HEAD', '--accept-policy-change', '--json']);
  assert.deepEqual(loosenedAt(ok.json), []);
  assert.deepEqual(ok.json.commits.map((c) => c.policy.accepted), [true, true], 'once approved, the head\'s policy judges every commit');
});

test('a loosening reverted later in the pull request is still flagged at the commit that made it', () => {
  const dir = sampleRepo({ hooks: true });
  setConfig(dir, (c) => { c.guard = { ...c.guard, tests: 'block' }; });
  quiet(dir, 'commit', '-q', '-m', 'block mode');
  quiet(dir, 'checkout', '-q', '-b', 'feature');
  setConfig(dir, (c) => { c.guard.tests = 'warn'; });
  quiet(dir, 'commit', '-q', '-m', 'lower the guard');
  setConfig(dir, (c) => { c.guard.tests = 'block'; });
  quiet(dir, 'commit', '-q', '-m', 'restore the guard');
  const v = pocp(dir, ['verify', 'main..HEAD', '--json']);
  assert.deepEqual(loosenedAt(v.json), ['commit 0']);
});
