import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageWarnings } from '../src/rules.js';
import { tmpRepo } from './helpers.js';

const POCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pocp.js');
const req = (id, globs) => ({ id, globs, obligation: { kind: 'test', run: 'true' } });

test('a requirement whose globs match no tracked file is reported; a covering one is not', () => {
  const files = ['src/a.js', 'lib/b.py', 'README.md'];
  const w = coverageWarnings({ requirements: [req('covers', ['src/**']), req('hollow', ['app/**'])] }, files);
  assert.equal(w.length, 1);
  assert.match(w[0], /requirement "hollow" matches no tracked file \(app\/\*\*\)/);
});

test('with no file list (outside git, or an empty repo) nothing is reported', () => {
  assert.deepEqual(coverageWarnings({ requirements: [req('hollow', ['app/**'])] }, []), []);
  assert.deepEqual(coverageWarnings({ requirements: [req('hollow', ['app/**'])] }, undefined), []);
});

test('pocp rules check prints the warning for a rule that guards nothing, and still exits ok', () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'a'], { cwd: dir });
  const init = spawnSync(process.execPath, [POCP, 'init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const rulesFile = path.join(dir, '.proof', 'rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
  rules.requirements = [req('hollow', ['app/**'])];
  fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));
  const r = spawnSync(process.execPath, [POCP, 'rules', 'check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warning: requirement "hollow" matches no tracked file/);
});
