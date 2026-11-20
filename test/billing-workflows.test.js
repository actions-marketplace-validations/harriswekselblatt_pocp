// Workflows that fail only because GitHub Actions doesn't start their jobs for billing: found from
// GitHub's recorded responses (test/fixtures/github-billing/), offered for disabling by pocp ci off
// and pocp doctor in local mode, listed with their evidence, and disabled only on a yes or
// --disable-billing-failed, through GitHub's reversible "disable workflow" call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { billingCheck, billingFailedWorkflows, disableWorkflows, disabledCheck, disabledWorkflows, evidenceLines, ghProblem, offerDisable } from '../src/billing-workflows.js';
import { git, pocp, read, sampleRepo, writeConfig } from './helpers.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'github-billing');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const BILLING_JOBS = fixture('billing-jobs.json');
const BILLING_NOTES = fixture('billing-annotations.json');
const ORDINARY_JOBS = fixture('ordinary-jobs.json');
const ORDINARY_NOTES = fixture('ordinary-annotations.json');
const BILLING_MESSAGE = BILLING_NOTES.find((a) => a.annotation_level === 'failure').message;

// GitHub's workflows: POCP's two (still on), a CI workflow failing for billing, a lint workflow
// failing on its own, docs passing, one never run, one already disabled, and a dynamic one.
const WORKFLOWS = [
  { id: 1, name: 'pocp', path: '.github/workflows/pocp.yml', state: 'active' },
  { id: 2, name: 'pocp-status', path: '.github/workflows/pocp-status.yml', state: 'active' },
  { id: 301, name: 'test', path: '.github/workflows/test.yml', state: 'active' },
  { id: 302, name: 'lint', path: '.github/workflows/lint.yml', state: 'active' },
  { id: 303, name: 'docs', path: '.github/workflows/docs.yml', state: 'active' },
  { id: 304, name: 'release', path: '.github/workflows/release.yml', state: 'active' },
  { id: 305, name: 'old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
  { id: 306, name: 'Dependabot Updates', path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
];
const run = (id, workflowId, p, conclusion, created = '2026-11-19T23:39:00Z') => ({ id, workflow_id: workflowId, path: p, status: 'completed', conclusion, event: 'push', head_branch: 'main', head_repository: { full_name: 'me/site' }, created_at: created, html_url: `https://github.com/me/site/actions/runs/${id}` });

/** GitHub as gh api answers it, by endpoint: a body, or { status, message } for an error. */
function table({ pocpBilling = true } = {}) {
  return {
    'repos/me/site': { full_name: 'me/site', default_branch: 'main', private: true },
    // Newest first, as GitHub lists them: the outage's blocked runs, then older runs from before it.
    'repos/me/site/actions/runs?per_page=20&status=completed': { workflow_runs: [
      run(5004, 1, '.github/workflows/pocp.yml', 'failure'),
      run(5001, 301, '.github/workflows/test.yml', 'failure'),
      run(5002, 302, '.github/workflows/lint.yml', 'failure', '2026-11-18T10:00:00Z'),
      run(5003, 303, '.github/workflows/docs.yml', 'success', '2026-11-18T09:00:00Z'),
      run(4990, 301, '.github/workflows/test.yml', 'success', '2026-11-01T00:00:00Z'), // older: not the latest
      run(4991, 305, '.github/workflows/old.yml', 'failure', '2026-11-01T00:00:00Z'),
    ] },
    // pocp-status.yml and release.yml aren't in the recent runs: looked up one by one.
    'repos/me/site/actions/workflows/2/runs?per_page=10&status=completed&branch=main': { total_count: 0, workflow_runs: [] },
    'repos/me/site/actions/workflows/304/runs?per_page=10&status=completed&branch=main': { total_count: 0, workflow_runs: [] },
    'repos/me/site/actions/runs/5001/jobs': BILLING_JOBS,
    'repos/me/site/check-runs/7001/annotations': BILLING_NOTES,
    'repos/me/site/actions/runs/5002/jobs': ORDINARY_JOBS,
    'repos/me/site/check-runs/7101/annotations': ORDINARY_NOTES,
    'repos/me/site/actions/runs/5004/jobs': pocpBilling ? { total_count: 1, jobs: [{ ...BILLING_JOBS.jobs[0], id: 7201 }] } : ORDINARY_JOBS,
    'repos/me/site/check-runs/7201/annotations': BILLING_NOTES,
  };
}

/** An in-process gh for the unit tests: answers from the table, logs every call. */
function fakeCall(t, { missing = false } = {}) {
  const calls = [];
  const call = (args) => {
    calls.push(args.join(' '));
    if (missing) return { ok: false, missing: true, message: 'gh is not installed (https://cli.github.com)' };
    if (args[0] === 'repo') return { ok: true, json: { isPrivate: true }, message: '' };
    if (args.includes('PUT')) return { ok: true, json: null, message: '' };
    const hit = t[args[args.length - 1]];
    if (hit === undefined) return { ok: false, json: { message: 'Not Found' }, message: 'Not Found' };
    if (hit.status) return { ok: false, json: { message: hit.message }, message: hit.message };
    return { ok: true, json: hit, message: '' };
  };
  return { call, calls };
}

test('the recorded billing failure: jobs never started, and GitHub says why', () => {
  // The shape this feature relies on, as GitHub returned it.
  assert.ok(BILLING_JOBS.jobs.length > 0);
  for (const j of BILLING_JOBS.jobs) {
    assert.equal(j.conclusion, 'failure');
    assert.deepEqual(j.steps, []);
  }
  assert.match(BILLING_MESSAGE, /^The job was not started because recent account payments have failed or your spending limit needs to be increased/);
  assert.ok(ORDINARY_JOBS.jobs[0].steps.length > 0);
});

test('only workflows with all the evidence are found: a billing failure, not an ordinary one', () => {
  const { call } = fakeCall(table());
  const r = billingFailedWorkflows('me/site', WORKFLOWS, { call });
  assert.equal(r.incomplete, null);
  assert.deepEqual(r.found.map((w) => w.path), ['.github/workflows/pocp.yml', '.github/workflows/test.yml']);
  const t = r.found.find((w) => w.file === 'test.yml');
  assert.deepEqual(t, {
    id: 301,
    name: 'test',
    path: '.github/workflows/test.yml',
    file: 'test.yml',
    pocp: false,
    run: { id: 5001, conclusion: 'failure', event: 'push', created_at: '2026-11-19T23:39:00Z', url: 'https://github.com/me/site/actions/runs/5001' },
    message: BILLING_MESSAGE,
  });
  // POCP's own is found, and marked: ci off switches it, so it is never offered here.
  assert.equal(r.found.find((w) => w.file === 'pocp.yml').pocp, true);
  // Never run, disabled, dynamic, passing, or failing on its own: not found and not unchecked.
  assert.deepEqual(r.unchecked, []);
});

test('a job that ran is never evidence, whatever its annotation says', () => {
  const t = table();
  t['repos/me/site/check-runs/7101/annotations'] = [{ annotation_level: 'failure', message: 'echo: your spending limit needs to be increased' }];
  const { call, calls } = fakeCall(t);
  const r = billingFailedWorkflows('me/site', WORKFLOWS, { call });
  assert.ok(!r.found.some((w) => w.file === 'lint.yml'));
  assert.ok(!calls.includes('api repos/me/site/check-runs/7101/annotations'), 'a job with steps is not even asked about');
  // A notice that mentions billing isn't the failure GitHub gives an unstarted job either.
  const n = table();
  n['repos/me/site/check-runs/7001/annotations'] = [{ annotation_level: 'notice', message: BILLING_MESSAGE }];
  assert.ok(!billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(n)).found.some((w) => w.file === 'test.yml'));
});

test('no runs at all, or only an older failure: nothing found', () => {
  const t = table();
  t['repos/me/site/actions/runs?per_page=20&status=completed'] = { total_count: 0, workflow_runs: [] };
  for (const id of [1, 301, 302, 303]) t[`repos/me/site/actions/workflows/${id}/runs?per_page=10&status=completed&branch=main`] = { total_count: 0, workflow_runs: [] };
  const r = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t));
  assert.deepEqual(r, { found: [], unchecked: [], incomplete: null });

  // The billing failure is older than a passing run: billing was fixed, nothing to offer.
  const fixed = table();
  fixed['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.unshift(run(5100, 301, '.github/workflows/test.yml', 'success'));
  assert.ok(!billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(fixed)).found.some((w) => w.file === 'test.yml'));
});

test('a workflow missing from the recent runs is looked up on its own', () => {
  const t = table();
  // Only the outage in the recent runs: nothing newer started.
  t['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.splice(2);
  for (const id of [302, 303]) t[`repos/me/site/actions/workflows/${id}/runs?per_page=10&status=completed&branch=main`] = { total_count: 0, workflow_runs: [] };
  t['repos/me/site/actions/workflows/304/runs?per_page=10&status=completed&branch=main'] = { total_count: 1, workflow_runs: [run(4000, 304, '.github/workflows/release.yml', 'failure')] };
  t['repos/me/site/actions/runs/4000/jobs'] = { total_count: 1, jobs: [{ ...BILLING_JOBS.jobs[0], id: 7301 }] };
  t['repos/me/site/check-runs/7301/annotations'] = BILLING_NOTES;
  const r = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t));
  assert.ok(r.found.some((w) => w.file === 'release.yml' && w.run.id === 4000));
});

test('billing fixed since: a newer run that started makes an old blocked run no evidence', () => {
  // Another workflow passed after the blocked runs: Actions starts jobs again.
  const t = table();
  t['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.unshift(run(5200, 303, '.github/workflows/docs.yml', 'success'));
  assert.deepEqual(billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t)).found, []);
  // A newer run that failed on its own also started its jobs.
  const ran = table();
  ran['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.unshift(run(5201, 302, '.github/workflows/lint.yml', 'failure'));
  ran['repos/me/site/actions/runs/5201/jobs'] = ORDINARY_JOBS;
  assert.deepEqual(billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(ran)).found, []);
  // A newer success from a workflow since disabled doesn't count: only active workflows do.
  const off = table();
  off['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.unshift(run(5202, 305, '.github/workflows/old.yml', 'success'));
  assert.equal(billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(off)).found.length, 2);
});

test('every job unstarted: a run where some jobs ran is not offered; jobs skipped behind the blocked one are fine', () => {
  // A paid runner blocked beside free runners that ran: disabling would stop working jobs.
  const mixed = table();
  mixed['repos/me/site/actions/runs/5001/jobs'] = { total_count: 2, jobs: [BILLING_JOBS.jobs[0], { ...ORDINARY_JOBS.jobs[0], id: 7102, conclusion: 'success' }] };
  assert.ok(!billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(mixed)).found.some((w) => w.file === 'test.yml'));
  // A job that `needs:` the blocked one is skipped, with no steps either.
  const chain = table();
  chain['repos/me/site/actions/runs/5001/jobs'] = { total_count: 2, jobs: [{ ...BILLING_JOBS.jobs[0], id: 7103, name: 'deploy', conclusion: 'skipped' }, BILLING_JOBS.jobs[0]] };
  assert.ok(billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(chain)).found.some((w) => w.file === 'test.yml'));
});

test('evidence comes only from the default branch of this repository: a pull request or a fork can push a run built to fail', () => {
  const offered = (t) => billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t)).found.map((w) => w.file);
  // test.yml's latest run on main passed; a newer billing-shaped run is on a pull request branch.
  const pr = table();
  pr['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.splice(1, 1,
    { ...run(5001, 301, '.github/workflows/test.yml', 'failure'), event: 'pull_request', head_branch: 'feature' },
    run(5005, 301, '.github/workflows/test.yml', 'success', '2026-11-18T12:00:00Z'));
  assert.ok(!offered(pr).includes('test.yml'), 'a pull request branch is not evidence');
  // A fork's branch named main, pushed through a pull request or not: not this repository's main.
  for (const fork of [{ event: 'pull_request', head_repository: { full_name: 'someone/site' } }, { event: 'push', head_repository: { full_name: 'someone/site' } }, { event: 'pull_request_target' }]) {
    const t = table();
    Object.assign(t['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs[1], fork);
    t['repos/me/site/actions/workflows/301/runs?per_page=10&status=completed&branch=main'] = { total_count: 0, workflow_runs: [] };
    assert.ok(!offered(t).includes('test.yml'), JSON.stringify(fork));
  }
  // Looked up on its own, the first run of the default branch that qualifies is the evidence.
  const one = table();
  one['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.splice(1, 1);
  one['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.splice(3, 1); // the older test.yml run
  one['repos/me/site/actions/workflows/301/runs?per_page=10&status=completed&branch=main'] = { total_count: 2, workflow_runs: [
    { ...run(5001, 301, '.github/workflows/test.yml', 'failure'), head_repository: { full_name: 'someone/site' } },
    run(4990, 301, '.github/workflows/test.yml', 'success', '2026-11-01T00:00:00Z'),
  ] };
  assert.ok(!offered(one).includes('test.yml'), 'the fork run is skipped; the run that counts passed');
  // Default branch unknown: the scan stops rather than take any branch's runs.
  const nobranch = table();
  nobranch['repos/me/site'] = { full_name: 'me/site' };
  const r = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(nobranch));
  assert.deepEqual(r.found, []);
  assert.match(r.incomplete, /did not say which branch is the default/);
});

test('billing fixed since, shown by a newer run on another branch that started and failed on its own', () => {
  const t = table();
  t['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs.unshift({ ...run(5300, 301, '.github/workflows/test.yml', 'failure'), event: 'pull_request', head_branch: 'feature' });
  t['repos/me/site/actions/runs/5300/jobs'] = ORDINARY_JOBS;
  const { call, calls } = fakeCall(t);
  const r = billingFailedWorkflows('me/site', WORKFLOWS, { call });
  assert.deepEqual(r.found, [], 'its jobs ran: billing works, so neither blocked run counts');
  assert.ok(calls.includes('api repos/me/site/actions/runs/5300/jobs'));
  // A newer failure whose jobs can't be read leaves the older blocked runs unchecked, not offered.
  delete t['repos/me/site/actions/runs/5300/jobs'];
  const unread = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t));
  assert.deepEqual(unread.found, []);
  assert.deepEqual(unread.unchecked.sort(), ['.github/workflows/pocp.yml', '.github/workflows/test.yml']);
  // A newer blocked run on a pull request branch is no sign billing works: test.yml stays found.
  t['repos/me/site/actions/runs/5300/jobs'] = BILLING_JOBS;
  assert.ok(billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t)).found.some((w) => w.file === 'test.yml'));
});

test('doctor with CI reports a block seen on any branch (POCP runs only on pull requests); it disables nothing', () => {
  const t = table();
  for (const r of t['repos/me/site/actions/runs?per_page=20&status=completed'].workflow_runs) Object.assign(r, { event: 'pull_request', head_branch: 'feature' });
  delete t['repos/me/site'];
  const ci = billingCheck({ repo: 'me/site', workflows: WORKFLOWS, local: false, call: fakeCall(t).call });
  assert.equal(ci.status, 'problem');
  assert.deepEqual(ci.workflows.map((w) => w.file), ['pocp.yml', 'test.yml']);
  // In local mode, where workflows get disabled, the same pull request runs are no evidence.
  t['repos/me/site'] = { default_branch: 'main' };
  for (const id of [1, 2, 301, 302, 303, 304]) t[`repos/me/site/actions/workflows/${id}/runs?per_page=10&status=completed&branch=main`] = { total_count: 0, workflow_runs: [] };
  assert.equal(billingCheck({ repo: 'me/site', workflows: WORKFLOWS, local: true, call: fakeCall(t).call }), null);
});

test('unreadable answers: one workflow stays unchecked; a rate limit stops the scan and offers nothing', () => {
  const t = table();
  delete t['repos/me/site/actions/runs/5002/jobs'];
  const one = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(t));
  assert.deepEqual(one.unchecked, ['.github/workflows/lint.yml']);
  assert.ok(one.found.some((w) => w.file === 'test.yml'));

  const limited = table();
  limited['repos/me/site/actions/runs/5002/jobs'] = { status: 403, message: 'API rate limit exceeded for user ID 1.' };
  const r = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(limited));
  assert.deepEqual(r.found, [], 'test.yml was found before the limit, and is still not offered');
  assert.match(r.incomplete, /rate limit is reached; try again once it resets/);

  const first = table();
  first['repos/me/site/actions/runs?per_page=20&status=completed'] = { status: 429, message: 'You have exceeded a secondary rate limit.' };
  assert.match(billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(first)).incomplete, /rate limit/);
});

test('gh missing or not logged in: the scan says so and stops', () => {
  const missing = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall({}, { missing: true }));
  assert.equal(missing.found.length, 0);
  assert.match(missing.incomplete, /not installed \(https:\/\/cli\.github\.com\)/);
  assert.equal(ghProblem({ ok: false, message: 'To get started with GitHub CLI, please run:  gh auth login' }).reason, 'gh is not logged in: run gh auth login');
  assert.equal(ghProblem({ ok: false, message: 'HTTP 401: Bad credentials (https://api.github.com/user)' }).reason, 'gh is not logged in: run gh auth login');
});

test('the evidence says what billing means for a private and a public repository', () => {
  const found = billingFailedWorkflows('me/site', WORKFLOWS, fakeCall(table())).found.filter((w) => !w.pocp);
  const priv = evidenceLines('me/site', found, true).join('\n');
  assert.match(priv, /1 workflow\(s\) on me\/site fail because GitHub Actions doesn't start their jobs for billing:/);
  assert.match(priv, /test \(\.github\/workflows\/test\.yml\): latest run 5001 on 2026-11-19: failure, "The job was not started because recent account payments have failed or your spending limit needs to be increased"/);
  assert.match(priv, /private, so its jobs spend the account's Actions minutes/);
  assert.match(evidenceLines('me/site', found, false).join('\n'), /public, where standard GitHub-hosted runners are free/);
  assert.doesNotMatch(evidenceLines('me/site', found, null).join('\n'), /private|public/);
});

test('declined: nothing is disabled, and the way to do it later is printed', async () => {
  const { call, calls } = fakeCall(table());
  const found = billingFailedWorkflows('me/site', WORKFLOWS, { call }).found.filter((w) => !w.pocp);
  const said = [];
  const asked = [];
  const r = await offerDisable({ repo: 'me/site', found, isPrivate: true, interactive: true, ask: async (q) => { asked.push(q); return 'n'; }, say: (l) => said.push(l), retry: 'pocp ci off --disable-billing-failed', call });
  assert.equal(r.decision, 'declined');
  assert.deepEqual(r.disabled, []);
  assert.equal(asked.length, 1, 'one question for all of them');
  assert.match(asked[0], /Disable it on GitHub\? The workflow files stay as they are, and gh workflow enable <file> turns one back on\. \[y\/N\]/);
  assert.ok(!calls.some((c) => c.includes('PUT')), calls.join('\n'));
  assert.match(said.join('\n'), /left as they are\. Later: pocp ci off --disable-billing-failed, or gh workflow disable <file>/);
  // An empty answer is a no.
  const blank = await offerDisable({ repo: 'me/site', found, interactive: true, ask: async () => '', retry: 'x', call });
  assert.equal(blank.decision, 'declined');
});

test('accepted: each is disabled through GitHub\'s reversible call, and how to undo it is printed', async () => {
  const { call, calls } = fakeCall(table());
  const found = billingFailedWorkflows('me/site', WORKFLOWS, { call }).found.filter((w) => !w.pocp);
  const said = [];
  const r = await offerDisable({ repo: 'me/site', found, interactive: true, ask: async () => 'y', say: (l) => said.push(l), retry: 'x', call });
  assert.equal(r.decision, 'disabled');
  assert.deepEqual(r.disabled, ['.github/workflows/test.yml']);
  assert.deepEqual(calls.filter((c) => c.includes('PUT')), ['api -X PUT repos/me/site/actions/workflows/301/disable']);
  assert.match(said.join('\n'), /disabled on me\/site: \.github\/workflows\/test\.yml \(the files are unchanged\)\n {2}to turn it back on: gh workflow enable test\.yml/);
});

test('non-interactive: report only, unless --disable-billing-failed', async () => {
  const { call, calls } = fakeCall(table());
  const found = billingFailedWorkflows('me/site', WORKFLOWS, { call }).found.filter((w) => !w.pocp);
  const said = [];
  const ask = () => assert.fail('nothing is asked without a terminal');
  const report = await offerDisable({ repo: 'me/site', found, interactive: false, ask, say: (l) => said.push(l), retry: 'pocp doctor --disable-billing-failed', call });
  assert.equal(report.decision, 'report-only');
  assert.ok(!calls.some((c) => c.includes('PUT')));
  assert.match(said.join('\n'), /not disabled \(nothing was asked: no terminal, or --json\)\. To disable them: pocp doctor --disable-billing-failed/);
  const forced = await offerDisable({ repo: 'me/site', found, disable: true, interactive: true, ask, retry: 'x', call });
  assert.deepEqual(forced.disabled, ['.github/workflows/test.yml']);
});

test('a disable GitHub refuses is reported, not hidden', () => {
  const call = (args) => (args.includes('PUT') ? { ok: false, json: { message: 'Resource not accessible by integration' }, message: 'Resource not accessible by integration' } : { ok: true, json: {} });
  const r = disableWorkflows('me/site', [{ id: 301, path: '.github/workflows/test.yml' }], { call });
  assert.deepEqual(r, { disabled: [], failed: [{ path: '.github/workflows/test.yml', error: 'Resource not accessible by integration' }] });
});

test('doctor\'s check: in local mode it offers only the workflows that aren\'t POCP\'s', () => {
  const local = billingCheck({ repo: 'me/site', workflows: WORKFLOWS, local: true, isPrivate: true, call: fakeCall(table()).call });
  assert.equal(local.status, 'warning');
  assert.deepEqual(local.offer.map((w) => w.path), ['.github/workflows/test.yml']);
  assert.match(local.fix, /^pocp ci off \(POCP's own\), then pocp doctor --disable-billing-failed/);
  // With CI: the problem it always was, solved by local mode.
  const ci = billingCheck({ repo: 'me/site', workflows: WORKFLOWS, local: false, call: fakeCall(table()).call });
  assert.equal(ci.status, 'problem');
  assert.equal(ci.offer, undefined);
  assert.match(ci.fix, /^pocp ci off \(local mode\)/);
  // Nothing failing for billing: no check.
  assert.equal(billingCheck({ repo: 'me/site', workflows: WORKFLOWS.filter((w) => w.id === 303), local: true, call: fakeCall(table()).call }), null);
});

// End to end, with a fake gh serving the same responses.

function fakeGh(dir, t) {
  const file = path.join(dir, '..', `${path.basename(dir)}-gh.mjs`);
  const log = `${file}.log`;
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const table = ${JSON.stringify(t)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (args[0] === 'repo') {
  process.stdout.write(args.includes('--jq') ? 'me/site\\n' : JSON.stringify({ nameWithOwner: 'me/site', isPrivate: true }));
  process.exit(0);
}
if (args.includes('PUT')) process.exit(0);
const hit = table[args[args.length - 1]];
if (!hit) { process.stdout.write(JSON.stringify({ message: 'Not Found' })); process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
if (hit.status) { process.stdout.write(JSON.stringify({ message: hit.message })); process.stderr.write('gh: ' + hit.message + ' (HTTP ' + hit.status + ')'); process.exit(1); }
process.stdout.write(JSON.stringify(hit));
`);
  fs.chmodSync(file, 0o755);
  return { gh: file, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function githubRepo({ local = false } = {}) {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'block' }, ci: { branch: 'main', ...(local ? { mode: 'local' } : { required_checks: ['pocp'] }) } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'config');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/me/site.git');
  return dir;
}

const ghTable = (workflows = WORKFLOWS, extra = {}) => ({
  'repos/me/site/actions/workflows?per_page=100': { workflows },
  'repos/me/site/branches/main/protection': { required_status_checks: { contexts: [] } },
  ...table(),
  ...extra,
});
const env = (gh) => ({ env: { POCP_GH: gh, CI: '' } });

test('ci off, not on a terminal: lists the billing failures with their evidence, disables none of them', () => {
  const dir = githubRepo();
  const { gh, calls } = fakeGh(dir, ghTable());
  const r = pocp(dir, ['ci', 'off'], env(gh));
  assert.equal(r.code, 0, r.stderr);
  // POCP's own: ci off disables them as always, and only them.
  assert.deepEqual(calls().filter((c) => c.includes('PUT')), ['api -X PUT repos/me/site/actions/workflows/1/disable', 'api -X PUT repos/me/site/actions/workflows/2/disable']);
  assert.match(r.stdout, /1 workflow\(s\) on me\/site fail because GitHub Actions doesn't start their jobs for billing:\n {2}test \(\.github\/workflows\/test\.yml\): latest run 5001 on 2026-11-19: failure, "The job was not started because recent account payments have failed/);
  assert.match(r.stdout, /not disabled \(nothing was asked: no terminal, or --json\)\. To disable them: pocp ci off --disable-billing-failed/);
  assert.doesNotMatch(r.stdout, /lint\.yml\): latest run/, 'an ordinary failure is not offered');
  assert.equal(JSON.parse(read(dir, '.proof/config.json')).ci.mode, 'local');
});

test('ci off --disable-billing-failed --json: disables only those, in one JSON document', () => {
  const dir = githubRepo();
  const { gh, calls } = fakeGh(dir, ghTable());
  const r = pocp(dir, ['ci', 'off', '--disable-billing-failed', '--json'], env(gh));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json, `one JSON document:\n${r.stdout}`);
  assert.deepEqual(r.json.billing_failed.disabled, ['.github/workflows/test.yml']);
  assert.equal(r.json.billing_failed.decision, 'disabled');
  assert.equal(r.json.billing_failed.found[0].run.id, 5001);
  const puts = calls().filter((c) => c.includes('PUT'));
  assert.deepEqual(puts, ['api -X PUT repos/me/site/actions/workflows/1/disable', 'api -X PUT repos/me/site/actions/workflows/2/disable', 'api -X PUT repos/me/site/actions/workflows/301/disable']);
  assert.ok(!puts.some((c) => /workflows\/302\//.test(c)), 'lint.yml failed on its own: never touched');
  // --json alone reports and acts on nothing.
  const quiet = githubRepo();
  const q = fakeGh(quiet, ghTable());
  const report = pocp(quiet, ['ci', 'off', '--json'], env(q.gh));
  assert.equal(report.json.billing_failed.decision, 'report-only');
  assert.equal(report.json.billing_failed.found.length, 1);
  assert.ok(!q.calls().some((c) => c.includes('workflows/301/disable')));
});

test('ci off when the check can\'t finish: says so, offers nothing, still succeeds', () => {
  const dir = githubRepo();
  const { gh, calls } = fakeGh(dir, ghTable(WORKFLOWS, { 'repos/me/site/actions/runs?per_page=20&status=completed': { status: 403, message: 'API rate limit exceeded for user ID 1.' } }));
  const r = pocp(dir, ['ci', 'off', '--disable-billing-failed'], env(gh));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /could not check whether the other workflows fail for billing: GitHub's API rate limit is reached/);
  assert.ok(!calls().some((c) => c.includes('workflows/301/disable')));
});

test('doctor in local mode: reports the billing failures; acts only with --disable-billing-failed', () => {
  const dir = githubRepo({ local: true });
  const off = WORKFLOWS.map((w) => (w.id <= 2 ? { ...w, state: 'disabled_manually' } : w));
  const { gh, calls } = fakeGh(dir, ghTable(off));
  const r = pocp(dir, ['doctor', '--json'], env(gh));
  const c = r.json.checks.find((x) => x.id === 'actions-billing');
  assert.equal(c.status, 'warning');
  assert.deepEqual(c.offer.map((w) => w.file), ['test.yml']);
  assert.equal(c.private, true);
  assert.ok(!calls().some((x) => x.includes('PUT')), 'doctor --json changes nothing');

  const human = pocp(dir, ['doctor'], env(gh));
  assert.match(human.stdout, /note 1 workflow\(s\) on me\/site fail because GitHub Actions doesn't start their jobs for billing: \.github\/workflows\/test\.yml/);
  assert.match(human.stdout, /latest run 5001 on 2026-11-19: failure/);
  assert.match(human.stdout, /To disable them: pocp doctor --disable-billing-failed/);
  assert.ok(!calls().some((x) => x.includes('PUT')));

  const act = pocp(dir, ['doctor', '--disable-billing-failed', '--json'], env(gh));
  assert.deepEqual(act.json.billing_failed.disabled, ['.github/workflows/test.yml']);
  assert.deepEqual(calls().filter((x) => x.includes('PUT')), ['api -X PUT repos/me/site/actions/workflows/301/disable']);
});

test('workflows disabled on GitHub are listed, with how to turn each back on: doctor and ci on', () => {
  const off = WORKFLOWS.map((w) => (w.id === 2 || w.id === 301 ? { ...w, state: 'disabled_manually' } : w));
  // POCP's own (ci on / off switch them) and dynamic ones aren't listed; GitHub doesn't say who disabled the rest.
  assert.deepEqual(disabledWorkflows(off).map((w) => w.file), ['test.yml', 'old.yml']);
  const c = disabledCheck({ repo: 'me/site', workflows: off });
  assert.equal(c.status, 'warning');
  assert.match(c.fix, /^gh workflow enable test\.yml, then gh workflow enable old\.yml/);
  assert.equal(disabledCheck({ repo: 'me/site', workflows: WORKFLOWS.filter((w) => w.state === 'active') }), null);

  const dir = githubRepo({ local: true });
  const { gh } = fakeGh(dir, ghTable(off));
  const doc = pocp(dir, ['doctor', '--json'], env(gh));
  assert.deepEqual(doc.json.checks.find((x) => x.id === 'workflows-disabled').workflows.map((w) => w.file), ['test.yml', 'old.yml']);
  assert.match(pocp(dir, ['doctor'], env(gh)).stdout, /2 workflow\(s\) on me\/site are disabled on GitHub, so their checks don't run/);

  const on = pocp(dir, ['ci', 'on'], env(gh));
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /2 workflow\(s\) on me\/site are disabled on GitHub, so their checks don't run:\n {2}test \(\.github\/workflows\/test\.yml\): to turn it back on: gh workflow enable test\.yml/);
  const again = githubRepo({ local: true });
  const j = fakeGh(again, ghTable(off));
  const onJson = pocp(again, ['ci', 'on', '--json'], env(j.gh));
  assert.deepEqual(onJson.json.workflows_disabled.map((w) => w.file), ['test.yml', 'old.yml']);
  assert.ok(!j.calls().some((x) => /workflows\/(301|305)\/enable/.test(x)), 'listed, never re-enabled without being asked');
});

test('--disable-billing-failed is refused where it can\'t apply', () => {
  const dir = githubRepo({ local: true });
  assert.equal(pocp(dir, ['doctor', '--offline', '--disable-billing-failed']).code, 2);
  assert.equal(pocp(dir, ['ci', 'on', '--disable-billing-failed']).code, 2);
  assert.equal(pocp(dir, ['ci', 'required', '--disable-billing-failed']).code, 2);
});

test('doctor --disable-billing-failed says why it could not check: gh missing, logged out, rate-limited', () => {
  const dir = githubRepo({ local: true });
  const missing = pocp(dir, ['doctor', '--disable-billing-failed'], env(path.join(dir, 'no-such-gh')));
  assert.match(missing.stdout, /--disable-billing-failed: nothing disabled, because it could not check: could not ask GitHub \(gh is not installed\)/);
  assert.equal(pocp(dir, ['doctor', '--disable-billing-failed', '--json'], env(path.join(dir, 'no-such-gh'))).json.billing_failed.decision, 'unchecked');

  const loggedOut = path.join(dir, '..', `${path.basename(dir)}-gh-out.sh`);
  fs.writeFileSync(loggedOut, '#!/bin/sh\necho "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4\n');
  fs.chmodSync(loggedOut, 0o755);
  const out = pocp(dir, ['doctor', '--disable-billing-failed', '--json'], env(loggedOut));
  assert.equal(out.json.billing_failed.decision, 'unchecked');
  assert.match(out.json.billing_failed.reason, /gh auth login/);

  const off = WORKFLOWS.map((w) => (w.id <= 2 ? { ...w, state: 'disabled_manually' } : w));
  const { gh, calls } = fakeGh(dir, ghTable(off, { 'repos/me/site/actions/runs?per_page=20&status=completed': { status: 403, message: 'API rate limit exceeded for user ID 1.' } }));
  const limited = pocp(dir, ['doctor', '--disable-billing-failed', '--json'], env(gh));
  assert.equal(limited.json.billing_failed.decision, 'unchecked');
  assert.match(limited.json.billing_failed.reason, /rate limit is reached/);
  assert.ok(!calls().some((c) => c.includes('PUT')));

  // Checked, and nothing found: said apart from "could not check".
  const clean = fakeGh(dir, ghTable(off.filter((w) => w.id !== 301)));
  const none = pocp(dir, ['doctor', '--disable-billing-failed'], env(clean.gh));
  assert.match(none.stdout, /--disable-billing-failed: nothing to disable: no active workflow fails/);
});
