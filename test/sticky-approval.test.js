// Sticky approvals, the trusted reporter's side: a pocp-approve-tests label given for head A
// turns the status green on a later head H when H's own isolated run records that verify found H
// to be exactly A plus base content, and that the same files are held as test changes as at A.
// Anything missing is undecided (the label stays on, the status waits); only a proven
// difference is stale (the reporter removes the label). Runs without records judge as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelledBeforeVerify, decideStatus, predictApproval, runMarker, TEXT, workflowFiles } from '../src/status-report.js';
import { labelFreshness } from '../src/label-freshness.js';
import { gatherSticky, heldFingerprint, readRecords, recordLines, RECORD_LINE, stickyVerdict } from '../src/sticky-approval.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = 'a'.repeat(40);
const H = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };
const LABEL = 'pocp-approve-tests';
const T = '2026-11-07T10:30:00Z';
const HELD = heldFingerprint(['test/a.test.js']);

const ran = (n) => ({ name: n, conclusion: 'success' });
const skipped = (n) => ({ name: n, conclusion: 'skipped' });
const held = (fp = HELD) => `pocp-held tests ${fp}`;
const approval = (verdict = 'same', head = A, label = LABEL) => `pocp-approval ${label} ${verdict} ${head}`;
// A waiting run's verify job on `base`, with `extra` successful steps (records, needs-*, ...).
function waitingJob(extra = [], { base = BASE, pr = 7 } = {}) {
  return {
    status: 'completed', conclusion: 'success',
    steps: [ran(runMarker(pr, base)), { name: 'verify', conclusion: 'failure' }, ...extra.map(ran), skipped('verified'), ran('waiting'), skipped('inconclusive'), skipped('failed')],
  };
}
const run = (job, over = {}) => ({
  id: 200, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: H, repository: 'o/r',
  status: 'completed', conclusion: job.conclusion, created_at: '2026-11-07T12:00:00Z', run_started_at: '2026-11-07T12:00:00Z', run_attempt: 1, html_url: 'u', job, ...over,
});
const given = (at = T, permission = 'write', label = LABEL) => ({ label, actor: 'maintainer', permission, created_at: at });
const A_RUN = '2026-11-07T10:00:00Z';
// The approved head's run: it waited for a review-only hold (the old tests still pass).
const approvedAt = (over = {}) => ({ [LABEL]: { complete: true, reason: null, head: A, head_run_at: A_RUN, confirmed: A, at: T, base: BASE, records: readRecords({ steps: [ran('approvable'), ran('verdict-needs-review'), ran(held())] }), ...over } });

// H is a merge of the base into A, made after the label: not fresh, so only stickiness can approve it.
function facts({ steps = ['needs-tests', 'approvable', 'verdict-needs-review', held(), approval()], labels = [LABEL], events = [given()], sticky = approvedAt(), runs } = {}) {
  return {
    event_sha: H, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null), base_sha: BASE, head_prs: [7], incomplete: [],
    pr: { number: 7, state: 'open', head_sha: H, labels, author: 'author' },
    files: [{ filename: 'test/a.test.js' }], changed_files: 1, label_events: events, label_events_complete: true, force_pushes: [],
    runs: runs || [run(waitingJob(steps))], sticky,
  };
}

test('Update branch after an approval: green from the waiting run, naming the head it was given for', () => {
  const d = decideStatus(facts());
  assert.equal(d.state, 'success', d.reason);
  assert.equal(d.description, TEXT.approved);
  assert.match(d.reason, /pocp-approve-tests given for aaaaaaaaaaaa, and this head is that head plus base content only/);
  assert.deepEqual(labelFreshness(facts(), LABEL, H), { ok: true, how: 'sticky', from: A });
});

test("the pull request's own changes differ (a commit, an evil merge, a conflict, a force-push): stale, with what changed", () => {
  for (const [verdict, words] of [['content', /changed since then/], ['conflict', /resolved by hand/], ['gone', /force-pushed away/], ['ci', /changed CI files/], ['policy', /policy changed since the approval/]]) {
    const f = facts({ steps: ['needs-tests', 'approvable', 'verdict-needs-review', held(), approval(verdict)] });
    const d = decideStatus(f);
    assert.equal(d.state, 'pending', verdict);
    const v = labelFreshness(f, LABEL, H);
    assert.equal(v.stale, true, verdict);
    assert.match(v.why, words, verdict);
  }
});

test('only a review-only hold carries over: a behaviour change, on either head, is approved again with a run', () => {
  for (const v of ['behavior-changed', 'detection-dropped', 'baseline-red']) {
    // This head's run found it.
    const now = facts({ steps: ['needs-tests', 'approvable', `verdict-${v}`, held(), approval()] });
    assert.equal(decideStatus(now).state, 'pending', v);
    const why = labelFreshness(now, LABEL, H);
    assert.equal(why.stale, true, v);
    assert.match(why.why, new RegExp(`only for a review-only hold .*found ${v}`));
    // The approved head's run found it.
    const then = facts({ sticky: approvedAt({ records: readRecords({ steps: [ran('approvable'), ran(`verdict-${v}`), ran(held())] }) }) });
    assert.equal(decideStatus(then).state, 'pending', v);
    assert.equal(labelFreshness(then, LABEL, H).stale, true, v);
  }
  // No verdict this reporter can read (an older workflow, or two verdict steps): judged as before.
  const unknown = facts({ steps: ['needs-tests', 'approvable', held(), approval()] });
  assert.equal(decideStatus(unknown).state, 'pending');
  assert.match(labelFreshness(unknown, LABEL, H).why, /added before this commit/);
  const two = facts({ steps: ['needs-tests', 'approvable', 'verdict-needs-review', 'verdict-behavior-changed', held(), approval()] });
  assert.equal(decideStatus(two).state, 'pending');
});

test('the fast path itself (a fresh label, no new run) is only for a review-only hold', () => {
  const fresh = (steps) => facts({ steps, events: [given('2026-11-07T12:30:00Z')], sticky: approvedAt({ head: H }) });
  assert.equal(decideStatus(fresh(['needs-tests', 'approvable', 'verdict-needs-review'])).state, 'success');
  const d = decideStatus(fresh(['needs-tests', 'approvable', 'verdict-behavior-changed']));
  assert.equal(d.state, 'pending');
  assert.equal(decideStatus(fresh(['needs-tests', 'approvable'])).state, 'pending');
});

test('a base update that changes which files count as held voids it', () => {
  const f = facts({ steps: ['needs-tests', 'approvable', 'verdict-needs-review', held(heldFingerprint(['test/a.test.js', 'test/helper.js'])), approval()] });
  assert.equal(decideStatus(f).state, 'pending');
  assert.match(labelFreshness(f, LABEL, H).why, /other files count as test changes now/);
  assert.equal(labelFreshness(f, LABEL, H).stale, true);
});

test('labels by non-writers never stick, and a non-writer re-applying a writer\'s label takes it over', () => {
  for (const events of [[given(T, 'triage')], [given(T), given('2026-11-07T11:00:00Z', 'read')]]) {
    const f = facts({ events });
    assert.equal(decideStatus(f).state, 'pending');
    assert.equal(labelFreshness(f, LABEL, H).ok, false);
  }
  // A permission GitHub didn't return is undecided, not stale.
  assert.equal(labelFreshness(facts({ events: [given(T, null)] }), LABEL, H).stale, false);
});

test('removing the label revokes the approval; re-adding it binds it to the head current then', () => {
  assert.equal(decideStatus(facts({ labels: [] })).state, 'pending');
  assert.equal(labelFreshness(facts({ labels: [] }), LABEL, H).ok, false);
  // Re-added after H's first run: fresh for H, the ordinary rule.
  const fresh = facts({ events: [given(T), given('2026-11-07T12:30:00Z')], sticky: approvedAt({ head: H }) });
  assert.equal(labelFreshness(fresh, LABEL, H).how, 'fresh');
});

test('records from a run that names another pull request or base, or that did not succeed, do not count', () => {
  // Verify compared with another head than the one the label was given for: judged as before
  // (the label doesn't count, and is removed so adding it again approves this head).
  const other = facts({ steps: ['needs-tests', 'approvable', 'verdict-needs-review', held(), approval('same', 'd'.repeat(40))] });
  assert.equal(decideStatus(other).state, 'pending');
  assert.match(labelFreshness(other, LABEL, H).why, /added before this commit/);
  assert.equal(labelFreshness(other, LABEL, H).stale, true);
  // A record step that failed, or two that disagree, is missing.
  const job = waitingJob(['needs-tests', 'approvable', 'verdict-needs-review', held()]);
  job.steps.push({ name: approval(), conclusion: 'failure' });
  assert.equal(decideStatus(facts({ runs: [run(job)] })).state, 'pending');
  const clash = readRecords({ steps: [ran(approval()), ran(approval('content'))] });
  assert.equal(clash.approvals[LABEL], undefined);
  // A malformed record is no record.
  assert.equal(readRecords({ steps: [ran(`${approval()} extra`), ran('pocp-held tests 123')] }).any, false);
});

test("while the head's run is underway, or its records are missing, the label is undecided: the reporter doesn't remove it", () => {
  const underway = facts({ runs: [run(waitingJob([]), { status: 'in_progress', conclusion: null })] });
  assert.equal(labelFreshness(underway, LABEL, H).stale, false);
  assert.equal(labelFreshness(facts({ sticky: null }), LABEL, H).stale, false);
  assert.equal(labelFreshness(facts({ sticky: approvedAt({ complete: false, reason: 'cut short' }) }), LABEL, H).stale, false);
});

test("a finished run that couldn't settle it is judged as before: the label is removed, never left on under a status asking for it", () => {
  // The approved head's run left no record found, or verify made no comparison (an old git, two
  // merge bases): the old rule, so re-adding the label approves this head.
  for (const f of [facts({ sticky: approvedAt({ records: null }) }), facts({ steps: ['needs-tests', 'approvable', 'verdict-needs-review', held()] })]) {
    const v = labelFreshness(f, LABEL, H);
    assert.equal(v.stale, true, v.why);
    assert.match(v.why, /added before this commit/);
    const d = decideStatus(f);
    assert.equal(d.state, 'pending');
    assert.match(d.description, /^Waiting for approval/);
  }
});

test('a head pushed seconds before the label, before its run existed, never lets the label bind to the older head', () => {
  // H1 (a bad test edit) ran; H2 replaced it but had no run yet when the maintainer, looking at
  // H2, added the label; then the head went back to H1's content. The newest run before the label
  // is H1's, but the label's own run is on H2: the label holds for neither.
  const H2 = 'd'.repeat(40);
  const f = facts({ sticky: approvedAt({ confirmed: H2 }) });
  assert.equal(decideStatus(f).state, 'pending');
  const v = labelFreshness(f, LABEL, H);
  assert.equal(v.stale, true);
  assert.match(v.why, /added while the head was moving/);
  // A force-push between the approved head's run and the label: the same.
  const fp = { ...facts(), force_pushes: ['2026-11-07T10:10:00Z'] };
  assert.equal(decideStatus(fp).state, 'pending');
  assert.match(labelFreshness(fp, LABEL, H).why, /force-pushed just before/);
  // A force-push long before the approved head's run doesn't matter.
  assert.equal(decideStatus({ ...facts(), force_pushes: ['2026-11-07T09:00:00Z'] }).state, 'success');
  // No run after the label at all (its event's run never started): judged as before.
  assert.match(labelFreshness(facts({ sticky: approvedAt({ confirmed: null }) }), LABEL, H).why, /added before this commit/);
});

test('a run from a workflow without records is judged exactly as before (the label is stale)', () => {
  const f = facts({ steps: ['needs-tests', 'approvable', 'verdict-needs-review'] });
  assert.equal(decideStatus(f).state, 'pending');
  assert.deepEqual(labelFreshness(f, LABEL, H), { ok: false, stale: true, why: 'pocp-approve-tests was added before this commit: review the new commits and re-apply it' });
});

test("an approval given before sticky approvals existed (the approved head's run has no records) needs one more re-label", () => {
  const f = facts({ sticky: approvedAt({ records: readRecords({ steps: [] }) }) });
  assert.equal(decideStatus(f).state, 'pending');
  assert.match(labelFreshness(f, LABEL, H).why, /predates sticky approvals/);
});

test('a head that changes CI files still needs pocp-approve-workflow: its records come from its own workflow', () => {
  const f = { ...facts(), files: [{ filename: '.github/workflows/pocp.yml' }, { filename: 'test/a.test.js' }], changed_files: 2 };
  const d = decideStatus(f);
  assert.equal(d.state, 'pending');
  assert.match(d.reason, /CI files changed/);
});

test('pocp-approve-policy sticks the same way, without a held-set record (its holds are the policy files the merge rule compares)', () => {
  const label = 'pocp-approve-policy';
  const f = {
    ...facts({ steps: [approval('same', A, label)], labels: [label], events: [given(T, 'write', label)], sticky: { [label]: { complete: true, head: A, head_run_at: A_RUN, confirmed: A, at: T, base: BASE, records: readRecords({ steps: [] }) } } }),
  };
  assert.equal(labelFreshness(f, label, H).how, 'sticky');
  // pocp-approve-inconclusive and -coverage never stick.
  assert.deepEqual(stickyVerdict(f, 'pocp-approve-inconclusive', H), { applies: false });
  assert.deepEqual(stickyVerdict(f, 'pocp-approve-coverage', H), { applies: false });
});

test('verify decides for itself before its run: its own comparison stands in for the records', () => {
  const f = facts({ runs: [] });
  f.records_now = { any: true, held: {}, approvals: { 'pocp-approve-policy': { verdict: 'same', head: A } } };
  f.pr.labels.push('pocp-approve-policy');
  f.label_events.push(given(T, 'write', 'pocp-approve-policy'));
  f.sticky['pocp-approve-policy'] = { complete: true, head: A, head_run_at: A_RUN, confirmed: A, at: T, base: BASE, records: null };
  assert.equal(labelFreshness(f, 'pocp-approve-policy', H).how, 'sticky');
  // The test label waits for the reporter: verify can't know what it holds before its checks.
  const t = labelFreshness(f, LABEL, H);
  assert.equal(t.ok, false);
  assert.equal(t.stale, false);
});

test("record steps are the workflow's own: a run cancelled before verify still says nothing", () => {
  const job = { status: 'completed', conclusion: 'cancelled', steps: [skipped(runMarker(7, BASE)), skipped('verify'), skipped(held()), skipped(approval())] };
  assert.equal(cancelledBeforeVerify({ status: 'completed', conclusion: 'cancelled', job }), true);
  const recorded = { ...job, steps: [...job.steps.slice(0, 2), { name: held(), conclusion: 'success' }] };
  assert.equal(cancelledBeforeVerify({ status: 'completed', conclusion: 'cancelled', job: recorded }), false);
});

test('recordLines writes only well-formed lines, and the workflow checks the same patterns', () => {
  const lines = recordLines({ heldTests: ['test/a.test.js'], approvals: { [LABEL]: { verdict: 'same', head: A }, 'pocp-approve-inconclusive': { verdict: 'same', head: A }, 'pocp-approve-policy': { verdict: 'same', head: 'nope' } } });
  assert.deepEqual(lines, [`held tests ${HELD}`, `approval ${LABEL} same ${A}`]);
  for (const l of lines) assert.match(l, RECORD_LINE);
  assert.equal(heldFingerprint(['b', 'a', 'a']), heldFingerprint(['a', 'b']));
  assert.notEqual(heldFingerprint([]), heldFingerprint(['a']));
  for (const rel of ['.github/workflows/pocp.yml', 'action.yml']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(text.includes("grep -Eqx 'held tests [0-9a-f]{64}'"), rel);
    assert.ok(text.includes("grep -Eqx 'approval pocp-approve-(tests|policy) (same|content|conflict|ci|policy|gone) [0-9a-f]{40}'"), rel);
    assert.match(text, /--record-file=/, rel);
  }
  for (const rel of ['.github/workflows/pocp.yml', 'examples/github/pocp.yml']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const name of ['pocp-held tests ', 'pocp-approval pocp-approve-tests ', 'pocp-approval pocp-approve-policy ']) assert.ok(text.includes(`- name: ${name}\${{`), `${rel}: ${name}`);
  }
});

// gatherSticky against a fake GitHub: the branch's runs and their jobs.
function fakeGh(runs, jobs = {}, { cut = false } = {}) {
  const calls = [];
  return {
    calls,
    async list(url) {
      calls.push(url);
      if (url.includes('/runs?')) return { items: runs, complete: !cut, reason: cut ? 'cut short' : null };
      const id = Number(/runs\/(\d+)\/jobs/.exec(url)[1]);
      return { items: jobs[id] ? [{ name: 'verify', steps: jobs[id] }] : [], complete: true, reason: null };
    },
  };
}
const ghRun = (id, sha, at, over = {}) => ({ id, head_sha: sha, created_at: at, path: WF.path, event: 'pull_request', status: 'completed', head_branch: 'topic', head_repository: { full_name: 'o/r' }, ...over });

test('the approved head is the head of the newest run before the label, on this branch, from this repository', async () => {
  const runs = [
    ghRun(1, 'e'.repeat(40), '2026-11-07T09:00:00Z'),
    ghRun(2, A, '2026-11-07T10:00:00Z'),
    ghRun(3, 'f'.repeat(40), '2026-11-07T10:15:00Z', { head_repository: { full_name: 'fork/r' } }), // a fork's branch of the same name
    ghRun(5, A, '2026-11-07T10:30:04Z'), // the label's own run
    ghRun(4, H, '2026-11-07T11:00:00Z'), // after the label
  ];
  const jobs = { 2: [ran(runMarker(7, BASE)), { name: 'verify', conclusion: 'failure' }, ran(held())] };
  const out = await gatherSticky(fakeGh(runs, jobs), '/repos/o/r', { number: 7, headRef: 'topic', headRepo: 'o/r', workflow: WF, labels: [LABEL, 'pocp-approve-coverage'], labelEvents: [given()] });
  assert.deepEqual(Object.keys(out), [LABEL]);
  assert.equal(out[LABEL].head, A);
  assert.equal(out[LABEL].confirmed, A);
  assert.equal(out[LABEL].head_run_at, '2026-11-07T10:00:00Z');
  assert.equal(out[LABEL].base, BASE);
  assert.equal(out[LABEL].records.held.tests, HELD);
  // A run of A for another pull request (a shared branch) is not A's record.
  const other = await gatherSticky(fakeGh(runs, { 2: [ran(runMarker(8, BASE)), { name: 'verify', conclusion: 'failure' }, ran(held())] }), '/repos/o/r', { number: 7, headRef: 'topic', headRepo: 'o/r', workflow: WF, labels: [LABEL], labelEvents: [given()] });
  assert.equal(other[LABEL].records, null);
  // Another branch's run, even if the API ignored the branch filter, is not A; nor is anything
  // when GitHub didn't say the head branch.
  const ignored = await gatherSticky(fakeGh([ghRun(9, 'd'.repeat(40), '2026-11-07T10:20:00Z', { head_branch: 'other' }), ...runs], jobs), '/repos/o/r', { number: 7, headRef: 'topic', headRepo: 'o/r', workflow: WF, labels: [LABEL], labelEvents: [given()] });
  assert.equal(ignored[LABEL].head, A);
  const noRef = await gatherSticky(fakeGh(runs, jobs), '/repos/o/r', { number: 7, headRef: null, headRepo: 'o/r', workflow: WF, labels: [LABEL], labelEvents: [given()] });
  assert.equal(noRef[LABEL].complete, false);
  // A list cut short: incomplete, never a guess.
  const cut = await gatherSticky(fakeGh(runs, jobs, { cut: true }), '/repos/o/r', { number: 7, headRef: 'topic', headRepo: 'o/r', workflow: WF, labels: [LABEL], labelEvents: [given()] });
  assert.equal(cut[LABEL].complete, false);
});

test('predictApproval sees the same facts: an approval that sticks skips the re-run', async () => {
  const pr = { number: 7, state: 'open', head: { sha: H, ref: 'topic', label: 'o:topic', repo: { full_name: 'o/r' } }, base: { sha: BASE, ref: 'main' }, labels: [{ name: LABEL }], user: { login: 'author' }, changed_files: 1 };
  const runA = ghRun(2, A, '2026-11-07T10:00:00Z');
  const runH = { ...ghRun(5, H, '2026-11-07T12:00:00Z'), workflow_id: WF.id, repository: { full_name: 'o/r' }, conclusion: 'success', run_started_at: '2026-11-07T12:00:00Z', run_attempt: 1, pull_requests: [{ number: 7, head: { ref: 'topic', sha: H }, base: { ref: 'main', sha: BASE } }] };
  const jobs = {
    2: [ran(runMarker(7, BASE)), { name: 'verify', conclusion: 'failure' }, ran('approvable'), ran('verdict-needs-review'), ran(held())],
    5: waitingJob(['needs-tests', 'approvable', 'verdict-needs-review', held(), approval()]).steps,
  };
  const gh = {
    async get(url) {
      if (url.endsWith('/pulls/7')) return pr;
      if (url.includes('/actions/workflows/pocp.yml')) return { id: WF.id, path: WF.path };
      if (url.includes('/collaborators/')) return { permission: 'write' };
      throw new Error(`unexpected ${url}`);
    },
    async list(url) {
      if (url.includes('/pulls?state=open')) return { items: [pr], complete: true };
      // Every pull request from the head branch (status-report.js headPulls): this one only.
      if (url.includes('/pulls?state=all&head=o%3Atopic')) return { items: [pr], complete: true };
      if (url.includes('/pulls/7/files')) return { items: [{ filename: 'test/a.test.js' }], complete: true };
      if (url.includes('runs?head_sha=')) return { items: [runH], complete: true };
      if (url.includes('runs?event=pull_request&branch=topic')) return { items: [runA, ghRun(3, A, '2026-11-07T10:30:04Z'), runH], complete: true };
      if (url.includes('/issues/7/events')) return { items: [{ event: 'labeled', label: { name: LABEL }, actor: { login: 'maintainer' }, created_at: T }], complete: true };
      if (url.includes('/commits/')) return { items: [], complete: true };
      const id = Number(/runs\/(\d+)\/jobs/.exec(url)?.[1]);
      if (jobs[id]) return { items: [{ name: 'verify', status: 'completed', conclusion: 'success', steps: jobs[id] }], complete: true };
      throw new Error(`unexpected ${url}`);
    },
  };
  gh.get = ((get) => async (url) => (url.includes('/commits/') ? { parents: [{ sha: A }] } : get(url)))(gh.get);
  const p = await predictApproval(gh, { repository: 'o/r', sha: H, prNumber: 7, runId: 99 });
  assert.equal(p.skip, true, p.reason);
});

test("the records step reads only verify's file, only after isolated checks, and prints nothing of the pull request's", () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/pocp.yml'), 'utf8');
  const step = wf.slice(wf.indexOf('      - id: records'), wf.indexOf('      - name: pocp-held tests'));
  assert.match(step, /if: steps\.predict\.outputs\.skip != 'true' && \(steps\.plan\.outputs\.isolate == 'true'\)/);
  assert.doesNotMatch(step, /steps\.verify|cat |echo "\$line"/);
  assert.match(step, /RECORD_FILE: \$\{\{ runner\.temp \}\}\/pocp-records/);
  const action = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  const rec = action.slice(action.indexOf('    - name: Record file'));
  assert.match(rec, /if: always\(\) && inputs\.isolate == 'true'/);
  assert.doesNotMatch(rec, /steps\.verify|cat |echo "\$line"/);
});
