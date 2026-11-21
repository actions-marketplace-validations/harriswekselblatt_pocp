// Whether an approval label counts for a pull request's head: one rule, used by the trusted
// reporter (src/status-report.js) and by `verify --label-freshness=github`.
//
// A label is a maintainer's approval of the code they reviewed, not of whatever is pushed after
// it. Up to 1.3.0, pocp-labels.yml removed approval labels on every push; it ran on
// pull_request_target, which GitHub blocks by default in public repositories from 2026-12-02.
// Instead a label counts only if its last application is by a writer, after the head's first run
// of the workflow and after the pull request's latest force-push, or if it carries over to a
// clean merge of the base into the approved head ("Update branch"). Every fact comes from
// GitHub's API, never from the pull request.

import { gatherSticky, STICKY, stickyVerdict } from './sticky-approval.js';

export const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
// The first step of a verify run names the pull request and base it evaluated (runMarker).
export const MARKER_PREFIX = 'pocp-run ';
// Approvals of content (not of one run's outcome, and not of a workflow, which can run any file)
// that may carry over to a clean merge of the base branch into the approved head.
export const CARRYABLE = Object.freeze(['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-coverage']);
// GitHub's compare API lists at most this many files: a list that reaches it may be missing some.
export const COMPARE_FILES_CAP = 300;
const POLICY_PREFIX = '.proof/';
// Proof records: nearly every merged pull request adds one, and none is policy. Packets the
// pull request itself changes are still covered by the checks on its own files below.
const PROOF_RECORDS = '.proof/packets/';
const isPolicy = (f) => f.startsWith(POLICY_PREFIX) && !f.startsWith(PROOF_RECORDS);
const short = (sha) => (sha ? String(sha).slice(0, 12) : '(none)');

const lastApplied = (facts, label) => (facts.label_events || []).filter((e) => e.label === label).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
const firstRunOf = (facts, sha) => (facts.runs || []).filter((r) => r.head_sha === sha).map((r) => String(r.created_at)).sort()[0] || null;

/**
 * Whether a force-push came after the label's last application. Then the label was given for a
 * head the pull request no longer has, even when the head now is one that ran before it: H1 runs,
 * H2 is force-pushed and labelled, H1 is force-pushed back. A normal push can't go back to an
 * older head, so the force-pushes are the only way. From the pull request's issue events
 * (head_ref_force_pushed).
 */
export function labelOutlived(facts, last) {
  return (facts.force_pushes || []).some((t) => String(t) > String(last.created_at));
}

/**
 * Whether the label's current application is a writer's, given for this head: its most recent
 * "labeled" event is by someone with write access, after the head's first run of the workflow,
 * and no force-push came after it.
 * Needs the whole event list (facts.label_events_complete): a list cut short could hide a later
 * application by someone else.
 */
export function approvedByWriter(facts, label, sha) {
  if (!facts.label_events_complete) return false;
  const firstRunAt = firstRunOf(facts, sha);
  const last = lastApplied(facts, label);
  return Boolean(last && WRITE_PERMISSIONS.has(last.permission) && firstRunAt && String(last.created_at) > firstRunAt && !labelOutlived(facts, last));
}

/**
 * Whether an approval given for the previous head still applies to this one. Only in one narrow
 * case: the new head is a merge of the approved head with the current base, and that merge
 * changed nothing the pull request changes, and no policy file. Then what the person approved
 * (the pull request's own changes) is byte-for-byte what is there now. The approval is kept, not
 * any result: the new head is verified again on the new base. Never for an inconclusive or
 * workflow approval. facts.carry comes from gatherCarry(), from GitHub's API only.
 */
export function carriedOver(facts, label) {
  const c = facts.carry;
  const no = (why) => ({ ok: false, why });
  if (!CARRYABLE.includes(label)) return no(`${label} never carries over`);
  // A test approval may be for a behaviour change (the old tests failed on the new code), which a
  // person accepts for the run that showed it. It moves to a new head only as a review-only hold,
  // through that head's own records (stickyVerdict), never through this path.
  if (label === 'pocp-approve-tests') return no('a test approval carries to a new head only when the hold is review-only (sticky approvals)');
  if (!c) return no('the head is not a merge of the base into an approved head');
  if (!c.complete) return no(`GitHub's data for the merge was incomplete${c.reason ? ` (${c.reason})` : ''}`);
  if (!c.from_sha || !c.merged_sha || c.merged_sha !== facts.base_sha) return no('the head is not a merge of the current base into the previous head');
  if (!facts.label_events_complete) return no('the label events were incomplete');
  // The approval was given by a writer while the previous head was the pull request's head:
  // after that head's first run for this pull request.
  const mine = (r) => r.head_sha === c.from_sha && (r.job?.steps || []).some((st) => String(st.name || '').startsWith(`${MARKER_PREFIX}pr-${facts.pr.number} base-`) && st.conclusion === 'success');
  const firstRunAt = (c.runs || []).filter(mine).map((r) => String(r.created_at)).sort()[0] || null;
  const last = lastApplied(facts, label);
  if (!last || !WRITE_PERMISSIONS.has(last.permission)) return no(`${label} was last applied by someone without write access`);
  if (!firstRunAt || String(last.created_at) <= firstRunAt) return no(`${label} was not given for ${short(c.from_sha)}`);
  if (labelOutlived(facts, last)) return no(`${label} was applied before a force-push, so it was given for another head`);
  const merged = new Set(c.merge_files || []);
  const touched = (c.pr_files || []).filter((f) => merged.has(f));
  if (touched.length) return no(`the merge changed files the pull request changes: ${touched.slice(0, 3).join(', ')}`);
  // Every file the pull request now changes must be one the approved head already changed. A
  // merge that keeps an old version of a file the base changed (undoing a fix, a new test, a
  // tighter rule) leaves it out of the merge's own list, but adds it to the pull request's.
  const approved = new Set(c.approved_files || []);
  const added = (c.pr_files || []).filter((f) => !approved.has(f));
  if (added.length) return no(`the merge adds changes the approval didn't cover: ${added.slice(0, 3).join(', ')}`);
  const policy = [...merged].filter(isPolicy);
  if (policy.length) return no(`the merge changed policy files: ${policy.slice(0, 3).join(', ')}`);
  // What the base branch changed since the approved head branched off. A merge can keep the
  // pull request's own version of a file, so the merge's file list never shows that the base
  // changed it: the base must not have changed the policy (the authority the approval was judged
  // by) or any file the approval covers (the side the person compared against).
  if (!Array.isArray(c.base_files)) return no("GitHub's data for the base branch's changes was missing");
  const basePolicy = c.base_files.filter(isPolicy);
  if (basePolicy.length) return no(`the base branch changed policy files since the approval: ${basePolicy.slice(0, 3).join(', ')}`);
  const baseTouched = c.base_files.filter((f) => approved.has(f));
  if (baseTouched.length) return no(`the base branch changed files the approval covers: ${baseTouched.slice(0, 3).join(', ')}`);
  return { ok: true };
}

/**
 * The rule, with its reason: { ok: true, how: 'fresh' | 'carried' }, or { ok: false, stale, why }.
 * stale is true only when GitHub's data shows the label doesn't count for this head (given
 * before it, before a force-push, or by someone without write access): only then may it be
 * removed. Missing or incomplete data refuses the label without calling it stale.
 */
export function labelFreshness(facts, label, sha) {
  const refuse = (stale, why) => ({ ok: false, stale, why });
  if (facts.pr && !(facts.pr.labels || []).includes(label)) return refuse(false, `${label} is not on the pull request`);
  if (approvedByWriter(facts, label, sha)) return { ok: true, how: 'fresh' };
  if (carriedOver(facts, label).ok) return { ok: true, how: 'carried' };
  // Bound to what was approved, not to a head (sticky-approval.js). A head whose evaluation has
  // no records (an older workflow) is judged by the rules below, as before.
  const sticky = stickyVerdict(facts, label, sha);
  if (sticky.ok) return { ok: true, how: 'sticky', from: sticky.from };
  if (sticky.applies) return refuse(sticky.stale, sticky.why);
  if (!facts.label_events_complete) return refuse(false, "GitHub's list of the pull request's events was incomplete");
  const last = lastApplied(facts, label);
  if (!last) return refuse(false, `GitHub doesn't say who applied ${label}`);
  if (labelOutlived(facts, last)) return refuse(true, `${label} was applied before a force-push, so it was given for another head: review the commits and re-apply it`);
  if (!last.permission) return refuse(false, `couldn't read ${last.actor || 'the labeller'}'s permission on the repository`);
  if (!WRITE_PERMISSIONS.has(last.permission)) return refuse(true, `${label} was last applied by ${last.actor || 'someone'}, without write access`);
  if (!firstRunOf(facts, sha)) return refuse(false, `no run of the workflow on ${short(sha)} yet`);
  if (CARRYABLE.includes(label) && facts.carry && !facts.carry.complete) return refuse(false, carriedOver(facts, label).why);
  return refuse(true, `${label} was added before this commit: review the new commits and re-apply it`);
}

/**
 * A whole list from `gh`: { items, complete, reason }. githubClient's list() says whether it got
 * every page; a client with only all() (a test double) is taken at its word.
 */
export async function listAll(gh, url, key, max) {
  if (gh.list) return gh.list(url, key, max);
  return { items: await gh.all(url, key, max), complete: true, reason: null };
}

/**
 * Who applied each approval label, with their permission, and when the head was force-pushed:
 * { label_events, label_events_complete, force_pushes }.
 */
export async function gatherLabelEvents(gh, repo, number, approvalLabels) {
  const listed = await listAll(gh, `${repo}/issues/${number}/events?per_page=100`);
  const out = { label_events: [], label_events_complete: listed.complete, force_pushes: [] };
  const permissions = new Map();
  for (const e of listed.items.filter((x) => x.event === 'labeled' && approvalLabels.has(x.label?.name))) {
    const login = e.actor?.login;
    if (login && !permissions.has(login)) {
      let permission = null;
      try {
        permission = (await gh.get(`${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission;
      } catch { /* unknown permission never approves */ }
      permissions.set(login, permission);
    }
    out.label_events.push({ label: e.label.name, actor: login, permission: permissions.get(login) ?? null, created_at: e.created_at });
  }
  // A force-push can bring back a head that was replaced: a label applied before it was given
  // for another head (labelOutlived).
  out.force_pushes = listed.items.filter((x) => x.event === 'head_ref_force_pushed').map((x) => String(x.created_at));
  return out;
}

/**
 * What carriedOver() needs, when the head is a merge commit: its parents, the files the merge
 * changed (first parent to head), the files the pull request changes against the merged-in
 * parent, the files the approved head changed, and the previous head's runs. Every list must be
 * whole, or nothing carries.
 */
export async function gatherCarry(gh, repo, head, workflow, verifyJob = 'verify') {
  const commit = await gh.get(`${repo}/commits/${head}`);
  const parents = (commit.parents || []).map((p) => p.sha);
  if (parents.length !== 2) return null;
  const [from, merged] = parents;
  const carry = { from_sha: from, merged_sha: merged, complete: true, reason: null, merge_files: [], pr_files: [], approved_files: [], base_files: [], runs: [] };
  const filesOf = async (a, b) => {
    const cmp = await gh.get(`${repo}/compare/${a}...${b}`);
    const files = (cmp.files || []).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
    if ((cmp.files || []).length >= COMPARE_FILES_CAP) { carry.complete = false; carry.reason = 'a file list was cut short'; }
    return files;
  };
  carry.merge_files = await filesOf(from, head);
  carry.pr_files = await filesOf(merged, head);
  // What the approved head changed against its merge base with the base branch (three dots).
  carry.approved_files = await filesOf(merged, from);
  // What the base changed since the approved head branched off (three dots: from their merge base).
  carry.base_files = await filesOf(from, merged);
  const runs = await listAll(gh, `${repo}/actions/workflows/${workflow.id}/runs?head_sha=${from}&per_page=100`, 'workflow_runs', 5);
  if (!runs.complete) { carry.complete = false; carry.reason = runs.reason || 'a list was cut short'; }
  for (const r of runs.items.filter((x) => x.event === 'pull_request' && x.path === workflow.path)) {
    const jobs = await listAll(gh, `${repo}/actions/runs/${r.id}/jobs?per_page=100`, 'jobs', 3);
    const job = jobs.complete ? jobs.items.find((j) => j.name === verifyJob) : null;
    carry.runs.push({ head_sha: r.head_sha, created_at: r.created_at, job: job ? { steps: (job.steps || []).map((st) => ({ name: st.name, conclusion: st.conclusion })) } : null });
  }
  return carry;
}

/**
 * Everything labelFreshness() needs for `labels` on pull request `prNumber` at head `sha`, for
 * verify. Throws when GitHub can't say: the caller refuses every approval it couldn't check.
 */
export async function freshnessFacts(gh, { repository, prNumber, sha, labels, workflowPath = '.github/workflows/pocp.yml' }) {
  const repo = `/repos/${repository}`;
  const pr = await gh.get(`${repo}/pulls/${prNumber}`);
  const facts = { pr: { number: pr.number, head_sha: pr.head?.sha, labels: (pr.labels || []).map((l) => l.name), author: pr.user?.login || null }, base_sha: pr.base?.sha || null, runs: [] };
  const head = { headRef: pr.head?.ref || null, headRepo: pr.head?.repo?.full_name ?? null };
  const wf = await gh.get(`${repo}/actions/workflows/${encodeURIComponent(workflowPath.split('/').pop())}`);
  if (wf.path !== workflowPath) throw new Error(`the workflow ${workflowPath} was not found (GitHub has ${wf.path})`);
  const runs = await listAll(gh, `${repo}/actions/workflows/${wf.id}/runs?head_sha=${sha}&per_page=100`, 'workflow_runs', 5);
  if (!runs.complete) throw new Error(runs.reason || "the head's runs were cut short");
  facts.runs = runs.items.map((r) => ({ head_sha: r.head_sha, created_at: r.created_at }));
  const events = await gatherLabelEvents(gh, repo, pr.number, new Set(labels));
  if (!events.label_events_complete) throw new Error("the pull request's events were cut short");
  Object.assign(facts, events);
  // Only a label that isn't fresh needs the merge's facts ("Update branch").
  if (labels.some((l) => CARRYABLE.includes(l) && !approvedByWriter(facts, l, sha))) facts.carry = await gatherCarry(gh, repo, sha, { id: wf.id, path: wf.path });
  // And the head each sticky label was given for (sticky-approval.js).
  const sticky = labels.filter((l) => STICKY[l] && !approvedByWriter(facts, l, sha));
  if (sticky.length) facts.sticky = await gatherSticky(gh, repo, { number: pr.number, ...head, workflow: { id: wf.id, path: wf.path }, labels: sticky, labelEvents: facts.label_events });
  return facts;
}
