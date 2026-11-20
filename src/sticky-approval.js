// Sticky approvals: a maintainer's pocp-approve-tests or pocp-approve-policy label is bound to
// what they approved (the pull request's own changes at the head they approved), not to that
// head's sha. Bringing the base branch in ("Update branch", which "require branches to be up to
// date" forces after every merge) keeps the approval; any change of the pull request's own voids it.
//
// The rule, for a label last applied by a writer at time T, on a later head H:
// - A, the approved head: the pull request's head when the label was applied (the head of its
//   newest run of pocp.yml created before T, from GitHub's API).
// - H is exactly A plus base content: H's tree is A's, or the clean merge (git merge-tree,
//   attributes off) of A with H's merge base with the base branch. A conflict, or any other
//   difference, voids it: a merge commit can't slip in edits of its own.
// - A changed no CI file (so its run's record came from the base's workflow), and the base's
//   policy files are the same now as at A's run: the rules that judged the approval judge H.
// - pocp-approve-tests only: the set of files held as test changes is the same at H as at A, as
//   each head's own isolated run recorded it. A base update that makes another file count as a
//   test (a new glob, a helper import, a newer verifier) voids it.
//
// verify (the base's code, before any of the pull request's code runs) decides the content rule
// with git and records its verdict; the trusted reporter checks the rest from GitHub's API and the
// runs' records. Records travel as step names of pocp.yml's verify job, written from a file in the
// runner's temp folder that isolated checks can't reach (like the `approvable` step), and count
// only from a head that changes no CI file. Anything missing or unreadable refuses the label
// without calling it stale; only a proven difference is stale (and the reporter removes the label).

import crypto from 'node:crypto';
import { git } from './git.js';
import { HOLD_VERDICTS } from './hold.js';
import { ciProtects, DEFAULT_CI_FILES } from './store.js';

/** The labels that can stick, and the hold each approves. */
export const STICKY = Object.freeze({ 'pocp-approve-tests': 'tests', 'pocp-approve-policy': 'policy' });
const VERDICTS = 'same|content|conflict|ci|policy|gone';
// Step names (pocp.yml) and record-file lines (verify --record-file). The workflow step that
// reads the file checks each line against RECORD_LINE's shell twin; the reporter checks again.
export const HELD_STEP = /^pocp-held tests ([0-9a-f]{64})$/;
export const APPROVAL_STEP = new RegExp(`^pocp-approval (pocp-approve-tests|pocp-approve-policy) (${VERDICTS}) ([0-9a-f]{40})$`);
export const RECORD_PREFIXES = Object.freeze(['pocp-held ', 'pocp-approval ']);
export const RECORD_LINE = new RegExp(`^(held tests [0-9a-f]{64}|approval (pocp-approve-tests|pocp-approve-policy) (${VERDICTS}) [0-9a-f]{40})$`);
const MARKER_PREFIX = 'pocp-run ';
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
// Policy: .proof/ except proof records, which nearly every pull request adds (label-freshness.js).
export const isPolicyPath = (f) => f.startsWith('.proof/') && !f.startsWith('.proof/packets/');
const short = (sha) => (sha ? String(sha).slice(0, 12) : '(none)');
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// The only test-guard verdict an approval may ride without a new run, or carry to a later head:
// the old tests still pass on the new code, and a person only has to read the edit. A hold whose
// old tests fail on the new code (behavior-changed), whose edited tests catch less
// (detection-dropped), or whose old tests already failed (baseline-red) is a decision about
// behaviour: it is made again, with a run, on each head.
export const REVIEW_ONLY = 'needs-review';

// What each verdict other than `same` means: the status reason, verify's log, the docs.
export const DIFFERS = Object.freeze({
  content: 'the pull request changed since then: the head is not the approved head plus base content',
  conflict: 'the approved head conflicts with the base, so the merge was resolved by hand and is not the approved content',
  ci: "the approved head changed CI files, so its run's record can't be trusted",
  policy: "the base branch's policy changed since the approval, so it was judged by other rules",
  gone: "the approved head is no longer in the pull request's history (force-pushed away), so it can't be compared",
});

/** The fingerprint of the set of files held as test changes (paths only: the merge rule binds the content). */
export function heldFingerprint(files) {
  const set = [...new Set((files || []).map(String))].sort();
  return crypto.createHash('sha256').update(`pocp-held-v1\0tests\0${set.join('\0')}`).digest('hex');
}

/** The test files a verify result held: its net change's test guard, else each commit's. */
export function heldTestFiles(result) {
  if (!result) return [];
  if (result.net) return [...(result.net.test_guard?.files || [])];
  if (Array.isArray(result.commits)) return result.commits.flatMap((c) => c.test_guard?.files || []);
  return [...(result.test_guard?.files || [])];
}

/** The lines verify writes to --record-file: the held test set, and its verdict per compared label. */
export function recordLines({ heldTests, approvals = {} }) {
  const lines = [`held tests ${heldFingerprint(heldTests)}`];
  for (const [label, v] of Object.entries(approvals)) if (STICKY[label] && v?.verdict && v.head) lines.push(`approval ${label} ${v.verdict} ${v.head}`);
  return lines.filter((l) => RECORD_LINE.test(l));
}

/**
 * The records in a verify job's steps: { any, held: { tests }, approvals: { label: { verdict, head } } }.
 * any is false when it has none (a workflow older than sticky approvals). A record step that
 * didn't succeed, or two that disagree, counts as missing.
 */
export function readRecords(job) {
  const out = { any: false, held: {}, approvals: {}, verdict: verdictOf(job?.steps) };
  const clash = new Set();
  for (const s of job?.steps || []) {
    const name = String(s.name || '');
    if (!RECORD_PREFIXES.some((p) => name.startsWith(p)) || s.conclusion !== 'success') continue;
    let m = HELD_STEP.exec(name);
    if (m) {
      out.any = true;
      if (out.held.tests && out.held.tests !== m[1]) clash.add('held');
      out.held.tests = m[1];
      continue;
    }
    m = APPROVAL_STEP.exec(name);
    if (m) {
      out.any = true;
      const prev = out.approvals[m[1]];
      if (prev && (prev.verdict !== m[2] || prev.head !== m[3])) clash.add(m[1]);
      out.approvals[m[1]] = { verdict: m[2], head: m[3] };
    }
  }
  if (clash.has('held')) delete out.held.tests;
  for (const l of clash) delete out.approvals[l];
  return out;
}

/**
 * The test guard's typed verdict in a run's steps (the approval-reasons steps, verdict-<v>), by
 * the reporter's rule (status-report.js runVerdict): only with the approvable step, which comes
 * from the same file isolated checks can't reach, and exactly one verdict step. Else null.
 */
export function verdictOf(steps) {
  const ok = (name) => (steps || []).some((st) => st.name === name && st.conclusion === 'success');
  if (!ok('approvable')) return null;
  const hit = HOLD_VERDICTS.filter((v) => ok(`verdict-${v}`));
  return hit.length === 1 ? hit[0] : null;
}

/** The base a run's one marker step names for pull request `number`, or null. */
function markerBase(steps, number) {
  const markers = (steps || []).filter((s) => String(s.name || '').startsWith(MARKER_PREFIX));
  if (markers.length !== 1 || markers[0].conclusion !== 'success') return null;
  const m = /^pocp-run pr-(\d+) base-([0-9a-f]{40})$/.exec(markers[0].name);
  return m && Number(m[1]) === number ? m[2] : null;
}
const verifyRan = (steps) => {
  const v = (steps || []).find((s) => s.name === 'verify');
  return Boolean(v && v.conclusion && v.conclusion !== 'skipped');
};

/**
 * The records of head `sha`'s newest evaluation for this pull request and base: the newest
 * completed run of the trusted workflow on it whose verify step ran (not a run cancelled or
 * skipped before it, nor one whose prediction skipped verify). null when there is none yet, or
 * the newest doesn't say which pull request it was for: undecided.
 */
export function newestRecords(facts, sha) {
  const wf = facts.workflow;
  const at = (r) => String(r.run_started_at || r.created_at);
  const runs = (facts.runs || [])
    .filter((r) => (!wf || (r.workflow_id === wf.id && r.path === wf.path)) && r.event === 'pull_request' && r.head_sha === sha && r.status === 'completed')
    .filter((r) => verifyRan(r.job?.steps))
    .sort((a, b) => at(b).localeCompare(at(a)) || (b.run_attempt || 1) - (a.run_attempt || 1) || b.id - a.id);
  for (const r of runs) {
    const steps = r.job?.steps || [];
    const markers = steps.filter((s) => String(s.name || '').startsWith(MARKER_PREFIX));
    // A run that says it evaluated another pull request or base lets an older one speak.
    if (markers.length === 1 && markers[0].name !== `pocp-run pr-${facts.pr?.number} base-${facts.base_sha}`) continue;
    if (!markerBase(steps, facts.pr?.number)) return null;
    if (r.conclusion === 'cancelled' || r.job?.conclusion === 'cancelled') return null;
    return readRecords(r.job);
  }
  return null;
}

const lastApplied = (facts, label) => (facts.label_events || []).filter((e) => e.label === label).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);

/**
 * Whether `label` sticks to head `sha` from the head it was approved on.
 * { applies: false } when this rule says nothing (not a sticky label, or this head's evaluation
 * predates records: judged exactly as before). Otherwise { applies: true, ok, stale, why, from }:
 * stale only for a proven difference, never for missing data.
 * facts.sticky[label] comes from gatherSticky(). facts.records_now, when set, stands in for the
 * head's own run's records (verify decides before its run has any).
 */
export function stickyVerdict(facts, label, sha) {
  const kind = STICKY[label];
  // Not a sticky label, or a caller that gathered no sticky facts at all: the rule says nothing.
  if (!kind || facts.sticky === undefined) return { applies: false };
  const no = (stale, why) => ({ applies: true, ok: false, stale, why });
  const now = facts.records_now ?? newestRecords(facts, sha);
  if (now && !now.any) return { applies: false };
  if (!facts.label_events_complete) return no(false, "GitHub's list of the pull request's events was incomplete");
  const last = lastApplied(facts, label);
  if (!last) return no(false, `GitHub doesn't say who applied ${label}`);
  if (!last.permission) return no(false, `couldn't read ${last.actor || 'the labeller'}'s permission on the repository`);
  if (!WRITE_PERMISSIONS.has(last.permission)) return no(true, `${label} was last applied by ${last.actor || 'someone'}, without write access`);
  const s = facts.sticky?.[label];
  if (!s) return no(false, `no data on the head ${label} was given for`);
  if (!s.complete) return no(false, `couldn't tell which head ${label} was given for (${s.reason || 'a list was cut short'})`);
  // Which head was approved: the head of the newest run before the label, confirmed by the run
  // the label's own event started (the first run at or after it), with no force-push between.
  // A head pushed in the seconds before the label, whose run didn't exist yet, shows up as a
  // mismatch: the label may have been given for either, so it holds for neither.
  if (!s.head || !s.confirmed) return { applies: false };
  if (s.confirmed !== s.head) return no(true, `${label} was added while the head was moving (${short(s.head)}, then ${short(s.confirmed)}), so which one was approved isn't clear: review and re-apply it`);
  if ((facts.force_pushes || []).some((t) => String(t) > String(s.head_run_at) && String(t) < String(s.at))) return no(true, `the pull request was force-pushed just before ${label} was added, so which head was approved isn't clear: review and re-apply it`);
  if (!now) return no(false, `no finished evaluation of ${short(sha)} yet`);
  // From here the head's evaluation has finished. What it couldn't settle (verify couldn't
  // compare, or compared with another head; the approved head's run left no usable record) is
  // judged as before: the label doesn't count for this head and is removed, so adding it again
  // approves it, instead of a label that stays on and a status asking for it.
  const v = now.approvals[label];
  if (!v || v.head !== s.head) return { applies: false };
  if (v.verdict !== 'same') return no(true, `${label} was given for ${short(s.head)}, and ${DIFFERS[v.verdict] || v.verdict}: review and re-apply it`);
  if (kind === 'tests') {
    if (facts.records_now && !now.held.tests) return no(false, "which test changes this head holds is known once its checks ran: the trusted reporter decides from this run's record");
    // Only a review-only hold carries over, on both heads: a behaviour change is approved again,
    // with a run (the label's own event re-runs verify, and the run accepts it).
    const serious = [now.verdict, s.records?.verdict].find((v) => v && v !== REVIEW_ONLY);
    if (serious) return no(true, `${label} carries over to a new head only for a review-only hold (the old tests still pass), and the test guard found ${serious}: review the new head and re-apply it, and verify re-runs with it`);
    if (s.records?.any === false) return no(true, `${short(s.head)}'s run predates sticky approvals, so it doesn't say which test changes were approved: re-apply ${label}`);
    if (!s.records?.held.tests || !now.held.tests || now.verdict !== REVIEW_ONLY || s.records.verdict !== REVIEW_ONLY) return { applies: false };
    if (s.records.held.tests !== now.held.tests) return no(true, `${label} was given for ${short(s.head)}, but other files count as test changes now (the base changed what counts as a test): review and re-apply it`);
  }
  return { applies: true, ok: true, stale: false, from: s.head };
}

/**
 * For each sticky label among `labels`: the head it was given for (A: the head of the newest run
 * of the workflow on the pull request's head branch created before the label's last
 * application), when that run was created, the head of the first run at or after the label (its
 * own event's run, which must be A too), the base A's run evaluated (its marker), and that run's
 * records: { label: { complete, reason, head, head_run_at, confirmed, at, base, records } }. From GitHub's API only; never throws
 * (an error or a list cut short leaves the label incomplete).
 */
export async function gatherSticky(gh, repo, { number, headRef, headRepo, workflow, labels, labelEvents, verifyJob = 'verify' }) {
  const out = {};
  const want = [...new Set(labels || [])].filter((l) => STICKY[l]);
  if (!want.length) return out;
  const list = async (url, key, max) => (gh.list ? gh.list(url, key, max) : { items: await gh.all(url, key, max), complete: true, reason: null });
  if (!headRef || !headRepo) {
    for (const l of want) out[l] = { complete: false, reason: "GitHub didn't say the pull request's head branch" };
    return out;
  }
  let runs;
  try {
    const listed = await list(`${repo}/actions/workflows/${workflow.id}/runs?event=pull_request&branch=${encodeURIComponent(headRef || '')}&per_page=100`, 'workflow_runs', 5);
    if (!listed.complete) throw new Error(listed.reason || "the branch's runs were cut short");
    // Checked here too: a filter the API ignored must not let another branch's head be A.
    runs = listed.items.filter((r) => r.path === workflow.path && r.event === 'pull_request' && r.head_branch === headRef && (r.head_repository?.full_name ?? null) === headRepo);
  } catch (e) {
    for (const l of want) out[l] = { complete: false, reason: e.message };
    return out;
  }
  const jobs = new Map();
  const stepsOf = async (id) => {
    if (!jobs.has(id)) {
      const listed = await list(`${repo}/actions/runs/${id}/jobs?per_page=100`, 'jobs', 3);
      const job = listed.complete ? listed.items.find((j) => j.name === verifyJob) : undefined;
      jobs.set(id, job === undefined ? undefined : (job.steps || []).map((st) => ({ name: st.name, conclusion: st.conclusion })));
    }
    return jobs.get(id);
  };
  for (const label of want) {
    const last = (labelEvents || []).filter((e) => e.label === label).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
    if (!last) {
      out[label] = { complete: true, reason: null, head: null };
      continue;
    }
    const before = runs.filter((r) => String(r.created_at) < String(last.created_at)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
    const after = runs.filter((r) => String(r.created_at) >= String(last.created_at)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
    const entry = { complete: true, reason: null, head: before[0]?.head_sha || null, head_run_at: before[0]?.created_at || null, confirmed: after[0]?.head_sha || null, at: last.created_at, base: null, records: null };
    try {
      for (const r of before.filter((x) => x.head_sha === entry.head && x.status === 'completed').slice(0, 5)) {
        const steps = await stepsOf(r.id);
        if (steps === undefined) {
          entry.complete = false;
          entry.reason = "a run's job list was cut short";
          break;
        }
        const base = markerBase(steps, number);
        if (!base || !verifyRan(steps)) continue;
        entry.base = base;
        entry.records = readRecords({ steps });
        break;
      }
    } catch (e) {
      entry.complete = false;
      entry.reason = e.message;
    }
    out[label] = entry;
  }
  return out;
}

// ------------------------------------------------------------------ verify's side (git)

const commitOf = (root, rev) => git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
const treeOf = (root, rev) => git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { allowFail: true });
const namesBetween = (root, a, b, paths = []) => git(root, ['diff', '--name-only', '--no-renames', '-z', a, b, ...(paths.length ? ['--', ...paths] : [])], { trim: false, allowFail: true });
const splitZ = (s) => String(s || '').split(/[\0\n]/).filter(Boolean);

/** The CI files among `files`, by the base's ci.files and ci.files_except (CI definitions always included). */
export function ciFilesOf(files, baseConfig) {
  const ci = { files: [...new Set([...DEFAULT_CI_FILES, ...(baseConfig?.ci?.files || [])])], files_except: baseConfig?.ci?.files_except || [] };
  return files.filter((f) => ciProtects(f, ci, { withDefaults: true }));
}

/**
 * The tree of a clean merge of `a` and `b`, with no attributes (a merge driver such as `union`
 * set by the pull request's .gitattributes never decides it): { tree }, { conflict: true }, or
 * { unsupported: why } when this git can't (merge-tree --write-tree is git 2.38+).
 */
export function cleanMergeTree(root, a, b) {
  const args = ['-c', `attr.tree=${EMPTY_TREE}`, 'merge-tree', '--write-tree', '--no-messages'];
  if (git(root, [...args, a, a], { allowFail: true }) === null) return { unsupported: "this git can't merge without a work tree (git 2.38 or later can)" };
  const out = git(root, [...args, a, b], { allowFail: true });
  if (out === null) return { conflict: true };
  const tree = out.split('\n')[0].trim();
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree) ? { tree } : { unsupported: `unexpected merge-tree output "${tree.slice(0, 20)}"` };
}

/**
 * Whether `head` is exactly the approved head `approved` plus base content, for a pull request
 * into `base`: { verdict, files, why }. verdict is 'same', a key of DIFFERS, or null when it
 * can't tell (nothing is recorded then). `approvedBase` is the base A's run evaluated (its
 * marker): the base's policy files must be the same there and at `base`. `local`: for a local
 * approval (`--accept-test-change=<sha>`), which rests on no run's record, so the approved head
 * may change CI files (a CI change still needs its own approval).
 */
export function compareWithApproved(root, { approved, head, base, approvedBase = null, baseConfig = null, local = false }) {
  const unknown = (why) => ({ verdict: null, files: [], why });
  const H = commitOf(root, head);
  const B = commitOf(root, base);
  if (!H || !B) return unknown('the head or the base is not in this checkout');
  const A = /^[0-9a-f]{40}$/.test(String(approved)) ? commitOf(root, approved) : null;
  if (!A) {
    // Missing from a full clone: it is in none of its branches (force-pushed away). A shallow
    // clone may simply not have fetched it: then nothing is proven.
    if (git(root, ['rev-parse', '--is-shallow-repository'], { allowFail: true }) !== 'false') return unknown("the approved head isn't in this checkout, which is shallow");
    return { verdict: 'gone', files: [], why: DIFFERS.gone };
  }
  const mbA = git(root, ['merge-base', A, B], { allowFail: true });
  if (!mbA) return unknown('the approved head has no merge base with the base branch');
  // A's own changes touch no CI file: its run's steps came from the base's workflow.
  const own = namesBetween(root, mbA, A);
  if (own === null) return unknown("couldn't list the approved head's changes");
  const ci = local ? [] : ciFilesOf(splitZ(own), baseConfig);
  if (ci.length) return { verdict: 'ci', files: ci, why: DIFFERS.ci };
  // The base's policy now, against the policy A's run was judged by.
  const pb = approvedBase && commitOf(root, approvedBase) ? approvedBase : mbA;
  const pol = namesBetween(root, pb, B, ['.proof']);
  if (pol === null) return unknown("couldn't compare the base's policy");
  const policy = splitZ(pol).filter(isPolicyPath);
  if (policy.length) return { verdict: 'policy', files: policy, why: DIFFERS.policy };
  const tH = treeOf(root, H);
  // Always against the merge, never "H's tree is A's": a merge that keeps the pull request's
  // side (-s ours) has A's tree and undoes what the base changed (a new test, a fix), which
  // nobody approved. H's base content: up to its own merge base with the base branch, so a head
  // that is behind still matches the approved head plus the base content it has (and a head
  // that took none in is A's tree, the merge of A with an ancestor).
  const bases = splitZ(git(root, ['merge-base', '--all', H, B], { allowFail: true }));
  if (bases.length !== 1) return unknown(bases.length ? 'the head has more than one merge base with the base branch' : 'the head has no merge base with the base branch');
  const merged = cleanMergeTree(root, A, bases[0]);
  if (merged.unsupported) return unknown(merged.unsupported);
  if (merged.conflict) return { verdict: 'conflict', files: [], why: DIFFERS.conflict };
  if (merged.tree === tH) return { verdict: 'same', files: [], why: null };
  return { verdict: 'content', files: splitZ(namesBetween(root, merged.tree, H)), why: DIFFERS.content };
}

/**
 * The test guard's verdicts in a verify result (every mechanical check of the held tests: the net
 * change's, and each commit's), for a local approval given for another head: it carries only when
 * every one is review-only. 'passed' (the check proved the tests still catch what they caught)
 * holds nothing. Empty when no check ran (verify without --rerun): then it doesn't carry.
 */
export function guardVerdicts(result) {
  const out = [];
  const from = (g) => { for (const m of g?.mechanical || []) out.push(m.verdict ?? null); };
  if (!result) return out;
  from(result.net?.test_guard);
  for (const c of result.commits || []) from(c.test_guard);
  from(result.test_guard);
  return out;
}
