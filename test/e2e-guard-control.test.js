// Deep mode's control run (SPEC §6.2). A new test that fails on planted mutants without checking
// behavior "catches" them all, so it could hide a weakened assertion: one that hashes the source
// it tests, or one that fails at random (bench/tamper, target pocp-deep: both were accepted).
// Before a pass, the new tests run once more on a copy of the new code that differs only by a
// blank line in each file a mutant was planted in; a failure there makes the result inconclusive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neutralEdit, runGuardCheck } from '../src/guard-check.js';
import { createProcessRunner } from '../src/runner.js';
import { git, write } from './helpers.js';

// Mutation sites: line 2 `a + b` (plus), line 6 `n > 0` (gt, zero-one). ADD catches the first,
// POSITIVE the other two, so weakening POSITIVE loses two of three.
const MATH = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';
const ADD = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n";
const POSITIVE = "import { isPositive } from '../src/math.js';\nif (isPositive(1) !== true) process.exit(1);\n";
const WEAK = "import { isPositive } from '../src/math.js';\nif (isPositive(1) === undefined) process.exit(1);\n";
// Fails whenever src/math.js isn't byte-for-byte this commit's: every planted mutant.
const HASHES = `import fs from 'node:fs';\nimport crypto from 'node:crypto';\nconst h = crypto.createHash('sha256').update(fs.readFileSync(new URL('../src/math.js', import.meta.url))).digest('hex');\nif (h !== '${crypto.createHash('sha256').update(MATH).digest('hex')}') process.exit(1);\n`;
// The luckiest a test that fails at random can be: it passes the first time (the new-code
// baseline), then fails on every run after it. The count lives outside the copies.
const luckyFlake = (counter) => `import fs from 'node:fs';\nconst n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;\nfs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));\nif (n > 0) process.exit(1);\n`;

const runner = createProcessRunner();
async function runObligation(ob, dir, opts) {
  const r = await runner.run(ob.run, { cwd: dir, env: process.env, timeoutMs: 60_000, killGraceMs: 200 });
  runObligation.logs?.push(opts?.logName || '');
  return { passed: r.exit === 0 && !r.timed_out, exit: r.exit, timed_out: r.timed_out, signal: r.signal, error: r.error, duration_ms: r.duration_ms, output: r.output };
}

function repo(change) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-guard-control-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  for (const [rel, text] of Object.entries({ 'src/math.js': MATH, 'test/a.check.mjs': ADD + POSITIVE })) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/a.check.mjs', change);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'change');
  return { dir, base, rev: git(dir, 'rev-parse', 'HEAD'), changes: [{ status: 'M', path: 'test/a.check.mjs', kind: 'test' }] };
}

async function guard(change) {
  const fx = repo(change);
  runObligation.logs = [];
  try {
    const res = await runGuardCheck({ root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks: [{ id: 'a', run: 'node test/a.check.mjs' }], sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation, seed: 1, mutants: 10, jobs: 2 });
    return { res, logs: runObligation.logs };
  } finally {
    delete runObligation.logs;
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
}

test('control: an honest stronger test passes, after the new tests pass on the blank-line copy', async () => {
  const { res, logs } = await guard(`${ADD + POSITIVE}if (isPositive(-1) !== false) process.exit(1);\n`);
  assert.equal(res.verdict, 'passed', res.summary);
  assert.deepEqual(res.control, { result: 'pass', files: ['src/math.js'] });
  assert.equal(logs.filter((l) => l.includes('-control-')).length, 1);
});

test('control: a weakened assertion alone is still detection-dropped, and no control runs', async () => {
  const { res, logs } = await guard(ADD + WEAK);
  assert.equal(res.verdict, 'detection-dropped');
  assert.equal(res.control, undefined);
  assert.ok(!logs.some((l) => l.includes('-control-')));
});

test('control: a weakened assertion behind a test that hashes the source is inconclusive, not passed', async () => {
  const { res } = await guard(ADD + WEAK + HASHES);
  assert.equal(res.detection.new_caught, res.detection.old_caught, 'the hash test "catches" every mutant');
  assert.equal(res.verdict, 'inconclusive', res.summary);
  assert.equal(res.passed, false);
  assert.equal(res.unfinished, undefined, 'a test result, not a run that did not finish: a test approval can cover it');
  assert.deepEqual(res.control, { result: 'fail', files: ['src/math.js'], check: 'a' });
  assert.match(res.summary, /blank line at the end of src\/math\.js/);
});

test('control: a weakened assertion behind a test that fails at random, at its luckiest, is inconclusive', async () => {
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-guard-flake-')), 'runs');
  try {
    const { res } = await guard(ADD + WEAK + luckyFlake(counter));
    assert.equal(res.new_tests.result, 'pass', 'it passed the new-code baseline');
    assert.equal(res.detection.new_caught, res.detection.old_caught, 'and "caught" every mutant');
    assert.equal(res.verdict, 'inconclusive', res.summary);
    assert.equal(res.control.result, 'fail');
  } finally {
    fs.rmSync(path.dirname(counter), { recursive: true, force: true });
  }
});

test('control: the blank line changes the bytes and nothing else, also in PHP that ends with ?>', () => {
  assert.equal(neutralEdit('export const a = 1;\n'), 'export const a = 1;\n\n');
  assert.equal(neutralEdit('x = 1'), 'x = 1\n');
  // Text after `?>` is printed, so the line goes inside the code block.
  assert.equal(neutralEdit('<?php echo 1; ?>\n'), '<?php echo 1; \n?>\n');
  assert.equal(neutralEdit('<?php\necho 1;\n'), '<?php\necho 1;\n\n');
});
