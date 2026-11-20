// Sticky approvals in local mode: `verify --accept-test-change=<sha>` given for the branch head
// covers a later head that is exactly that head plus base content (a merge into the base with the
// same tree, a fast-forward, a merge that brings in base-only changes), and only for a
// review-only hold with the same test files held. A merge whose resolution edits the held tests,
// or a hold whose old tests fail on the new code, needs an approval of the new head. These are
// the cases a local approval met in practice: approved on a branch, then merged into main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sampleRepo, write } from './helpers.js';
import { VERIFY_EXIT } from '../src/approvals.js';

const RULES = {
  requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 30000 }, source: 'author' }],
};
const noHooks = (dir, ...args) => git(dir, '-c', 'core.hooksPath=/dev/null', ...args);
const plain = (dir, msg) => {
  git(dir, 'add', '-A');
  noHooks(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

/** main at base0; branch topic with a test edit committed through the gate (A). */
function branch({ behaviour = false } = {}) {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  const base0 = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'topic');
  if (behaviour) {
    // The code changes behaviour and the test is edited to accept it: the old test fails on the new code.
    write(dir, 'src/math.js', read(dir, 'src/math.js').replace('return a + b;', 'return a + b + 1;'));
    write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace('add(2, 3) !== 5', 'add(2, 3) !== 6'));
  } else {
    write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math still ok');"));
  }
  git(dir, 'add', '-A');
  const fix = pocp(dir, ['fix', '--intent', 'edit a test']);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  git(dir, 'commit', '-q', '-m', 'edit a test');
  const A = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  return { dir, base0, A };
}
const verify = (dir, range, approved) => pocp(dir, ['verify', range, '--rerun', '--json', '--exit-detail', `--accept-test-change=${approved}`]);

test('approved on the branch head, then merged into main with the same tree: the approval carries', () => {
  const { dir, base0, A } = branch();
  noHooks(dir, 'merge', '-q', '--no-ff', '--no-edit', 'topic');
  const H = git(dir, 'rev-parse', 'HEAD');
  assert.notEqual(H, A);
  const v = verify(dir, `${base0}..${H}`, A);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stderr, new RegExp(`the approval for ${A.slice(0, 12)} covers ${H.slice(0, 12)}: it is that head plus base content only`));
});

test('a fast-forward merge: the head is the approved head', () => {
  const { dir, base0, A } = branch();
  noHooks(dir, 'merge', '-q', '--ff-only', 'topic');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), A);
  const v = verify(dir, `${base0}..${A}`, A);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test('a merge that brings in base-only changes: the approval carries', () => {
  const { dir, A } = branch();
  write(dir, 'docs/notes.md', 'main moved on\n');
  const B1 = plain(dir, 'docs on main');
  noHooks(dir, 'merge', '-q', '--no-ff', '--no-edit', 'topic');
  const v = verify(dir, `${B1}..HEAD`, A);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test("a merge whose resolution edits the held test file: the approval is voided, and verify says what changed", () => {
  const { dir, A } = branch();
  write(dir, 'docs/notes.md', 'main moved on\n');
  const B1 = plain(dir, 'docs on main');
  noHooks(dir, 'merge', '-q', '--no-ff', '--no-commit', 'topic');
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("if (isPositive(1) !== true || isPositive(-1) !== false) { console.error('isPositive broken'); process.exit(1); }\n", ''));
  git(dir, 'add', '-A');
  noHooks(dir, 'commit', '-q', '--no-edit');
  const v = verify(dir, `${B1}..HEAD`, A);
  assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
  assert.match(v.stderr, new RegExp(`approval for ${A} does not cover .*the pull request changed since then.*\\(test/math\\.check\\.mjs\\)`));
});

test('a hold whose old tests fail on the new code never carries to another head', () => {
  const { dir, A } = branch({ behaviour: true });
  // The exact head still takes its own approval.
  const own = verify(dir, `${git(dir, 'merge-base', 'main', A)}..${A}`, A);
  assert.equal(own.code, 0, own.stdout + own.stderr);
  write(dir, 'docs/notes.md', 'main moved on\n');
  const B1 = plain(dir, 'docs on main');
  noHooks(dir, 'merge', '-q', '--no-ff', '--no-edit', 'topic');
  const v = verify(dir, `${B1}..HEAD`, A);
  assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
  assert.match(v.stderr, /the test guard found behavior-changed on this head, and only a review-only hold \(the old tests still pass\) carries to a new head/);
  assert.equal(v.json.approval.needs[0].label, 'pocp-approve-tests');
});
