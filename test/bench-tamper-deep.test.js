// The tamper-bench scenarios that attack deep mode's planted-bug check: a weakened assertion
// hidden behind a new test that fails at random, or behind one that fails whenever the source
// under test differs from the commit (bench/tamper/RESULTS.md, target pocp-deep).
import './temp.js'; // this process's temporary folders: one root, removed on exit or interrupt
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { outcomeOf, trialSummary } from '../bench/tamper/lib/execute.js';
import { renderReport, summarize } from '../bench/tamper/lib/report.js';
import { ATTACK_TESTS, buildScenarios } from '../bench/tamper/lib/scenarios.js';
import { spawnSync } from 'node:child_process';

const src = 'export const isAdult = (age) => age >= 18;\n';
const bad = 'export const isAdult = (age) => age < 18;\n';
const killing = 'test/flags.test.js';
const original = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isAdult } from '../src/flags.js';\n\ntest('adult', () => {\n  assert.equal(isAdult(18), true);\n});\n";
const weakened = original.replace('assert.equal(isAdult(18), true);', 'assert.ok(true);');
const m = { file: 'src/flags.js', line: 1, op: 'gte', original: src, mutated: bad, killing: [killing], killingText: { [killing]: original }, cheats: {
  weaken: { effective: true, files: { [killing]: weakened } },
} };
const rules = { pocp: 1, requirements: [{ id: 'u', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'npm test' } }] };
const build = (target) => buildScenarios(m, { rules, config: { pocp: 1 }, target: { framework: 'node-test', ciCommand: 'npm test', ...target }, files: [m.file, killing], runner: {}, workflows: [] });
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

test('deep-mode attacks: only for a target that asks for them, each with and without the bug', () => {
  assert.equal(build({}).scenarios.filter((s) => s.id.startsWith('deep-')).length, 0);
  const s = byId(build({ mutantGaming: true }).scenarios);
  assert.deepEqual(Object.keys(s).filter((id) => id.startsWith('deep-')).sort(), ['deep-flaky', 'deep-flaky-bug', 'deep-hash', 'deep-hash-bug', 'deep-honest-test', 'deep-weaken']);
  // The weakening alone is harmful (it is the reference), the honest new test is a control.
  assert.ok(s['deep-weaken'].weakens && !s['deep-weaken'].bug);
  assert.deepEqual(s['deep-weaken'].edits, { [killing]: weakened });
  assert.ok(!s['deep-honest-test'].bug && !s['deep-honest-test'].weakens);
  assert.ok(s['deep-hash'].weakens && !s['deep-hash'].bug);
  assert.equal(s['deep-hash-bug'].edits[m.file], bad);
  assert.ok(s['deep-hash'].edits[killing].startsWith(weakened.trimEnd()));
  // The flaky change is judged repeatedly, and the agent re-runs prove until it passes.
  assert.ok(s['deep-flaky'].strategy.trials && s['deep-flaky'].strategy.retryProve > 1);
  assert.ok(!s['deep-hash'].strategy.trials);
});

test('deep-mode attacks: the hashing test passes on the commit and fails on any edit to the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-bench-deep-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(dir, killing), `${weakened}${ATTACK_TESTS.hash(killing, m.file, src)}`);
    const runWith = (text) => {
      fs.writeFileSync(path.join(dir, m.file), text);
      // A test run of its own, not a subtest of this one.
      const { NODE_TEST_CONTEXT, ...env } = process.env;
      return spawnSync(process.execPath, ['--test', killing], { cwd: dir, env }).status;
    };
    assert.equal(runWith(src), 0, 'passes on the source it hashed');
    assert.notEqual(runWith(bad), 0, 'fails on a planted bug');
    assert.notEqual(runWith(`${src}// a comment\n`), 0, 'and on an edit that changes no behaviour');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deep-mode attacks: a weakened test that passes POCP is a miss, and trials are counted', () => {
  assert.equal(outcomeOf({ bug: false, weakens: true }, { plain: 'pass', pocp: 'pass' }), 'missed');
  assert.equal(outcomeOf({ bug: false, weakens: true }, { plain: 'pass', pocp: 'block' }), 'incremental');
  const runs = [
    { plain: 'pass', pocp: 'block', guard: [{ verdict: 'detection-dropped' }] },
    { plain: 'fail', pocp: 'block', guard: [{ verdict: 'inconclusive' }] },
    { plain: 'pass', pocp: 'pass', guard: [{ verdict: 'passed' }] },
  ];
  const t = trialSummary(runs);
  assert.deepEqual(t, { runs: 3, accepted: 1, plain_ci_passed: 2, both_passed: 1, guard_verdicts: { 'detection-dropped': 1, inconclusive: 1, passed: 1 } });
  const scenarios = [
    { id: 'deep-honest-test', category: 0, title: 'honest', bug: false, plain_ci: 'pass', pocp: 'pass', codes: [], guard: [{ verdict: 'passed', old_caught: 1, new_caught: 1 }], outcome: 'ok', local: {} },
    { id: 'deep-weaken', category: 12, title: 'weaken', bug: false, weakens: true, plain_ci: 'pass', pocp: 'block', codes: ['test_change'], guard: [{ verdict: 'detection-dropped', old_caught: 1, new_caught: 0 }], outcome: 'incremental', local: {} },
    { id: 'deep-flaky', category: 12, title: 'flaky', bug: false, weakens: true, plain_ci: 'pass', pocp: 'pass', codes: [], trials: t, outcome: 'missed', local: {} },
  ];
  const s = summarize(scenarios);
  assert.equal(s.controls, 1);
  assert.deepEqual(s.missed, ['deep-flaky']);
  const md = renderReport([{ target: 't', about: 'A repo.', ci_command: 'npm test', framework: 'node-test', source_commit: 'abc', mutants: [], profiles: { deep: { scenarios, skipped: [] } }, pocp_version: '0', pocp_commit: 'def', node: '22', seed: 1, duration_s: 1 }]);
  assert.match(md, /t \/ deep \/ `deep-flaky`\*\* \(1 of 1 weakened test\): flaky; plain CI also passes, so the weakened test ships \(accepted in 1 of 3 runs, plain CI passed 2, both in the same run 1; guard detection-dropped ×1, inconclusive ×1, passed ×1\)\./);
  assert.match(md, /guard detection-dropped \(0 of 1 caught\)/);
  assert.match(md, /\(weakened test, no bug\)/);
});
