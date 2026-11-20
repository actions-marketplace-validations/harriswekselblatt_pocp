// Sticky approvals, verify's side: is a later head exactly the approved head plus base content?
// Real repositories, one per case: "Update branch" and its chains keep the approval; anything of
// the pull request's own that changes (a commit, an evil merge, a hand-resolved conflict, a mode,
// line endings, a rename, a submodule, a binary) voids it, as do a base policy change and an
// approved head that changed CI files. Merge drivers from .gitattributes never decide it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, tmpRepo, write } from './helpers.js';
import { cleanMergeTree, compareWithApproved } from '../src/sticky-approval.js';

// A test file long enough that edits at its top and bottom merge cleanly.
const TEST_FILE = [
  "import assert from 'node:assert';",
  "test('one', () => { assert.equal(f(1), 1); });",
  ...Array.from({ length: 12 }, (_, i) => `// filler ${i}`),
  "test('two', () => { assert.equal(f(2), 2); });",
  '',
].join('\n');

/** main with a test file, a source file and a policy; branch `pr` approved at A (one assertion dropped). */
function setup() {
  const dir = tmpRepo();
  write(dir, 'test/a.test.js', TEST_FILE);
  write(dir, 'src/x.js', 'export const f = (n) => n;\n');
  write(dir, '.proof/config.json', '{ "pocp": 1 }\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- first\n');
  commit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, 'test/a.test.js', TEST_FILE.replace("assert.equal(f(1), 1); ", ''));
  write(dir, 'src/x.js', 'export const f = (n) => n + 0;\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- pr entry\n- first\n');
  commit(dir, 'pr: drop an assertion');
  const A = git(dir, 'rev-parse', 'HEAD');
  return { dir, A, base0: git(dir, 'rev-parse', 'main') };
}
function commit(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}
/** Advance main with `edit(dir)`, then come back to pr. */
function onMain(dir, msg, edit) {
  git(dir, 'checkout', '-q', 'main');
  edit(dir);
  const sha = commit(dir, msg);
  git(dir, 'checkout', '-q', 'pr');
  return sha;
}
/** "Update branch": merge main into pr. */
function updateBranch(dir) {
  git(dir, 'merge', '-q', '--no-edit', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}
const cmp = (dir, A, H, base = git(dir, 'rev-parse', 'main'), extra = {}) => compareWithApproved(dir, { approved: A, head: H, base, ...extra });
const edit = (rel, fn) => (dir) => write(dir, rel, fn(fs.readFileSync(path.join(dir, rel), 'utf8')));

test('#99\'s shape (without its base policy change): the base changed the same test file elsewhere; Update branch keeps the approval', () => {
  const { dir, A } = setup();
  onMain(dir, 'main: another test, another entry', (d) => {
    edit('test/a.test.js', (s) => s.replace("test('two'", "test('three', () => { assert.ok(true); });\ntest('two'"))(d);
    write(d, 'src/y.js', 'export const g = 1;\n');
  });
  const H = updateBranch(dir);
  assert.notEqual(H, A);
  assert.deepEqual(cmp(dir, A, H), { verdict: 'same', files: [], why: null });
});

test('a chain of updates keeps the approval: each new head is the approved head plus base content', () => {
  const { dir, A } = setup();
  onMain(dir, 'main 1', (d) => write(d, 'src/y.js', '1\n'));
  const H1 = updateBranch(dir);
  assert.equal(cmp(dir, A, H1).verdict, 'same');
  onMain(dir, 'main 2', edit('test/a.test.js', (s) => `${s}// appended by main\n`));
  const H2 = updateBranch(dir);
  assert.equal(cmp(dir, A, H2).verdict, 'same');
  // And a head that is behind (the base moved again, not merged in yet) still matches.
  onMain(dir, 'main 3', (d) => write(d, 'src/z.js', '3\n'));
  assert.equal(cmp(dir, A, H2).verdict, 'same');
});

test('a merge commit that sneaks in a test edit of its own: voided, and the file is named', () => {
  const { dir, A } = setup();
  onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
  git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main');
  write(dir, 'test/a.test.js', TEST_FILE.replace("assert.equal(f(1), 1); ", '').replace("assert.equal(f(2), 2); ", ''));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  const c = cmp(dir, A, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(c.verdict, 'content');
  assert.deepEqual(c.files, ['test/a.test.js']);
});

test('an evil merge that only adds a file of its own is voided too', () => {
  const { dir, A } = setup();
  onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
  git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main');
  write(dir, 'test/helper.js', 'export const assertEqual = () => {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  assert.deepEqual(cmp(dir, A, git(dir, 'rev-parse', 'HEAD')).files, ['test/helper.js']);
});

test('a conflict resolved by hand is not the approved content, even when the result looks the same', () => {
  const { dir, A } = setup();
  onMain(dir, 'main: same line', edit('test/a.test.js', (s) => s.replace("test('one', () => { assert.equal(f(1), 1); });", "test('one', () => { assert.equal(f(1), 1, 'msg'); });")));
  git(dir, 'merge', '-q', '--no-edit', 'main', '--strategy-option=ours');
  assert.equal(cmp(dir, A, git(dir, 'rev-parse', 'HEAD')).verdict, 'conflict');
});

test('a merge that keeps the pull request\'s side (-s ours) undoes the base\'s new test: voided, though its tree is the approved one', () => {
  const { dir, A } = setup();
  onMain(dir, 'main: a new test', (d) => write(d, 'test/b.test.js', "test('new', () => {});\n"));
  git(dir, 'merge', '-q', '--no-edit', '-s', 'ours', 'main');
  const H = git(dir, 'rev-parse', 'HEAD');
  assert.equal(git(dir, 'rev-parse', `${H}^{tree}`), git(dir, 'rev-parse', `${A}^{tree}`));
  const c = cmp(dir, A, H);
  assert.equal(c.verdict, 'content');
  assert.deepEqual(c.files, ['test/b.test.js']);
});

test('a new commit of the pull request\'s own after the approval voids it, test or not', () => {
  for (const [rel, content] of [['src/x.js', 'export const f = () => 1;\n'], ['test/a.test.js', TEST_FILE.replace("assert.equal(f(2), 2); ", '')]]) {
    const { dir, A } = setup();
    write(dir, rel, content);
    const H = commit(dir, 'pr: more');
    const c = cmp(dir, A, H);
    assert.equal(c.verdict, 'content', rel);
    assert.deepEqual(c.files, [rel]);
  }
});

test('canonicalisation tricks are differences: a mode, line endings, a rename, a binary, a submodule', () => {
  const tricks = {
    mode: (d) => fs.chmodSync(path.join(d, 'test/a.test.js'), 0o755),
    crlf: edit('test/a.test.js', (s) => s.replace(/\n/g, '\r\n')),
    trailing_space: edit('test/a.test.js', (s) => s.replace("test('two'", "test('two' ")),
    rename: (d) => fs.renameSync(path.join(d, 'test/a.test.js'), path.join(d, 'test/a.spec.js')),
    binary: (d) => fs.writeFileSync(path.join(d, 'test/fixture.bin'), Buffer.from([0, 1, 2, 0, 255])),
    submodule: (d) => git(d, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/lib`),
  };
  for (const [name, change] of Object.entries(tricks)) {
    const { dir, A } = setup();
    // Each trick lands in a merge of the base, the way an agent would hide it.
    onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
    git(dir, 'merge', '-q', '--no-commit', '--no-ff', 'main');
    change(dir);
    if (name !== 'submodule') git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-edit');
    assert.equal(cmp(dir, A, git(dir, 'rev-parse', 'HEAD')).verdict, 'content', name);
  }
});

test('a binary file the pull request changed is compared exactly: an approval carries only for the same bytes', () => {
  const { dir } = setup();
  fs.writeFileSync(path.join(dir, 'test/fixture.bin'), Buffer.from([0, 1, 2]));
  const A = commit(dir, 'pr: fixture');
  onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
  assert.equal(cmp(dir, A, updateBranch(dir)).verdict, 'same');
  fs.writeFileSync(path.join(dir, 'test/fixture.bin'), Buffer.from([0, 1, 3]));
  assert.equal(cmp(dir, A, commit(dir, 'pr: other bytes')).verdict, 'content');
});

test('force-pushes: a rebase onto the base keeps it while the approved head is still known; a head no longer in history is gone', () => {
  const { dir, A } = setup();
  onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
  git(dir, 'rebase', '-q', 'main');
  const R = git(dir, 'rev-parse', 'HEAD');
  assert.equal(cmp(dir, A, R).verdict, 'same');
  // Rewritten with different content: voided.
  write(dir, 'test/a.test.js', TEST_FILE.replace("assert.equal(f(2), 2); ", ''));
  git(dir, 'commit', '-q', '--amend', '--no-edit', '-a');
  assert.equal(cmp(dir, A, git(dir, 'rev-parse', 'HEAD')).verdict, 'content');
  // The approved head was force-pushed away and never fetched: nothing to compare with.
  assert.equal(cmp(dir, 'c'.repeat(40), R).verdict, 'gone');
  assert.equal(cmp(dir, 'HEAD', R).verdict, 'gone', 'only a full sha names the approved head');
});

test('a force-push back to an earlier head is not the approved head', () => {
  const { dir, A: H1 } = setup();
  write(dir, 'test/a.test.js', TEST_FILE);
  const H2 = commit(dir, 'pr: restore the assertion');
  // Approved at H2, then force-pushed back to H1 (which drops the assertion).
  assert.equal(cmp(dir, H2, H1).verdict, 'content');
});

test("a policy change on the base voids the approval; a proof record doesn't", () => {
  const { dir, A } = setup();
  onMain(dir, 'main: a proof record', (d) => write(d, '.proof/packets/p-1.json', '{}\n'));
  assert.equal(cmp(dir, A, updateBranch(dir)).verdict, 'same');
  onMain(dir, 'main: policy', (d) => write(d, '.proof/config.json', '{ "pocp": 1, "guard": { "mutants": 0 } }\n'));
  const c = cmp(dir, A, updateBranch(dir));
  assert.equal(c.verdict, 'policy');
  assert.deepEqual(c.files, ['.proof/config.json']);
});

test("the base's policy is compared with the policy the approved run was judged by", () => {
  const { dir, A, base0 } = setup();
  const B1 = onMain(dir, 'main: policy', (d) => write(d, '.proof/config.json', '{ "pocp": 1, "x": 1 }\n'));
  // The approval was given on a run against B1 (after the policy change): it was judged by it.
  onMain(dir, 'main: code', (d) => write(d, 'src/y.js', '1\n'));
  const H = updateBranch(dir);
  assert.equal(cmp(dir, A, H, undefined, { approvedBase: B1 }).verdict, 'same');
  assert.equal(cmp(dir, A, H, undefined, { approvedBase: base0 }).verdict, 'policy');
});

test('an approved head that changed CI files never carries: its run reported through its own workflow', () => {
  const { dir } = setup();
  write(dir, '.github/workflows/pocp.yml', 'name: pocp\n');
  const A = commit(dir, 'pr: workflow');
  onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
  const c = cmp(dir, A, updateBranch(dir));
  assert.equal(c.verdict, 'ci');
  assert.deepEqual(c.files, ['.github/workflows/pocp.yml']);
  // ci.files from the base's config count too.
  const { dir: d2 } = setup();
  write(d2, 'eval/x.json', '{}\n');
  const A2 = commit(d2, 'pr: eval');
  assert.equal(compareWithApproved(d2, { approved: A2, head: A2, base: 'main', baseConfig: { ci: { files: ['eval/**'] } } }).verdict, 'ci');
});

test(".gitattributes merge drivers never decide the merge: a union merge is a conflict here", () => {
  const { dir } = setup();
  write(dir, '.gitattributes', '*.md merge=union\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- pr\n');
  const A = commit(dir, 'pr: union');
  const B = onMain(dir, 'main', (d) => write(d, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- main\n'));
  assert.equal(cleanMergeTree(dir, A, B).conflict, true);
  // git's own merge honours the driver, and the result is still refused.
  git(dir, 'merge', '-q', '--no-edit', 'main');
  assert.equal(cmp(dir, A, git(dir, 'rev-parse', 'HEAD')).verdict, 'conflict');
});

test("missing data is undecided, never a verdict", () => {
  const { dir, A } = setup();
  assert.equal(compareWithApproved(dir, { approved: A, head: 'f'.repeat(40), base: 'main' }).verdict, null);
  assert.equal(compareWithApproved(dir, { approved: A, head: A, base: 'nope' }).verdict, null);
});

test('an approved head missing from a shallow clone is undecided, not gone', () => {
  const { dir, A } = setup();
  onMain(dir, 'main', (d) => write(d, 'src/y.js', '1\n'));
  const H = updateBranch(dir);
  const shallow = `${dir}-shallow`;
  git(dir, 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${dir}`, shallow);
  const c = compareWithApproved(shallow, { approved: 'c'.repeat(40), head: H, base: git(shallow, 'rev-parse', 'origin/main') });
  assert.equal(c.verdict, null);
  assert.match(c.why, /shallow/);
  assert.equal(cmp(dir, A, H).verdict, 'same');
});
