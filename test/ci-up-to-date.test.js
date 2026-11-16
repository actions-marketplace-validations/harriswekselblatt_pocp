// ci.require_up_to_date: GitHub's "branches must be up to date before merging" (strict). Without
// it, what merges is the pull request plus base commits nobody verified together with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_ACTIONS_APP_ID, protectionGaps, protectionPayload, reporterIdentityNote } from '../src/ci-github.js';
import { configWeakening, validateConfig, withDefaults } from '../src/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = (over = {}) => ({ branch: 'main', required_checks: ['pocp'], require_pull_request: true, enforce_admins: false, require_up_to_date: true, ...over });
const protection = (strict, app_id = 42) => ({ required_status_checks: { strict, contexts: ['pocp'], checks: [{ context: 'pocp', app_id }] }, required_pull_request_reviews: {}, enforce_admins: { enabled: false } });

test('a plan that requires up-to-date branches reports protection without strict as a gap', () => {
  assert.match(protectionGaps(protection(false), plan()).join('\n'), /up to date/);
  assert.deepEqual(protectionGaps(protection(true), plan()), []);
  assert.deepEqual(protectionGaps(protection(false), plan({ require_up_to_date: false })), []);
});

// A required pocp check any app can post (or GitHub Actions can) is passed by a branch that
// edits a workflow to post its own "pocp: success" (docs/STATUS.md).
// Without ci.reporter_app_id the App is optional setup --apply can't do: a note, never a gap, so
// --check and doctor don't loop on "fix: pocp ci required --apply" (walkthrough C1).
test('a required pocp check not pinned to the reporter\'s app: a gap with ci.reporter_app_id, a note without', () => {
  const gap = (p, pl = plan()) => protectionGaps(p, pl).filter((x) => /not pinned/.test(x));
  for (const [p, what] of [[protection(true, null), 'any source'], [protection(true, -1), 'explicitly any app'], [protection(true, GITHUB_ACTIONS_APP_ID), 'GitHub Actions'], [{ ...protection(true), required_status_checks: { strict: true, contexts: ['pocp'] } }, 'contexts only']]) {
    assert.deepEqual(gap(p), [], what);
    assert.match(reporterIdentityNote(p, plan()), /ci\.reporter_app_id is not set.*STATUS\.md/, what);
  }
  assert.deepEqual(protectionGaps(protection(true, null), plan()), [], 'nothing else to fix: --check passes');
  assert.equal(reporterIdentityNote(protection(true, 42), plan()), null, 'another app');
  assert.equal(reporterIdentityNote(protection(true, null), plan({ reporter_app_id: 7 })), null, 'configured: a gap instead');
  assert.equal(gap(protection(true, null), plan({ reporter_app_id: 7 })).length, 1);
  assert.deepEqual(gap(protection(true, 42)), [], 'another app, with no ci.reporter_app_id');
  assert.match(gap(protection(true, 42), plan({ reporter_app_id: 7 }))[0], /ci\.reporter_app_id 7/);
  assert.deepEqual(gap(protection(true, 7), plan({ reporter_app_id: 7 })), []);
  assert.deepEqual(gap(protection(true, null), plan({ required_checks: ['tests'] })), [], 'only the pocp status is checked');
});

test('--apply pins the pocp check to ci.reporter_app_id and leaves other checks as they are', () => {
  const existing = { required_status_checks: { strict: true, contexts: ['pocp', 'lint'], checks: [{ context: 'pocp', app_id: GITHUB_ACTIONS_APP_ID }, { context: 'lint', app_id: GITHUB_ACTIONS_APP_ID }] } };
  const checks = (ex, pl) => protectionPayload(ex, plan(pl)).payload.required_status_checks.checks;
  assert.deepEqual(checks(existing, { reporter_app_id: 7 }), [{ context: 'pocp', app_id: 7 }, { context: 'lint', app_id: GITHUB_ACTIONS_APP_ID }]);
  assert.deepEqual(checks(null, { reporter_app_id: 7, required_checks: ['pocp', 'tests'] }), [{ context: 'pocp', app_id: 7 }, { context: 'tests' }], 'a fresh branch');
  assert.deepEqual(checks(null, {}), [{ context: 'pocp' }], 'no app configured: as before');
});

test('turning require_up_to_date off is a policy loosening; a non-boolean is invalid', () => {
  const on = withDefaults({ ci: { require_up_to_date: true } });
  const off = withDefaults({ ci: { require_up_to_date: false } });
  assert.ok(configWeakening(on, off).some((w) => /require_up_to_date/.test(w)));
  assert.ok(validateConfig(withDefaults({ ci: { require_up_to_date: 'yes' } })).some((p) => /require_up_to_date/.test(p)));
  // Changing or dropping the reporter's app id loosens what may post the pocp status.
  const pinned = withDefaults({ ci: { reporter_app_id: 7 } });
  assert.ok(configWeakening(pinned, withDefaults({ ci: {} })).some((w) => /reporter_app_id/.test(w)));
  assert.ok(configWeakening(pinned, withDefaults({ ci: { reporter_app_id: 8 } })).some((w) => /reporter_app_id/.test(w)));
  assert.ok(validateConfig(withDefaults({ ci: { reporter_app_id: '7' } })).some((p) => /reporter_app_id/.test(p)));
  assert.deepEqual(validateConfig(pinned), []);
});

test("POCP's own config lists the checks its workflows produce, and asks for up-to-date branches", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.proof/config.json'), 'utf8'));
  assert.deepEqual(cfg.ci.required_checks, ['pocp', 'test (ubuntu-latest, 20)', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)', 'eval (ubuntu-latest)']);
  assert.equal(cfg.ci.require_up_to_date, true);
  assert.equal(cfg.ci.reporter_app_id, 5775327, 'the live reporter App (docs/STATUS.md)');
  // Every required check is a job name test.yml (or the reporter) can produce on a pull request.
  const testYml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  assert.match(testYml, /ubuntu-latest/);
  assert.doesNotMatch(cfg.ci.required_checks.join(' '), /macos|\bverify\b/);
});

test('up-to-date branches are on by default; pocp init writes the choice out', async () => {
  const { requiredChecksPlan } = await import('../src/ci-github.js');
  const { initProofDir } = await import('../src/init.js');
  const { tmpRepo } = await import('./helpers.js');
  assert.equal(requiredChecksPlan('.', withDefaults({ ci: { branch: 'main' } })).require_up_to_date, true);
  assert.equal(requiredChecksPlan('.', withDefaults({ ci: { branch: 'main', require_up_to_date: false } })).require_up_to_date, false);
  const dir = tmpRepo();
  initProofDir(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.proof/config.json'), 'utf8'));
  assert.equal(cfg.ci.require_up_to_date, true);
  // The written ci block adds to the defaults; it doesn't replace the protected CI files.
  assert.ok(withDefaults(cfg).ci.files.includes('.github/workflows/**'));
});
