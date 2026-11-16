// A rule's check settings (cwd, timeout_ms, inputs, ...) reach every place that runs the
// check, not just its command. The new-user walkthrough found a test-only edit losing `cwd`:
// `pocp fix` borrowed the rule's command for the packet and left its folder behind, so the
// check ran at the repository root and couldn't start.
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sampleRepo, write, writeConfig } from './helpers.js';
import { fallbackCheck } from '../src/fix.js';
import { runGuardCheck } from '../src/guard-check.js';
import { normalizeObligation } from '../src/obligations.js';
import { createRun } from '../src/engine/run.js';
import { createRerun } from '../src/engine/rerun.js';

// The check runs in test/ and names its file relative to it: at the root it can't start.
const RULE = { kind: 'test', run: 'node math.check.mjs', cwd: 'test', timeout_ms: 120000, inputs: ['test/**'] };
const SETTINGS = ['cwd', 'timeout_ms', 'inputs'];

function subfolderRepo(mode) {
  const dir = sampleRepo({
    hooks: true,
    rules: { triggers: { globs: [] }, requirements: [{ id: 'math-tests', glob: 'src/**', obligation: RULE, source: 'author' }] },
  });
  writeConfig(dir, { guard: { tests: mode, mutants: 4 } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'check runs in test/');
  return dir;
}

// One more assertion: an honest test edit that only adds coverage.
const addAssertion = (dir) => write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "if (add(-2, 2) !== 0) { console.error('add broken'); process.exit(1); }\nconsole.log('math ok');"));

test("a commit that edits only a test keeps the rule's cwd", () => {
  const dir = subfolderRepo('block');
  addAssertion(dir);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'cover adding to zero', '--json']);
  const opened = f.json?.actions.find((a) => a.action === 'open');
  assert.ok(opened, f.stdout + f.stderr);
  const ob = JSON.parse(read(dir, `.proof/packets/${opened.packet}.json`)).obligations.find((o) => o.kind === 'test');
  for (const k of SETTINGS) assert.deepEqual(ob[k], RULE[k], `the packet's check keeps ${k}`);
  const proved = f.json.actions.find((a) => a.action === 'prove');
  assert.deepEqual(proved.failed.filter((x) => x.obligation === ob.id), [], 'the check runs in test/ and passes');
  assert.ok(!f.json.needs_agent.some((x) => x.code === 'unfinished_proof' || x.code === 'failed_proof'), JSON.stringify(f.json.needs_agent));
});

test('fix borrows the whole rule check, and never merges two rules that differ only in a setting', () => {
  const rules = (reqs) => ({ config: () => ({}), rules: () => ({ requirements: reqs }) });
  const req = (id, obligation) => ({ id, glob: 'src/**', obligation });
  const one = fallbackCheck(rules([req('a', { ...RULE, changed_test_command: ['node', '--test', '{tests}'] })]));
  assert.deepEqual(one.obligation, { ...RULE, changed_test_command: ['node', '--test', '{tests}'] });
  // Same command in two folders: the one more rules require wins, with its own folder.
  const two = fallbackCheck(rules([req('a', { kind: 'test', run: 'npm test', cwd: 'api' }), req('b', { kind: 'test', run: 'npm test', cwd: 'web' }), req('c', { kind: 'test', run: 'npm test', cwd: 'web' })]));
  assert.equal(two.obligation.cwd, 'web');
  // --test and verify.require_ci are plain commands, run at the root.
  assert.deepEqual(fallbackCheck(rules([req('a', RULE)]), 'make check').obligation, { kind: 'test', run: 'make check' });
  assert.deepEqual(fallbackCheck({ config: () => ({ verify: { require_ci: ['npm test'] } }), rules: () => ({ requirements: [req('a', RULE)] }) }).obligation, { kind: 'test', run: 'npm test' });
  // What it borrows is a valid obligation with every setting the rule set.
  const ob = normalizeObligation(one.obligation, { id: 'o1' });
  for (const k of SETTINGS) assert.deepEqual(ob[k], RULE[k]);
});

test("the guard's changed-tests run carries the check's settings, not just its folder", async () => {
  // A fake runner: records what each run was given, and passes with one test counted.
  const seen = [];
  const runObligation = async (ob, _dir, opts) => {
    if (/-changed-/.test(opts?.logName || '')) seen.push(ob);
    return { exit: 0, passed: true, output: '# tests 1\n# pass 1\n# fail 0\n', duration_ms: 1 };
  };
  const dir = subfolderRepo('block');
  addAssertion(dir);
  git(dir, 'add', '-A');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const check = normalizeObligation({ ...RULE, changed_test_command: ['node', '{tests}'], expect: undefined }, { id: 'math-tests', source: 'rule:math-tests' });
  await runGuardCheck({
    root: dir, runObligation, base, rev: null, mutants: 0, seed: 1,
    changes: [{ path: 'test/math.check.mjs', kind: 'test', status: 'M' }],
    checks: [check], sourceGlobs: ['src/**'], links: [], exclude: [], guardGlobs: { test: ['test/**'] }, logPrefix: 't',
  });
  assert.ok(seen.length, 'the edited tests ran on their own');
  for (const o of seen) {
    assert.equal(o.run, 'node math.check.mjs', 'the file is named relative to the check folder');
    for (const k of SETTINGS) assert.deepEqual(o[k], RULE[k], `the changed-tests run keeps ${k}`);
  }
});

// Every run the guard makes, by its log name: t-new-…, t-old-…, t-base-…, t-m0-old-…(-retry).
async function guardRuns({ fail = () => false, mutants = 0 } = {}) {
  const runs = [];
  const runObligation = async (ob, _dir, opts) => {
    const name = opts?.logName || '';
    runs.push({ name, ob });
    // The first mutant run times out once, so its retry runs too.
    if (name === 't-m0-old-math-tests' && runs.filter((r) => r.name === name).length === 1) return { exit: null, passed: false, timed_out: true, output: '', duration_ms: 5 };
    return fail(name) ? { exit: 1, passed: false, output: 'not ok 1 - add\n# fail 1\n', duration_ms: 1 } : { exit: 0, passed: true, output: 'ok\n', duration_ms: 1 };
  };
  const dir = subfolderRepo('block');
  addAssertion(dir);
  git(dir, 'add', '-A');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const check = normalizeObligation(RULE, { id: 'math-tests', source: 'rule:math-tests' });
  await runGuardCheck({
    root: dir, runObligation, base, rev: null, mutants, seed: 1,
    changes: [{ path: 'test/math.check.mjs', kind: 'test', status: 'M' }],
    checks: [check], sourceGlobs: ['src/**'], links: [], exclude: [], guardGlobs: { test: ['test/**'] }, logPrefix: 't',
  });
  return runs;
}
const keepsSettings = (runs, { timeout = true } = {}) => {
  for (const { name, ob } of runs) {
    assert.equal(ob.run, RULE.run, name);
    for (const k of SETTINGS) if (k !== 'timeout_ms' || timeout) assert.deepEqual(ob[k], RULE[k], `${name} keeps ${k}`);
  }
};

test("every guard run keeps the check's settings: both baselines, the mutants and their retries", async () => {
  const runs = await guardRuns({ mutants: 2 });
  for (const side of ['-new-', '-old-', '-m0-old-']) assert.ok(runs.some((r) => r.name.includes(side)), `ran ${side}: ${runs.map((r) => r.name)}`);
  const retries = runs.filter((r) => r.name.endsWith('-retry'));
  assert.ok(retries.length, 'a mutant run that timed out was retried');
  keepsSettings(runs.filter((r) => !r.name.endsWith('-retry')));
  // A retry raises only the time limit: everything else is the check as written.
  keepsSettings(retries, { timeout: false });
  for (const r of retries) assert.ok(Number.isInteger(r.ob.timeout_ms) && r.ob.timeout_ms > 0);
});

test("the guard's base-code check keeps the check's settings", async () => {
  const runs = await guardRuns({ fail: (name) => name.includes('-old-') });
  assert.ok(runs.some((r) => r.name.includes('-base-')), `ran the base check: ${runs.map((r) => r.name)}`);
  keepsSettings(runs);
});

test("the guard checks a rule requires are the rule's whole check", () => {
  const { guardInputs } = createRun({ root: '/nonexistent', store: { kind: 'none' }, VERSION: 'test', config: () => ({}), runner: {} });
  const obligation = normalizeObligation({ ...RULE, changed_test_command: ['node', '{tests}'] }, { source: 'rule:math-tests' });
  const required = [{ id: 'math-tests', digest: 'd1', globs: ['src/**'], obligation }];
  const { checks } = guardInputs({ obligations: [], touches: [] }, required);
  assert.deepEqual(checks, [{ ...obligation, id: 'math-tests' }]);
});

test('running a check gives the runner its folder, time limit and environment', async () => {
  const calls = [];
  const cfg = { run: { env: 'inherit', env_allow: ['KEEP_ME'], timeout_ms: 600000, kill_grace_ms: 1234, log_cap_bytes: 99 } };
  const { runObligation } = createRun({ root: '/r', store: { kind: 'none' }, VERSION: 'test', config: () => cfg, runner: { run: async (cmd, opts) => (calls.push({ cmd, opts }), { exit: 0, output: '' }) } });
  await runObligation(normalizeObligation(RULE, { id: 'o1' }), '/snap');
  await runObligation(normalizeObligation({ kind: 'test', run: 'make check' }, { id: 'o2' }), '/snap');
  assert.equal(calls[0].cmd, RULE.run);
  assert.equal(calls[0].opts.cwd, path.join('/snap', 'test'));
  assert.equal(calls[0].opts.root, '/snap', 'an isolated run copies the whole snapshot, and runs inside it in the folder');
  assert.equal(calls[0].opts.timeoutMs, RULE.timeout_ms);
  assert.deepEqual(calls[0].opts.envAllow, ['KEEP_ME']);
  assert.equal(calls[0].opts.env.POCP_OBLIGATION, 'o1');
  assert.equal(calls[0].opts.killGraceMs, 1234);
  assert.equal(calls[1].opts.cwd, '/snap');
  assert.equal(calls[1].opts.timeoutMs, 600000, "no timeout_ms: the config's");
});

test("verify's re-run of a packet's check keeps its settings", async () => {
  const dir = subfolderRepo('block');
  const commit = git(dir, 'rev-parse', 'HEAD').trim();
  const ran = [];
  const { rerunAt } = createRerun({ root: dir, runObligation: async (ob, d) => (ran.push({ ob, d }), { exit: 0, passed: true, duration_ms: 1 }), flagProblem: () => null, runnerIdentity: () => ({}) });
  const ob = normalizeObligation(RULE, { id: 'o1', source: 'rule:math-tests' });
  const into = [];
  assert.deepEqual(await rerunAt(commit, [{ id: 'p-1', obligations: [ob] }], { links: [], into }), []);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].ob, ob);
  assert.equal(into[0].cwd, 'test', "the record says where it ran");
});

test("a source change gets the rule's whole check in its packet, and proves it in the rule's folder", () => {
  const dir = subfolderRepo('block');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'commutative add', '--json']);
  assert.equal(f.code, 0, f.stdout + f.stderr);
  const opened = f.json.actions.find((a) => a.action === 'open');
  const ob = JSON.parse(read(dir, `.proof/packets/${opened.packet}.json`)).obligations.find((o) => o.kind === 'test');
  for (const k of SETTINGS) assert.deepEqual(ob[k], RULE[k], `the packet's check keeps ${k}`);
  // Widening to another file adds nothing new and keeps the check as it was.
  write(dir, 'src/extra.js', 'export const one = 1;\n');
  git(dir, 'add', '-A');
  const w = pocp(dir, ['fix', '--json']);
  assert.equal(w.code, 0, w.stdout + w.stderr);
  const after = JSON.parse(read(dir, `.proof/packets/${opened.packet}.json`)).obligations.filter((o) => o.kind === 'test');
  for (const o of after) for (const k of SETTINGS) assert.deepEqual(o[k], RULE[k], `after widening, ${o.id} keeps ${k}`);
});

test("a ci-run result in the check's folder stands in for it, however the folder is written", () => {
  const dir = subfolderRepo('block');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'commutative add']).code, 0);
  git(dir, 'commit', '-q', '-m', 'commutative add');
  const results = path.join(dir, '..', `${path.basename(dir)}-ci.jsonl`);
  const ci = pocp(dir, ['ci-run', '--results', results, '--dir', 'test/', '--', 'node', 'math.check.mjs']);
  assert.equal(ci.code, 0, ci.stdout + ci.stderr);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--ci-results', results, '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.json.reruns[0].status, /passing CI result/, '"test/" is the rule\'s "test"');
  // A folder outside the repository is refused, as it is in a rule.
  assert.notEqual(pocp(dir, ['ci-run', '--results', results, '--dir', '../elsewhere', '--', 'true']).code, 0);
});
