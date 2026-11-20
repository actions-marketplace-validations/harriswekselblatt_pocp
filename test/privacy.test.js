// Privacy guard: this repo is (or will be) public, with its history. This test keeps private
// material out of every tracked file, so a commit that would leak it fails the test suite before
// it exists, instead of being found later and forcing a history rewrite.
//
// It looks for: this machine's home path and the local username in any absolute path; ids from
// the author's own task ledger (lx_ followed by 8 hex digits; ids starting lx_0000 are made-up
// samples); email addresses other than no-reply and reserved test domains; and any term in a
// private list kept outside the repo ($PRIVACY_TERMS_FILE, or ~/.config/privacy-guard/terms.txt,
// one term per line), so the list of what's private is never committed itself.
//
// The same file lives in each of the author's public-bound repos; keep them identical.

import './temp.js'; // this process's temporary folders: one root, removed on exit or interrupt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The files to check, relative to the returned root: what git tracks, or, where there is no git (a
// gate re-running the tests in an exported copy of the commit), every file under `fallbackRoot`
// except dependency folders and symlinks.
export function filesToCheck(start, fallbackRoot) {
  try {
    const root = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { root, files: execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean) };
  } catch {
    const files = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(fallbackRoot, rel), { withFileTypes: true })) {
        if (e.isSymbolicLink() || e.name === 'node_modules' || e.name === '.git') continue;
        const p = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) files.push(p);
      }
    };
    walk('');
    return { root: fallbackRoot, files };
  }
}

const { root, files } = filesToCheck(here, process.cwd());

const termsFile = process.env.PRIVACY_TERMS_FILE || path.join(os.homedir(), '.config', 'privacy-guard', 'terms.txt');
const privateTerms = fs.existsSync(termsFile)
  ? fs.readFileSync(termsFile, 'utf8').split('\n').map((t) => t.trim()).filter((t) => t && !t.startsWith('#'))
  : [];

const me = os.userInfo().username;
const ALLOWED_EMAIL_DOMAIN = /(^|\.)(anthropic\.com|users\.noreply\.github\.com|example\.(com|org|net)|invalid|test|example|localhost)$|^noreply\./i;

// On a CI runner the home folder (e.g. /home/runner) is the runner's, not a person's, and tests may
// name it on purpose; the home-path checks only mean something on a developer's machine.
export function checksHome(env = process.env) {
  return !env.CI;
}

export function findLeaks(text, { home: checkHome = checksHome() } = {}) {
  const leaks = [];
  const home = os.homedir();
  if (checkHome && home.length > 3 && text.includes(home)) leaks.push('this machine\'s home path');
  if (checkHome && me && me.length > 2) {
    for (const m of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g)) if (m[1] === me) leaks.push(`a path in the local user's home (${m[0]})`);
  }
  for (const m of text.matchAll(/\blx_[0-9a-f]{8}\b/g)) if (!m[0].startsWith('lx_0000')) leaks.push(`a task ledger id (${m[0]})`);
  for (const m of text.matchAll(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const domain = m[2];
    if (ALLOWED_EMAIL_DOMAIN.test(domain) || /^pytest\./.test(domain) || m[0] === `git@${'github.com'}` || /\.(m?js|ts|png|svg|jpg)$/i.test(domain)) continue;
    leaks.push(`an email address (${m[0]})`);
  }
  for (const t of privateTerms) if (text.toLowerCase().includes(t.toLowerCase())) leaks.push(`a private term from ${termsFile}`);
  return [...new Set(leaks)];
}

test('no tracked file contains private material', () => {
  const found = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // binary
    for (const l of findLeaks(text)) found.push(`${f}: ${l}`);
  }
  assert.deepEqual(found, [], 'remove these before committing; a public repo keeps them forever');
});

test('the privacy guard catches what it should and allows placeholders', () => {
  // Built at runtime, so this file doesn't itself contain what it looks for.
  const at = '@';
  assert.deepEqual(findLeaks(`see /Users/alice/x, /home/user/.codex, noreply${at}anthropic.com, t${at}example.invalid, ${at}pytest.fixture`), []);
  assert.equal(findLeaks(`at /${'Users'}/${me}/code`, { home: true }).length >= 1, true);
  assert.equal(findLeaks(`ledger lx_${'2132'}4f60`).length, 1);
  assert.deepEqual(findLeaks(`sample lx_${'0000'}a001`), []);
  assert.equal(findLeaks(`mail someone${at}gmail.com`).length, 1);
  assert.equal(findLeaks(`path ${os.homedir()}/x`, { home: true }).length >= 1, true);
});

test('on a CI runner the home folder is the runner\'s, so home paths are allowed there; the other checks still run', () => {
  assert.equal(checksHome({ CI: 'true' }), false);
  assert.equal(checksHome({}), true);
  assert.deepEqual(findLeaks(`path ${os.homedir()}/x`, { home: false }), []);
  assert.equal(findLeaks(`ledger lx_${'2132'}4f60`, { home: false }).length, 1);
});

test('outside git (a gate re-running an exported copy), the guard still reads every file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-guard-'));
  try {
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'note.md'), `ledger lx_${'2132'}4f60`);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'skipped');
    const { root: r, files: f } = filesToCheck(dir, dir);
    assert.equal(r, dir);
    assert.deepEqual(f, [path.join('docs', 'note.md')]);
    assert.equal(findLeaks(fs.readFileSync(path.join(r, f[0]), 'utf8')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
