// Some projects list their whole source package in pytest `testpaths` (sympy: `testpaths =
// sympy doc/src`, astropy: `"astropy" "docs"`), because their tests live in folders inside the
// package. pocp init used to turn each such entry into `<dir>/**`, so every source file counted
// as a test: a fix was reported as "existing test lines were changed", the test guard restored
// the old source along with the old tests, and deep mode had no code left to plant bugs in.
// A declared folder that holds code as well as tests the defaults already find is left to the
// defaults, so only the test files inside it count as tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTestLayout } from '../src/init.js';
import { effectiveGuardGlobs } from '../src/guard.js';
import { matchGlob } from '../src/glob.js';
import { pocp, read, tmpRepo, write } from './helpers.js';

const isTest = (config, file) => effectiveGuardGlobs(config).test.some((g) => matchGlob(file, g));

function sourcePackage(dir) {
  write(dir, 'mypkg/__init__.py', '');
  write(dir, 'mypkg/core.py', 'def f():\n    return 1\n');
  write(dir, 'mypkg/sub/util.py', 'def g():\n    return 2\n');
  write(dir, 'mypkg/tests/__init__.py', '');
  write(dir, 'mypkg/tests/test_x.py', 'from mypkg.core import f\n\ndef test_f():\n    assert f() == 1\n');
  write(dir, 'mypkg/sub/tests/test_util.py', 'from mypkg.sub.util import g\n\ndef test_g():\n    assert g() == 2\n');
}

test('testpaths naming a source package (setup.cfg, unquoted): its source files are not tests, its test files are', () => {
  const dir = tmpRepo();
  write(dir, 'setup.cfg', '[metadata]\nname = mypkg\n\n[tool:pytest]\ntestpaths = mypkg doc/src\n');
  sourcePackage(dir);
  write(dir, 'doc/src/index.rst', '>>> 1 + 1\n2\n');
  const r = pocp(dir, ['init', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const layout = r.json.test_layout;
  assert.deepEqual(layout.extra, [], 'no mypkg/** glob');
  assert.match(layout.skipped.mypkg, /source code/);
  const cfg = JSON.parse(read(dir, '.proof/config.json'));
  assert.equal(cfg.guard.extra_test_globs, undefined);
  assert.equal(isTest(cfg, 'mypkg/core.py'), false);
  assert.equal(isTest(cfg, 'mypkg/sub/util.py'), false);
  assert.equal(isTest(cfg, 'mypkg/__init__.py'), false);
  assert.equal(isTest(cfg, 'mypkg/tests/test_x.py'), true);
  assert.equal(isTest(cfg, 'mypkg/sub/tests/test_util.py'), true);
  assert.equal(pocp(dir, ['rules', 'check']).code, 0, 'the written config is valid');

  const human = pocp(dir, ['init']);
  assert.match(human.stdout, /not counted as test folders: mypkg\/ \(setup\.cfg testpaths\)/);
});

test('testpaths in pyproject (quoted list): a source package and a docs folder are skipped, a real test folder is kept', () => {
  const dir = tmpRepo();
  write(dir, 'pyproject.toml', '[project]\nname = "mypkg"\n\n[tool.pytest.ini_options]\ntestpaths = [\n    "mypkg",\n    "docs",\n    "qa",\n]\n');
  sourcePackage(dir);
  write(dir, 'docs/conf.py', 'project = "mypkg"\n');
  write(dir, 'docs/changes/123.bugfix.rst', 'Fixed f.\n');
  write(dir, 'qa/__init__.py', '');
  write(dir, 'qa/check_core.py', 'from mypkg.core import f\n\ndef test_f():\n    assert f() == 1\n');
  const r = pocp(dir, ['init', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.test_layout.extra, ['qa/**'], 'only the folder that holds nothing but tests');
  assert.deepEqual(Object.keys(r.json.test_layout.skipped).sort(), ['docs', 'mypkg']);
  const cfg = JSON.parse(read(dir, '.proof/config.json'));
  assert.deepEqual(cfg.guard.extra_test_globs, ['qa/**']);
  assert.match(cfg.guard._note, /qa\/ from pyproject\.toml testpaths/);
  assert.doesNotMatch(cfg.guard._note, /mypkg\/|docs\//, 'the note names only the folders it added');
  assert.equal(isTest(cfg, 'mypkg/core.py'), false);
  assert.equal(isTest(cfg, 'docs/conf.py'), false);
  assert.equal(isTest(cfg, 'docs/changes/123.bugfix.rst'), false);
  assert.equal(isTest(cfg, 'qa/check_core.py'), true);
  assert.equal(isTest(cfg, 'mypkg/tests/test_x.py'), true);
});

test('a declared folder mixing default-named tests with other code is left to the defaults', () => {
  // The safer side of the trade-off: a helper next to test_a.py is gated as source rather
  // than restored and skipped as a test.
  const dir = tmpRepo();
  write(dir, 'pytest.ini', '[pytest]\ntestpaths = checks\n');
  write(dir, 'checks/test_a.py', 'def test_a():\n    assert True\n');
  write(dir, 'checks/helpers.py', 'X = 1\n');
  const layout = detectTestLayout(dir);
  assert.deepEqual(layout.extra, []);
  assert.ok(layout.skipped.checks);
});
