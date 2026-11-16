// Local mode (ci.mode "local"): no CI by choice. init --local, pocp ci off / on, what doctor
// says in each state (including Actions jobs that never start for billing), and the gate
// naming you, not CI, as the approver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, read, sampleRepo, tmpRepo, write, writeConfig } from './helpers.js';

const check = (r, id) => r.json.checks.filter((c) => c.id === id);
const config = (dir) => JSON.parse(read(dir, '.proof/config.json'));

/**
 * A fake gh: `repo view` answers me/site; `api [-X M] <endpoint>` answers from the table by
 * endpoint (a miss exits 1). Every call is logged, one per line, to <dir>-gh.log.
 */
function fakeGh(dir, table) {
  const file = path.join(dir, '..', `${path.basename(dir)}-gh.mjs`);
  const log = `${file}.log`;
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const table = ${JSON.stringify(table)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (args[0] === 'repo') {
  process.stdout.write(args.includes('--jq') ? 'me/site\\n' : JSON.stringify({ nameWithOwner: 'me/site', isPrivate: true }));
  process.exit(0);
}
const hit = table[args[args.length - 1]];
if (!hit) { process.stderr.write('HTTP 404: not found'); process.exit(1); }
process.stdout.write(JSON.stringify(hit.body ?? {}));
process.exit(hit.status || 0);
`);
  fs.chmodSync(file, 0o755);
  return { gh: file, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const WORKFLOWS = (states) => ({
  'repos/me/site/actions/workflows?per_page=100': {
    body: { workflows: Object.entries(states).map(([f, state], i) => ({ id: i + 1, path: `.github/workflows/${f}`, state })) },
  },
});

function githubRepo({ local = false } = {}) {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'block' }, ci: { branch: 'main', ...(local ? { mode: 'local' } : { required_checks: ['pocp'] }) } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'config');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/me/site.git');
  return dir;
}

test('init --local writes ci.mode "local", installs the hooks and says what it gives up', () => {
  const dir = tmpRepo();
  const r = pocp(dir, ['init', '--local']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(config(dir).ci.mode, 'local');
  assert.match(r.stdout, /hooks installed in/);
  assert.match(r.stdout, /local mode \(ci\.mode "local"\): .*nothing blocks a merge.*--no-verify/);
  assert.match(r.stdout, /before merging: pocp verify --rerun origin\/main\.\.HEAD/);
  assert.ok(!fs.existsSync(path.join(dir, '.github')), 'local mode writes no workflows');
  // Re-run on an existing .proof/: the mode is still set.
  const again = tmpRepo();
  pocp(again, ['init']);
  assert.equal(config(again).ci.mode, undefined);
  pocp(again, ['init', '--local']);
  assert.equal(config(again).ci.mode, 'local');
});

test('init refuses --local with --github, and plain init names the choice', () => {
  const both = pocp(tmpRepo(), ['init', '--local', '--github']);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /choose --github .* or --local/);
  const plain = pocp(tmpRepo(), ['init']);
  assert.match(plain.stdout, /CI: not set up\. Choose: pocp init --github .* or pocp init --local/);
});

test('ci.mode accepts only "github" and "local"', () => {
  const dir = sampleRepo();
  writeConfig(dir, { ci: { mode: 'none' } });
  const r = pocp(dir, ['rules', 'check']);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /ci\.mode must be "github" .* or "local"/);
});

test('ci off disables only POCP\'s active workflows, sets local mode, and points at the rest', () => {
  const dir = githubRepo();
  const { gh, calls } = fakeGh(dir, {
    ...WORKFLOWS({ 'pocp.yml': 'active', 'pocp-status.yml': 'active', 'pocp-labels.yml': 'disabled_manually', 'tests.yml': 'active' }),
    'repos/me/site/actions/workflows/1/disable': {},
    'repos/me/site/actions/workflows/2/disable': {},
    'repos/me/site/branches/main/protection': { body: { required_status_checks: { contexts: ['pocp'] } } },
  });
  const r = pocp(dir, ['ci', 'off'], { env: { POCP_GH: gh } });
  assert.equal(r.code, 0, r.stderr);
  const puts = calls().filter((c) => c.includes('PUT'));
  assert.deepEqual(puts, ['api -X PUT repos/me/site/actions/workflows/1/disable', 'api -X PUT repos/me/site/actions/workflows/2/disable']);
  assert.equal(config(dir).ci.mode, 'local');
  assert.match(r.stdout, /disabled on me\/site: \.github\/workflows\/pocp\.yml, \.github\/workflows\/pocp-status\.yml/);
  assert.match(r.stdout, /set ci\.mode "local" in \.proof\/config\.json: commit it/);
  assert.match(r.stdout, /branch protection on main requires "pocp", which nothing posts now/);
  assert.match(r.stdout, /not POCP's, left alone\): \.github\/workflows\/tests\.yml\n\s+to stop it: gh workflow disable tests\.yml/);
  assert.ok(!calls().some((c) => c.includes('workflows/4/')), 'tests.yml is never touched');
});

test('ci on enables them again and removes local mode', () => {
  const dir = githubRepo({ local: true });
  const { gh, calls } = fakeGh(dir, {
    ...WORKFLOWS({ 'pocp.yml': 'disabled_manually', 'pocp-status.yml': 'disabled_manually', 'pocp-labels.yml': 'active' }),
    'repos/me/site/actions/workflows/1/enable': {},
    'repos/me/site/actions/workflows/2/enable': {},
  });
  const r = pocp(dir, ['ci', 'on'], { env: { POCP_GH: gh } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(calls().filter((c) => c.includes('PUT')), ['api -X PUT repos/me/site/actions/workflows/1/enable', 'api -X PUT repos/me/site/actions/workflows/2/enable']);
  assert.equal(config(dir).ci.mode, undefined);
  assert.match(r.stdout, /removed ci\.mode "local" from \.proof\/config\.json/);
});

test('ci off / on change nothing locally when GitHub did not do it', () => {
  const dir = githubRepo();
  const before = read(dir, '.proof/config.json');
  const failing = fakeGh(dir, {});
  const off = pocp(dir, ['ci', 'off'], { env: { POCP_GH: failing.gh } });
  assert.equal(off.code, 1);
  assert.match(off.stdout, /nothing changed: could not list the workflows/);
  assert.equal(read(dir, '.proof/config.json'), before);

  const local = githubRepo({ local: true });
  const none = fakeGh(local, WORKFLOWS({ 'tests.yml': 'active' }));
  const on = pocp(local, ['ci', 'on'], { env: { POCP_GH: none.gh } });
  assert.equal(on.code, 2);
  assert.match(on.stdout, /no POCP workflows on me\/site.*pocp init --github writes them/);
  assert.equal(config(local).ci.mode, 'local');
});

test('doctor in local mode: no CI problems, and the trade stated once', () => {
  const dir = githubRepo({ local: true });
  const r = pocp(dir, ['doctor', '--offline', '--json']);
  assert.equal(r.json.ok, true, JSON.stringify(r.json.checks.filter((c) => c.status === 'problem')));
  assert.equal(check(r, 'workflow')[0].status, 'skipped');
  assert.equal(check(r, 'required-checks')[0].status, 'skipped');
  const note = check(r, 'local-mode')[0];
  assert.equal(note.status, 'warning');
  assert.match(note.why, /nothing blocks a merge.*--no-verify/);
  assert.match(note.fix, /pocp verify --rerun origin\/main\.\.HEAD/);
});

test('doctor flags POCP workflows that disagree with the mode', () => {
  const local = githubRepo({ local: true });
  const running = fakeGh(local, WORKFLOWS({ 'pocp.yml': 'active' }));
  const r = pocp(local, ['doctor', '--json'], { env: { POCP_GH: running.gh } });
  assert.equal(check(r, 'ci-mode')[0].status, 'warning');
  assert.equal(check(r, 'ci-mode')[0].fix, 'pocp ci off');
  assert.equal(check(r, 'labels').length, 0, 'local mode checks no labels');

  const ci = githubRepo();
  write(ci, '.github/workflows/pocp.yml', 'name: pocp\non: pull_request\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx pocp verify # pocp-approve-tests pocp-approve-policy\n');
  const off = fakeGh(ci, WORKFLOWS({ 'pocp.yml': 'disabled_manually' }));
  const d = pocp(ci, ['doctor', '--json'], { env: { POCP_GH: off.gh } });
  const c = check(d, 'ci-mode')[0];
  assert.equal(c.status, 'problem');
  assert.match(c.fix, /pocp ci on/);
});

test('doctor recognises Actions jobs that never start for billing, and suggests local mode', () => {
  const dir = githubRepo();
  const billing = 'The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings';
  const table = {
    ...WORKFLOWS({ 'pocp.yml': 'active', 'pocp-status.yml': 'active', 'tests.yml': 'active', 'old.yml': 'disabled_manually' }),
    'repos/me/site/actions/runs?per_page=20&status=completed': { body: { workflow_runs: [
      { id: 90, path: '.github/workflows/old.yml', conclusion: 'success' },
      { id: 91, path: '.github/workflows/tests.yml', conclusion: 'failure' },
    ] } },
    'repos/me/site/actions/runs/91/jobs': { body: { jobs: [{ id: 7, conclusion: 'failure', steps: [] }] } },
    'repos/me/site/check-runs/7/annotations': { body: [{ annotation_level: 'failure', message: billing }] },
  };
  const { gh } = fakeGh(dir, table);
  const r = pocp(dir, ['doctor', '--json'], { env: { POCP_GH: gh } });
  const c = check(r, 'actions-billing')[0];
  assert.equal(c.status, 'problem');
  assert.match(c.what, /not starting: The job was not started because recent account payments have failed/);
  assert.match(c.why, /3 workflow\(s\) that fail at once/);
  assert.match(c.fix, /^pocp ci off \(local mode\), then gh workflow disable tests\.yml; or fix billing/);

  // A job that ran and failed on its own merits is not a billing problem.
  const ordinary = githubRepo();
  const plain = fakeGh(ordinary, { ...table, 'repos/me/site/actions/runs/91/jobs': { body: { jobs: [{ id: 7, conclusion: 'failure', steps: [{ name: 'test' }] }] } } });
  assert.equal(check(pocp(ordinary, ['doctor', '--json'], { env: { POCP_GH: plain.gh } }), 'actions-billing').length, 0);
});

test('in local mode the gate names you, through verify, as the approver, not CI', () => {
  const dir = githubRepo({ local: true });
  write(dir, '.github/workflows/build.yml', 'name: build\non: push\njobs: {}\n');
  git(dir, 'add', '-A');
  const r = pocp(dir, ['gate', '--json']);
  const w = r.json.warnings.find((x) => x.code === 'awaiting_policy_approval');
  assert.ok(w, JSON.stringify(r.json.warnings));
  assert.match(w.detail, /in local mode you approve it before merging, after reading it: pocp verify --rerun <base>\.\.HEAD --accept-policy-change <head sha>/);
  assert.doesNotMatch(w.detail, /CI will ask/);
});

test('in local mode verify tells you how to approve what it waits on', () => {
  const dir = githubRepo({ local: true });
  write(dir, '.github/workflows/build.yml', 'name: build\non: push\njobs: {}\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'a workflow');
  const r = pocp(dir, ['verify', 'HEAD']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /local mode: you approve here\. After reading the change, run this again with --accept-test-change <head sha> \(or --accept-policy-change/);
});
