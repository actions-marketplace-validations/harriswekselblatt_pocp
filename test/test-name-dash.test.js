// `node --test` runs files named a-test.js by default. POCP used to read them as source, so in
// fast mode a new src/x-test.js (which runs with the other tests and can change their outcome)
// passed with no review, while src/x.test.js went to a person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVAL_EXCLUDE } from '../src/mutants.js';
import { matchGlob } from '../src/glob.js';
import { git, packetId, pocp, read, sampleRepo, write } from './helpers.js';

const protectedTest = (file) => DEFAULT_EVAL_EXCLUDE.some((glob) => matchGlob(file, glob));

test('every name `node --test` runs by default is a guarded test name', () => {
  for (const file of ['a.test.js', 'a-test.js', 'a_test.mjs', 'test-a.cjs', 'test.js', 'src/math-test.js', 'packages/core/unit-test.ts']) {
    assert.ok(protectedTest(file), file);
  }
  for (const file of ['src/latest.js', 'src/contest.ts', 'src/test-data.json', 'docs/a-test.md']) {
    assert.equal(protectedTest(file), false, file);
  }
});

test('fast mode: a new src/*-test.js goes to a person, like a new *.test.js', () => {
  const dir = sampleRepo({ deep: false });
  write(dir, 'src/zz-test.js', "process.on('exit', () => { process.exitCode = 0; });\n");
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'add a test', '--touch', 'src/zz-test.js']);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  pocp(dir, ['prove', id, '--json']);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const ob = p.obligations.find((o) => o.source === 'guard:tests');
  assert.ok(ob, 'the test guard runs for the new file');
  const guard = p.proofs.filter((x) => x.obligation === ob.id).at(-1)?.guard;
  assert.equal(guard?.passed, false, 'and does not pass it on its own');
});
