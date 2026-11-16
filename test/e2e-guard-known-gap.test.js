// A KNOWN HOLE IN DEEP MODE, PINNED ON PURPOSE (docs/THREAT-MODEL.md, deep-mode limits).
//
// Deep mode counts a planted bug as caught when the new tests fail on it. A new test that
// inspects the source under test (here: hashes it) fails on every planted bug without checking
// behavior, so it can stand in for a weakened assertion, and the guard passes the change. The
// bug can then arrive unseen in a later change. The tamper benchmark measures the same attack
// end to end (bench/tamper, target pocp-deep, scenario deep-hash).
//
// The first test below asserts that the guard ACCEPTS this weakening today. It is not a wish.
// It exists so that a future defence has to make it fail on purpose, and whoever ships that
// defence flips the assertion, updates the threat model and records the change. If it starts
// failing for any other reason, the guard's behavior changed without anyone deciding it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGuardCheck } from '../src/guard-check.js';
import { createProcessRunner } from '../src/runner.js';
import { git, write } from './helpers.js';

// Mutation sites: line 2 `a + b` (plus), line 6 `n > 0` (gt, zero-one). ADD catches the first,
// POSITIVE the other two, so weakening POSITIVE loses two of the three.
const MATH = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';
const BUGGY = MATH.replace('n > 0', 'n >= 0');
const ADD = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n";
const POSITIVE = "import { isPositive } from '../src/math.js';\nif (isPositive(0) !== false) process.exit(1);\nif (isPositive(1) !== true) process.exit(1);\n";
const WEAK = "import { isPositive } from '../src/math.js';\nif (isPositive(1) === undefined) process.exit(1);\n";
// Fails whenever src/math.js isn't byte-for-byte `text`: every planted bug.
const hashes = (text) => `import fs from 'node:fs';\nimport crypto from 'node:crypto';\nconst h = crypto.createHash('sha256').update(fs.readFileSync(new URL('../src/math.js', import.meta.url))).digest('hex');\nif (h !== '${crypto.createHash('sha256').update(text).digest('hex')}') process.exit(1);\n`;

const runner = createProcessRunner();
async function runObligation(ob, dir) {
  const r = await runner.run(ob.run, { cwd: dir, env: process.env, timeoutMs: 60_000, killGraceMs: 200 });
  return { passed: r.exit === 0 && !r.timed_out, exit: r.exit, timed_out: r.timed_out, signal: r.signal, error: r.error, duration_ms: r.duration_ms, output: r.output };
}

/** Deep mode's guard on one change to the test file (and, optionally, the source). */
async function guard(change) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-guard-gap-')));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.invalid');
    git(dir, 'config', 'user.name', 't');
    write(dir, 'src/math.js', MATH);
    write(dir, 'test/a.check.mjs', ADD + POSITIVE);
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    for (const [rel, text] of Object.entries(change)) write(dir, rel, text);
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'change');
    // The guard is given the guarded (test) changes only; the source change is just in the commit.
    const changes = Object.keys(change).filter((p) => p.startsWith('test/')).map((p) => ({ status: 'M', path: p, kind: 'test' }));
    return await runGuardCheck({ root: dir, base, rev: git(dir, 'rev-parse', 'HEAD'), changes, checks: [{ id: 'a', run: 'node test/a.check.mjs' }], sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation, seed: 1, mutants: 10, jobs: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('KNOWN HOLE: deep mode accepts a weakened assertion hidden behind a test that hashes the source', async () => {
  const res = await guard({ 'test/a.check.mjs': ADD + WEAK + hashes(MATH) });
  assert.equal(res.old_tests.result, 'pass', 'the old tests pass on the new code: nothing for part 1 to see');
  assert.equal(res.detection.new_caught, res.detection.old_caught, 'the hash test "catches" every planted bug the old tests caught');
  assert.equal(res.verdict, 'passed', 'TODAY THE GUARD ACCEPTS THIS. A defence must make this assertion fail on purpose.');
});

test('the same weakening without the hash test is caught: the hash test is what hides it', async () => {
  const res = await guard({ 'test/a.check.mjs': ADD + WEAK });
  assert.equal(res.verdict, 'detection-dropped');
});

test('the weakening, the hash test and the bug in one change are still caught by the old tests', async () => {
  const res = await guard({ 'test/a.check.mjs': ADD + WEAK + hashes(BUGGY), 'src/math.js': BUGGY });
  assert.equal(res.verdict, 'behavior-changed', res.summary);
});
