// An approval turns the pocp status green from the run that already waits for it, without running
// verify again, only when that run was isolated and said it waits for approvals only
// (`approvable`), and every label it waits for and relied on is given by a writer after this
// head's first run. Anything else is judged exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStatus, predictApproval, runMarker, TEXT, workflowFiles } from '../src/status-report.js';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };
const FIRST_RUN = '2026-11-07T10:00:00Z';
const AFTER = '2026-11-07T11:00:00Z';

// A waiting run's verify job: `extra` adds steps (approvable, needs-*, approval-*) by name.
function waitingJob(extra = [], { outcome = 'waiting' } = {}) {
  const ran = (n) => ({ name: n, conclusion: 'success' });
  const skipped = (n) => ({ name: n, conclusion: 'skipped' });
  return {
    status: 'completed',
    conclusion: 'success',
    steps: [
      ran(runMarker(7, BASE)),
      { name: 'verify', conclusion: 'failure' },
      ...extra.map(ran),
      skipped('verified'),
      outcome === 'waiting' ? ran('waiting') : skipped('waiting'),
      outcome === 'inconclusive' ? ran('inconclusive') : skipped('inconclusive'),
      outcome === 'failed' ? { name: 'failed', conclusion: 'failure' } : skipped('failed'),
    ],
  };
}
const run = (job, over = {}) => ({
  id: 100, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: 'o/r',
  status: 'completed', conclusion: job.conclusion, created_at: FIRST_RUN, run_started_at: FIRST_RUN, run_attempt: 1, html_url: 'u', job, ...over,
});
const given = (label, at = AFTER, permission = 'write') => ({ label, actor: 'maintainer', permission, created_at: at });
function facts({ job, labels = [], events, runs, files = [{ filename: 'src/a.js' }] } = {}) {
  return {
    event_sha: SHA, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null), base_sha: BASE, head_prs: [7], incomplete: [],
    pr: { number: 7, state: 'open', head_sha: SHA, labels, author: 'author' },
    files, changed_files: files.length, label_events: events ?? labels.map((l) => given(l)), label_events_complete: true, force_pushes: [],
    runs: runs || [run(job)],
  };
}

test('a wait for approvals only, all given by a writer after the first run: green, from that run', () => {
  const d = decideStatus(facts({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), labels: ['pocp-approve-tests'] }));
  assert.equal(d.state, 'success', d.reason);
  assert.equal(d.description, TEXT.approved);
  assert.match(d.reason, /waited only for pocp-approve-tests/);
});

test('only a review-only wait turns green without a new run: a behaviour change, or no readable verdict, re-runs verify with the label', () => {
  for (const extra of [['verdict-behavior-changed'], ['verdict-detection-dropped'], ['verdict-baseline-red'], []]) {
    const d = decideStatus(facts({ job: waitingJob(['needs-tests', 'approvable', ...extra]), labels: ['pocp-approve-tests'] }));
    assert.equal(d.state, 'pending', extra.join() || 'no verdict');
    assert.notEqual(d.description, TEXT.approved);
  }
});

test('an inconclusive run never turns green on a label: a run that finishes decides', () => {
  const d = decideStatus(facts({ job: waitingJob(['needs-inconclusive', 'approvable'], { outcome: 'inconclusive' }), labels: ['pocp-approve-inconclusive'] }));
  assert.equal(d.state, 'pending', d.reason);
  const tests = decideStatus(facts({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review'], { outcome: 'inconclusive' }), labels: ['pocp-approve-tests'] }));
  assert.equal(tests.state, 'pending', tests.reason);
});

test('without the approvable step (an older workflow, or checks not isolated): pending, as before', () => {
  const d = decideStatus(facts({ job: waitingJob(['needs-tests']), labels: ['pocp-approve-tests'] }));
  assert.equal(d.state, 'pending');
  assert.notEqual(d.description, TEXT.approved);
});

test('a wait that needs a policy approval is decided by a new run, even with every label on', () => {
  // Accepting a policy change changes which rules judge the run.
  const d = decideStatus(facts({ job: waitingJob(['needs-tests', 'needs-policy', 'approvable']), labels: ['pocp-approve-tests', 'pocp-approve-policy'] }));
  assert.equal(d.state, 'pending', d.reason);
  assert.notEqual(d.description, TEXT.approved);
});

test('a label given before the head first ran, or by someone without write access, does not count', () => {
  for (const [why, ev] of [['before the first run', given('pocp-approve-tests', '2026-11-07T09:00:00Z')], ['triage', given('pocp-approve-tests', AFTER, 'triage')]]) {
    const d = decideStatus(facts({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), labels: ['pocp-approve-tests'], events: [ev] }));
    assert.equal(d.state, 'pending', why);
  }
});

test('an approval the waiting run already relied on must still be on, and fresh', () => {
  // The run was judged with the policy label already given, and still waits for tests.
  const job = waitingJob(['approval-policy', 'needs-tests', 'approvable', 'verdict-needs-review']);
  const gone = decideStatus(facts({ job, labels: ['pocp-approve-tests'] }));
  assert.equal(gone.state, 'pending', gone.reason);
  const kept = decideStatus(facts({ job, labels: ['pocp-approve-tests', 'pocp-approve-policy'] }));
  assert.equal(kept.state, 'success', kept.reason);
  const stale = decideStatus(facts({ job, labels: ['pocp-approve-tests', 'pocp-approve-policy'], events: [given('pocp-approve-tests'), given('pocp-approve-policy', '2026-11-07T09:00:00Z')] }));
  assert.equal(stale.state, 'pending', stale.reason);
});

test('a failed run never turns green, whatever steps it has', () => {
  const d = decideStatus(facts({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review'], { outcome: 'failed' }), labels: ['pocp-approve-tests'] }));
  assert.equal(d.state, 'failure');
});

test('an approvable step that names no label does not turn green', () => {
  const d = decideStatus(facts({ job: waitingJob(['approvable']), labels: ['pocp-approve-tests'] }));
  assert.equal(d.state, 'pending');
});

test("a pull request that changes CI files: the run's steps don't count until the workflow is approved", () => {
  const files = [{ filename: '.github/workflows/pocp.yml' }];
  const d = decideStatus(facts({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), labels: ['pocp-approve-tests'], files }));
  assert.equal(d.state, 'pending');
  assert.match(d.reason, /CI files changed/);
});

test('a newer run still underway, or a newer run that was cancelled: pending', () => {
  const job = waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']);
  const underway = decideStatus(facts({ job, labels: ['pocp-approve-tests'], runs: [run(job), run({ status: 'in_progress', conclusion: null, steps: [] }, { id: 101, status: 'in_progress', conclusion: null, created_at: AFTER, run_started_at: AFTER })] }));
  assert.equal(underway.state, 'pending');
  const cancelledJob = { ...waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), conclusion: 'cancelled' };
  const cancelled = decideStatus(facts({ job, labels: ['pocp-approve-tests'], runs: [run(job), run(cancelledJob, { id: 101, conclusion: 'cancelled', created_at: AFTER, run_started_at: AFTER })] }));
  assert.equal(cancelled.state, 'pending');
});

test('a run whose prediction skipped verify (approved-without-run) counts as no evaluation', () => {
  const job = waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']);
  const skippedJob = { status: 'completed', conclusion: 'success', steps: [
    { name: runMarker(7, BASE), conclusion: 'success' }, { name: 'approved-without-run', conclusion: 'success' },
    { name: 'verify', conclusion: 'skipped' }, { name: 'verified', conclusion: 'skipped' }, { name: 'waiting', conclusion: 'skipped' },
    { name: 'inconclusive', conclusion: 'skipped' }, { name: 'failed', conclusion: 'skipped' }] };
  const later = run(skippedJob, { id: 101, created_at: AFTER, run_started_at: AFTER });
  const d = decideStatus(facts({ job, labels: ['pocp-approve-tests'], runs: [run(job), later] }));
  assert.equal(d.state, 'success', d.reason);
  // A run that says approved-without-run but whose verify step ran is an evaluation, never set aside.
  const ran = { ...skippedJob, steps: skippedJob.steps.map((s) => (s.name === 'verify' ? { ...s, conclusion: 'failure' } : s.name === 'failed' ? { ...s, conclusion: 'failure' } : s)) };
  const forged = decideStatus(facts({ job, labels: ['pocp-approve-tests'], runs: [run(job), run(ran, { id: 101, created_at: AFTER, run_started_at: AFTER })] }));
  assert.equal(forged.state, 'failure', forged.reason);
});

test('a label run whose verify job was skipped counts as no evaluation: the waiting run decides', () => {
  const job = waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']);
  const skipped = run({ status: 'completed', conclusion: 'skipped', steps: [] }, { id: 101, conclusion: 'success', created_at: AFTER, run_started_at: AFTER });
  const d = decideStatus(facts({ job, labels: ['pocp-approve-tests'], runs: [run(job), skipped] }));
  assert.equal(d.state, 'success', d.reason);
});

// predictApproval runs inside the label event's own run: that run is left out, or it would
// always read as underway.
function fakeGh({ job, labels, events, head = SHA, workflows = {} }) {
  const runs = [
    { id: 100, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: { full_name: 'o/r' }, status: 'completed', conclusion: 'success', created_at: FIRST_RUN, run_started_at: FIRST_RUN, run_attempt: 1 },
    { id: 200, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: { full_name: 'o/r' }, status: 'in_progress', conclusion: null, created_at: AFTER, run_started_at: AFTER, run_attempt: 1 },
  ];
  const jobs = { 100: [{ name: 'verify', ...job }], 200: [{ name: 'approval', status: 'in_progress', conclusion: null, steps: [] }] };
  const get = async (url) => {
    if (url.endsWith('/pulls/7')) return { number: 7, state: 'open', head: { sha: head }, base: { sha: BASE }, labels: labels.map((name) => ({ name })), user: { login: 'author' }, changed_files: 1 };
    if (url.endsWith('/actions/workflows/pocp.yml')) return WF;
    if (/\/collaborators\/maintainer\/permission$/.test(url)) return { permission: 'write' };
    if (/\/commits\/\w+$/.test(url)) return { parents: [{ sha: 'f'.repeat(40) }] };
    if (url.endsWith('/repos/o/r')) return { default_branch: 'main' };
    if (url.includes('/contents/.github/workflows?ref=main')) return Object.keys(workflows).map((name) => ({ type: 'file', name, path: `.github/workflows/${name}` }));
    const wm = /\/contents\/\.github\/workflows\/([^?]+)\?ref=main$/.exec(url);
    if (wm) return { content: Buffer.from(workflows[decodeURIComponent(wm[1])]).toString('base64') };
    throw new Error(`unexpected GET ${url}`);
  };
  const list = async (url) => {
    const ok = (items) => ({ items, complete: true, reason: null });
    if (url.includes('/pulls?state=open')) return ok([{ number: 7, state: 'open', head: { sha: SHA } }]);
    if (url.includes('/pulls/7/files')) return ok([{ filename: 'src/a.js' }]);
    if (url.includes(`/workflows/${WF.id}/runs`)) return ok(runs);
    const m = /\/actions\/runs\/(\d+)\/jobs/.exec(url);
    if (m) return ok(jobs[m[1]] || []);
    if (url.includes('/issues/7/events')) return ok((events || []).map((e) => ({ event: 'labeled', label: { name: e.label }, actor: { login: 'maintainer' }, created_at: e.created_at })));
    throw new Error(`unexpected list ${url}`);
  };
  return { get, list };
}

test('predictApproval: skip when the waiting run would go green; its own run is left out', async () => {
  const gh = fakeGh({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), labels: ['pocp-approve-tests'], events: [given('pocp-approve-tests')] });
  const p = await predictApproval(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: 200 });
  assert.equal(p.skip, true, p.reason);
  // Without leaving its own run out, it is underway: verify runs.
  const own = await predictApproval(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: null });
  assert.equal(own.skip, false);
});

test('predictApproval: not covered when a label is missing, and on any error', async () => {
  const gh = fakeGh({ job: waitingJob(['needs-tests', 'needs-policy', 'approvable']), labels: ['pocp-approve-tests'], events: [given('pocp-approve-tests')] });
  assert.equal((await predictApproval(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: 200 })).skip, false);
  const broken = { get: async () => { throw new Error('rate limited'); }, list: async () => { throw new Error('rate limited'); } };
  const p = await predictApproval(broken, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: 200 });
  assert.equal(p.skip, false);
  assert.match(p.reason, /couldn't predict/);
});

test('predictApproval: skip when the pull request has moved past the event head (its own run decides)', async () => {
  // A label on the old head; meanwhile a push. A verify for the old head, started now, would
  // only cancel the new head's run.
  const gh = fakeGh({ job: waitingJob(['needs-tests']), labels: ['pocp-approve-tests'], events: [given('pocp-approve-tests')], head: 'd'.repeat(40) });
  const p = await predictApproval(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: 200 });
  assert.equal(p.skip, true, p.reason);
  assert.match(p.reason, /moved to dddddddddddd/);
});

test("predictApproval as the status action: skip only when the reporter's status action is at the same ref", async () => {
  const reporter = (ref) => `on:\n  workflow_run:\n    workflows: [pocp]\njobs:\n  report:\n    steps:\n      - uses: harriswekselblatt/pocp/status@${ref}\n`;
  const prediction = 'on:\n  pull_request:\njobs:\n  approval:\n    steps:\n      - uses: harriswekselblatt/pocp/status@v9\n        with:\n          predict-approval: true\n';
  const ask = (workflows) => predictApproval(fakeGh({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), labels: ['pocp-approve-tests'], events: [given('pocp-approve-tests')], workflows }), { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: 200, asAction: true, actionRef: 'v2' });
  assert.equal((await ask({ 'pocp-status.yml': reporter('v2'), 'pocp.yml': prediction })).skip, true, 'same ref; the prediction in pocp.yml is not the reporter');
  const older = await ask({ 'pocp-status.yml': reporter('v1'), 'pocp.yml': prediction });
  assert.equal(older.skip, false);
  assert.match(older.reason, /reporter's status action is at v1, not v2/);
  assert.equal((await ask({ 'pocp.yml': prediction })).skip, false, 'no reporter found');
});

test('predictApproval as the status action with no ref: verify runs (never skipped on an unknown ref)', async () => {
  const gh = fakeGh({ job: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review']), labels: ['pocp-approve-tests'], events: [given('pocp-approve-tests')] });
  const p = await predictApproval(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, runId: 200, asAction: true, actionRef: '' });
  assert.equal(p.skip, false);
  assert.match(p.reason, /ref is unknown/);
});
