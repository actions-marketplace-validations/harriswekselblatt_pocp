// Fewer git processes per pocp command, with the same answers. Starting git is most of the
// CPU a pocp command uses (about 15 ms each on a busy Mac; a `pocp gate` in a hook made 31
// calls), so two lookups that were repeated on every staged-files check are now made once:
// whether HEAD exists (stagedChanges now just tries the diff against HEAD), and where
// MERGE_HEAD lives.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIN, TEST_TMP, git, read, sampleRepo, tmpRepo, write } from './helpers.js';
import { mergeHeads, stagedChanges } from '../src/git.js';

test('before the first commit, every staged file is listed, even with a file named HEAD', () => {
  const dir = tmpRepo();
  write(dir, 'HEAD', 'a file that looks like a revision\n');
  write(dir, 'src/a.js', 'a\n');
  git(dir, 'add', '-A');
  assert.deepEqual(stagedChanges(dir).map((c) => c.path).sort(), ['HEAD', 'src/a.js']);
});

test('with a HEAD, staged changes are what git diff --cached lists (renames included)', () => {
  const dir = sampleRepo({ deep: false });
  write(dir, 'HEAD', 'a file named HEAD next to the HEAD revision\n');
  git(dir, 'mv', 'src/math.js', 'src/sum.js');
  write(dir, 'src/new.js', 'x\n');
  git(dir, 'add', '-A');
  const got = stagedChanges(dir).map((c) => `${c.status} ${c.oldPath ? `${c.oldPath} -> ` : ''}${c.path}`).sort();
  assert.deepEqual(got, ['A HEAD', 'A src/new.js', 'R src/math.js -> src/sum.js']);
  // Against a given revision, as before.
  assert.deepEqual(stagedChanges(dir, git(dir, 'rev-parse', 'HEAD')).map((c) => c.path).sort(), ['HEAD', 'src/new.js', 'src/sum.js']);
});

test('a merge that starts after the first look is still seen', () => {
  const dir = sampleRepo({ deep: false });
  assert.deepEqual(mergeHeads(dir), []);
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'src/side.js', 'side\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'side');
  const side = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'README.md', '# main moved\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'main');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-commit', '--no-ff', '-q', 'side');
  assert.deepEqual(mergeHeads(dir), [side]);
});

// Counts the git processes a pocp command starts, with a `git` first on PATH that logs its
// arguments and runs the real one.
function countGit(dir, args) {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shim = fs.mkdtempSync(path.join(TEST_TMP, 'git-shim-'));
  const log = path.join(shim, 'calls.log');
  fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { r, calls };
}

test('pocp gate asks where MERGE_HEAD is once, and makes fewer git calls than 1.4.0', () => {
  const dir = sampleRepo({ deep: false });
  write(dir, 'src/math.js', `${read(dir, 'src/math.js')}// touched\n`);
  git(dir, 'add', '-A');
  const { r, calls } = countGit(dir, ['gate']);
  assert.ok(r.status !== null, r.stderr);
  assert.equal(calls.filter((c) => /rev-parse --git-path MERGE_HEAD/.test(c)).length, 1, calls.join('\n'));
  // No "is there a HEAD?" before each diff against it.
  const diffs = calls.filter((c) => / diff .*--cached/.test(c)).length;
  assert.ok(diffs >= 1);
  assert.ok(calls.filter((c) => /rev-parse --verify --quiet HEAD$/.test(c)).length < diffs + 3, calls.join('\n'));
  // Measured on 1.4.0: 31 calls for this gate.
  assert.ok(calls.length <= 26, `${calls.length} git calls:\n${calls.join('\n')}`);
});
