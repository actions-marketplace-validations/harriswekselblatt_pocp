// `pocp rules check` reads only .proof/, so it must also work in a copy of the repository with
// no .git: that is how CI re-runs a packet's checks (`verify --rerun` copies the commit without
// .git and runs each check from the copy's root). It used to fail there with "not inside a git
// repository", so a packet whose check was `pocp rules check` passed locally and always failed
// its re-run. Without git it checks the .proof/ of the folder it runs in and nothing else: it
// must never pass by finding some other .proof/ while the real rules are broken.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TMP, copyTree, pocp, sampleRepo, write, writeRules } from './helpers.js';

const BROKEN = { requirements: [{ id: 'x', glob: 'src/**', obligation: { kind: 'test' } }] };

function copyWithoutGit() {
  const repo = sampleRepo({ deep: false });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TEST_TMP, 'no-git-')));
  copyTree(repo, dir);
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  return dir;
}

test('rules check passes in a copy without .git, and says which .proof/ it checked', () => {
  const dir = copyWithoutGit();
  const r = pocp(dir, ['rules', 'check']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rules: ok/);
  assert.ok(r.stdout.includes(`rules: checked ${path.join(dir, '.proof')} (no git repository here)`), r.stdout);
  const j = pocp(dir, ['rules', 'check', '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.equal(j.json.ok, true);
  assert.equal(j.json.checked, path.join(dir, '.proof'));
});

test('without .git, rules check still finds broken rules', () => {
  const dir = copyWithoutGit();
  writeRules(dir, BROKEN);
  const r = pocp(dir, ['rules', 'check', '--json']);
  assert.equal(r.code, 2, r.stdout);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.problems.length > 0);
});

test('without .git, a .proof/ planted in a subfolder never stands in for broken root rules', () => {
  const dir = copyWithoutGit();
  writeRules(dir, BROKEN);
  write(dir, 'sub/.proof/rules.json', `${JSON.stringify({ pocp: 1, requirements: [] })}\n`);
  // Without git there is no repository root to find. Run from the subfolder, it checks that
  // folder's .proof/ only and names it, so it never claims the repository's rules are fine.
  // From the root (where CI runs checks) it finds the broken rules.
  const sub = pocp(path.join(dir, 'sub'), ['rules', 'check', '--json']);
  assert.equal(sub.json.checked, path.join(dir, 'sub', '.proof'));
  const root = pocp(dir, ['rules', 'check', '--json']);
  assert.equal(root.code, 2);
  assert.equal(root.json.checked, path.join(dir, '.proof'));
  // A folder with no .proof/ of its own doesn't search upward for one.
  fs.mkdirSync(path.join(dir, 'src', 'deeper'), { recursive: true });
  const deeper = pocp(path.join(dir, 'src', 'deeper'), ['rules', 'check']);
  assert.equal(deeper.code, 2);
  assert.match(deeper.stderr, /not inside a git repository/);
  assert.doesNotMatch(deeper.stdout, /rules: ok/);
});

test('without .git, a .proof that is not a real folder with a real rules.json fails', () => {
  // .proof is a file.
  const a = fs.mkdtempSync(path.join(TEST_TMP, 'proof-file-'));
  write(a, '.proof', '{}\n');
  // rules.json is a folder.
  const b = fs.mkdtempSync(path.join(TEST_TMP, 'rules-dir-'));
  fs.mkdirSync(path.join(b, '.proof', 'rules.json'), { recursive: true });
  // .proof/ with no rules.json.
  const c = fs.mkdtempSync(path.join(TEST_TMP, 'no-rules-'));
  fs.mkdirSync(path.join(c, '.proof'));
  // rules.json is a symlink to rules elsewhere.
  const d = copyWithoutGit();
  writeRules(d, BROKEN);
  write(d, 'elsewhere/rules.json', `${JSON.stringify({ pocp: 1, requirements: [] })}\n`);
  fs.rmSync(path.join(d, '.proof', 'rules.json'));
  fs.symlinkSync(path.join(d, 'elsewhere', 'rules.json'), path.join(d, '.proof', 'rules.json'));
  // .proof itself is a symlink to another folder.
  const e = copyWithoutGit();
  fs.renameSync(path.join(e, '.proof'), path.join(e, 'real-proof'));
  fs.symlinkSync(path.join(e, 'real-proof'), path.join(e, '.proof'));
  for (const dir of [a, b, c, d, e]) {
    const r = pocp(dir, ['rules', 'check']);
    assert.equal(r.code, 2, `${dir}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /not inside a git repository/);
    assert.doesNotMatch(r.stdout, /rules: ok/);
  }
});

test('with neither git nor .proof/, rules check says it is not in a repository', () => {
  const dir = fs.mkdtempSync(path.join(TEST_TMP, 'nothing-'));
  const r = pocp(dir, ['rules', 'check']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not inside a git repository/);
});

test('inside a git repository, rules check is unchanged: no "checked" line', () => {
  const dir = sampleRepo({ deep: false });
  const r = pocp(dir, ['rules', 'check']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'rules: ok');
});
