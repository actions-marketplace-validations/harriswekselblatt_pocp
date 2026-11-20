import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GITHUB_WORKFLOWS, LEGACY_GITHUB_WORKFLOWS } from './init.js';

// GitHub Actions workflows that fail only because Actions can't start their jobs for billing (no
// minutes left, a spending limit reached, a failed payment). In local mode nothing needs them, and
// each push turns them into a red ✗ and a failure email. `pocp doctor` and `pocp ci off` find them
// and offer to disable them on GitHub: listed with their evidence, confirmed first, reversible
// (gh workflow enable), and never by editing or deleting a workflow file.

// The annotation GitHub puts on a job it never started because of the account's billing.
// The shape is recorded from GitHub in test/fixtures/github-billing/.
export const ACTIONS_BILLING = /recent account payments have failed|spending limit/i;

const OURS = [...GITHUB_WORKFLOWS, ...LEGACY_GITHUB_WORKFLOWS].map((f) => `.github/workflows/${f}`);
export const isPocpWorkflow = (p) => OURS.includes(p);

// Workflows missing from the recent runs looked up one by one, at most this many.
const MAX_LOOKUPS = 10;
/** A blocked run older than this is no evidence: billing may have been fixed since without any
 *  workflow running to show it. */
export const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function gh(args) {
  const bin = process.env.POCP_GH || 'gh';
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) return { ok: false, missing: true, message: `${bin} is not installed (https://cli.github.com)` };
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch { /* not JSON */ }
  const message = json?.message || (r.stderr || '').trim() || `${bin} exited ${r.status}`;
  // ok is the exit status alone: a 204 (a disable) has no body. Readers check json themselves.
  return { ok: r.status === 0, json, message };
}

/** Why a gh call failed, said so a person knows what to do; rate_limited stops a scan. */
export function ghProblem(r) {
  if (r.missing) return { reason: r.message };
  if (/rate limit/i.test(r.message)) return { reason: "GitHub's API rate limit is reached; try again once it resets", rate_limited: true };
  if (/gh auth login|not logged in|bad credentials|HTTP 401/i.test(r.message)) return { reason: 'gh is not logged in: run gh auth login' };
  return { reason: r.message };
}

/**
 * Which of the repository's active workflows fail because GitHub Actions doesn't start their
 * jobs for billing. A workflow counts only with all the evidence:
 *   - its latest finished run on the default branch, from this repository and not a pull request,
 *     failed (a pull request branch, or a fork's branch named like the default, can push a run
 *     built to fail; a workflow that runs only on pull requests has no evidence and is not offered);
 *   - no job in that run ran a step (GitHub started none of them; a run where some jobs ran, a
 *     paid runner blocked beside free ones, is not offered), and at least one failed;
 *   - the first failed job carries GitHub's billing annotation, as a failure;
 *   - no newer run of an active workflow in the recent runs started its jobs (a success, or a
 *     failure whose jobs ran), on any branch: once billing is fixed, an old blocked run is not evidence.
 * A job that ran can print any text, so a job with steps is never evidence.
 * `workflows` is GitHub's list ({ id, name, path, state }). Calls: one for the default branch
 * (unknown: the scan stops, never falling back to any branch), one for the recent runs, then
 * per failed workflow two (its jobs, one job's annotations), and one per workflow missing from
 * the recent runs (at most MAX_LOOKUPS), and the jobs of up to MAX_LOOKUPS failed runs newer than a hit.
 *
 * Returns { found: [{ id, name, path, file, pocp, run, message }], unchecked: [path],
 * incomplete: reason | null }. An unreadable answer about one workflow leaves it unchecked; a
 * failed first call or a rate limit stops the scan (incomplete). Nothing unchecked is offered.
 */
export function billingFailedWorkflows(repo, workflows, { call = gh, anyBranch = false, now = Date.now() } = {}) {
  const active = (workflows || []).filter((w) => w.state === 'active' && String(w.path).startsWith('.github/workflows/'));
  const result = { found: [], unchecked: [], incomplete: null };
  if (!active.length) return result;
  // A stopped scan offers nothing, not even what it found before stopping.
  const stop = (r) => ({ found: [], unchecked: [], incomplete: ghProblem(r).reason });
  // Evidence comes only from runs of the default branch, of this repository, not for a pull
  // request. anyBranch (doctor's report with CI, which disables nothing; POCP's own workflow runs
  // only on pull requests) takes any run.
  let branch = null;
  if (!anyBranch) {
    const info = call(['api', `repos/${repo}`]);
    branch = info.json?.default_branch;
    if (!info.ok || typeof branch !== 'string' || !branch) return stop(info.ok ? { message: `GitHub did not say which branch is the default on ${repo}` } : info);
  }
  const onDefault = (r) => anyBranch || (r.head_branch === branch
    && String(r.head_repository?.full_name || '').toLowerCase() === repo.toLowerCase()
    && !/^pull_request/.test(r.event || ''));
  const runs = call(['api', `repos/${repo}/actions/runs?per_page=20&status=completed`]);
  if (!runs.ok || !Array.isArray(runs.json?.workflow_runs)) return stop(runs);
  const recent = runs.json.workflow_runs;
  const activeIds = new Set(active.map((w) => w.id));
  const activePaths = new Set(active.map((w) => w.path));
  const ofActive = (r) => activeIds.has(r.workflow_id) || activePaths.has(r.path);
  // Newest first: the first run seen for a workflow is its latest. A run's position is its age;
  // a run looked up on its own is older than every recent one.
  const position = new Map(recent.map((r, i) => [r.id, i]));
  const byId = new Map();
  const byPath = new Map();
  for (const r of recent.filter(onDefault)) {
    if (r.workflow_id != null && !byId.has(r.workflow_id)) byId.set(r.workflow_id, r);
    if (r.path && !byPath.has(r.path)) byPath.set(r.path, r);
  }
  // Recent runs known to have started their jobs. Any workflow's counts, disabled ones included
  // (POCP's own, once `ci off` has switched them off): billing is the repository's, not a
  // workflow's, so a job that started shows it works.
  const started = new Set(recent.filter((r) => r.conclusion === 'success').map((r) => r.id));
  const hits = [];
  const seen = new Set(); // runs whose jobs were read
  let lookups = 0;
  for (const w of active) {
    let latest = byId.get(w.id) || byPath.get(w.path);
    if (!latest) {
      if (lookups++ >= MAX_LOOKUPS) {
        result.unchecked.push(w.path);
        continue;
      }
      const one = call(['api', `repos/${repo}/actions/workflows/${w.id}/runs?${anyBranch ? 'per_page=1&status=completed' : `per_page=10&status=completed&branch=${encodeURIComponent(branch)}`}`]);
      if (!one.ok || !Array.isArray(one.json?.workflow_runs)) {
        if (ghProblem(one).rate_limited) return stop(one);
        result.unchecked.push(w.path);
        continue;
      }
      latest = one.json.workflow_runs.find(onDefault);
      if (!latest) continue; // never ran on the default branch: no evidence
    }
    if (latest.conclusion !== 'failure') continue;
    const created = Date.parse(latest.created_at || '');
    if (!Number.isFinite(created)) {
      result.unchecked.push(w.path);
      continue;
    }
    if (now - created > MAX_EVIDENCE_AGE_MS) continue; // too old to say anything about today
    const jobs = call(['api', `repos/${repo}/actions/runs/${latest.id}/jobs`]);
    seen.add(latest.id);
    if (!jobs.ok || !Array.isArray(jobs.json?.jobs)) {
      if (ghProblem(jobs).rate_limited) return stop(jobs);
      result.unchecked.push(w.path);
      continue;
    }
    const list = jobs.json.jobs;
    if (list.some((j) => (j.steps || []).length)) {
      started.add(latest.id); // its jobs ran, and failed on their own
      continue;
    }
    const unstarted = list.find((j) => j.conclusion === 'failure');
    if (!unstarted) continue;
    const notes = call(['api', `repos/${repo}/check-runs/${unstarted.id}/annotations`]);
    if (!notes.ok || !Array.isArray(notes.json)) {
      if (ghProblem(notes).rate_limited) return stop(notes);
      result.unchecked.push(w.path);
      continue;
    }
    const hit = notes.json.find((a) => a.annotation_level === 'failure' && ACTIONS_BILLING.test(a.message || ''));
    if (!hit) continue;
    hits.push({
      id: w.id,
      name: w.name || path.basename(w.path),
      path: w.path,
      file: path.basename(w.path),
      pocp: isPocpWorkflow(w.path),
      run: { id: latest.id, conclusion: latest.conclusion, event: latest.event || null, created_at: latest.created_at || null, url: latest.html_url || null },
      message: hit.message,
    });
  }
  // A newer failed run, on any branch, whose jobs ran shows billing works again: read the jobs of
  // the failed runs newer than a hit (at most MAX_LOOKUPS). One that can't be read leaves the
  // hits older than it unchecked.
  const age = (id) => (position.has(id) ? position.get(id) : Infinity);
  const oldest = Math.max(-1, ...hits.map((h) => age(h.run.id)));
  const doubtful = [];
  let extra = 0;
  for (const r of recent) {
    if (age(r.id) >= oldest) break;
    if (r.conclusion !== 'failure' || started.has(r.id) || seen.has(r.id)) continue;
    if (extra++ >= MAX_LOOKUPS) {
      doubtful.push(age(r.id));
      continue;
    }
    const jobs = call(['api', `repos/${repo}/actions/runs/${r.id}/jobs`]);
    if (!jobs.ok || !Array.isArray(jobs.json?.jobs)) {
      if (ghProblem(jobs).rate_limited) return stop(jobs);
      doubtful.push(age(r.id));
      continue;
    }
    if (jobs.json.jobs.some((j) => (j.steps || []).length)) started.add(r.id);
  }
  // Drop a blocked run that a newer started run shows to be over.
  const live = hits.filter((h) => ![...started].some((id) => age(id) < age(h.run.id)));
  result.found = live.filter((h) => !doubtful.some((a) => a < age(h.run.id)));
  result.unchecked.push(...live.filter((h) => !result.found.includes(h)).map((h) => h.path));
  return result;
}

/**
 * The workflows (not POCP's) disabled on GitHub, by anyone: POCP's billing offer, gh workflow
 * disable or the Actions page. GitHub doesn't say who, so all are listed. A workflow disabled
 * while billing blocked it stays off once billing is fixed, and its checks are silently gone.
 */
export function disabledWorkflows(workflows) {
  return (workflows || [])
    .filter((w) => w.state === 'disabled_manually' && String(w.path).startsWith('.github/workflows/') && !isPocpWorkflow(w.path))
    .map((w) => ({ id: w.id, name: w.name || path.basename(w.path), path: w.path, file: path.basename(w.path) }));
}

/** The lines that list them, each with the command that turns it back on. */
export function disabledLines(repo, off) {
  return [`${off.length} workflow(s) on ${repo} are disabled on GitHub, so their checks don't run:`, ...off.map((w) => `  ${w.name} (${w.path}): to turn it back on: gh workflow enable ${w.file}`)];
}

/** Doctor's "workflows-disabled" check (a warning, so none is forgotten), or null. */
export function disabledCheck({ repo, workflows }) {
  const off = disabledWorkflows(workflows);
  if (!off.length) return null;
  return {
    id: 'workflows-disabled',
    status: 'warning',
    what: `${off.length} workflow(s) on ${repo} are disabled on GitHub, so their checks don't run: ${off.map((w) => w.path).join(', ')}`,
    why: 'a workflow disabled while billing blocked it stays off after billing is fixed, and nothing else says so',
    fix: `${off.map((w) => `gh workflow enable ${w.file}`).join(', then ')} (or leave it off, if that is intended)`,
    workflows: off,
  };
}

/** Whether the repository is private (true / false), or null when gh can't say. */
export function repoIsPrivate(repo, { call = gh } = {}) {
  const r = call(['repo', 'view', repo, '--json', 'isPrivate']);
  return r.ok && typeof r.json?.isPrivate === 'boolean' ? r.json.isPrivate : null;
}

/** Disable each workflow on GitHub (reversible; the files are not touched). */
export function disableWorkflows(repo, found, { call = gh } = {}) {
  const disabled = [];
  const failed = [];
  for (const w of found) {
    const r = call(['api', '-X', 'PUT', `repos/${repo}/actions/workflows/${w.id}/disable`]);
    if (r.ok) disabled.push(w.path);
    else failed.push({ path: w.path, error: ghProblem(r).reason });
  }
  return { disabled, failed };
}

const firstSentence = (m) => String(m).split(/\.\s/)[0].replace(/\.$/, '');

/**
 * Doctor's "actions-billing" check, or null when no workflow fails for billing. With CI: a
 * problem (POCP's own checks can't run either), fixed by local mode. In local mode: a warning
 * listing the workflows doctor offers to disable (`offer`: not POCP's, which ci off switches).
 * Each carries the evidence (`workflows`). A scan that couldn't finish is "skipped".
 */
export function billingCheck({ repo, workflows, local, isPrivate = null, call = gh }) {
  const scan = billingFailedWorkflows(repo, workflows, { call, anyBranch: !local });
  if (scan.incomplete) return { id: 'actions-billing', status: 'skipped', what: `could not check whether workflows fail for billing: ${scan.incomplete}` };
  const { found, unchecked } = scan;
  if (!found.length) return null;
  const evidence = { repo, private: isPrivate, workflows: found, unchecked };
  if (!local) {
    const active = workflows.filter((w) => w.state === 'active').map((w) => w.path).sort();
    const others = active.filter((f) => !isPocpWorkflow(f));
    const steps = [...(active.some(isPocpWorkflow) ? ['pocp ci off (local mode)'] : []), ...others.map((f) => `gh workflow disable ${path.basename(f)}`)];
    return { id: 'actions-billing', status: 'problem', what: `GitHub Actions jobs on ${repo} are not starting: ${found[0].message.split(/\.\s/)[0]}`, why: `every push starts ${active.length} workflow(s) that fail at once and email you: ${active.join(', ')}`, fix: `${steps.join(', then ')}; or fix billing in Settings → Billing and plans`, ...evidence };
  }
  const offer = found.filter((w) => !w.pocp);
  const steps = [
    ...(found.some((w) => w.pocp) ? ["pocp ci off (POCP's own)"] : []),
    ...(offer.length ? ['pocp doctor --disable-billing-failed (or answer yes when doctor asks): it disables them on GitHub without touching their files, and gh workflow enable <file> turns one back on'] : []),
  ];
  return {
    id: 'actions-billing',
    status: 'warning',
    what: `${found.length} workflow(s) on ${repo} fail because GitHub Actions doesn't start their jobs for billing: ${found.map((w) => w.path).join(', ')}`,
    why: 'local mode needs none of them, and each push makes them fail at once and email you',
    fix: `${steps.join(', then ')}; or fix billing in Settings → Billing and plans`,
    ...evidence,
    offer,
  };
}

/** The evidence, one workflow per line, and what billing means for this repository. */
export function evidenceLines(repo, found, isPrivate) {
  const lines = [`${found.length} workflow(s) on ${repo} fail because GitHub Actions doesn't start their jobs for billing:`];
  for (const w of found) {
    const when = w.run.created_at ? ` on ${w.run.created_at.slice(0, 10)}` : '';
    lines.push(`  ${w.name} (${w.path}): latest run ${w.run.id}${when}: ${w.run.conclusion}, "${firstSentence(w.message)}"`);
  }
  if (isPrivate === true) lines.push('  this repository is private, so its jobs spend the account\'s Actions minutes: they start again once the minutes reset or the spending limit is raised (Settings → Billing and plans)');
  else if (isPrivate === false) lines.push('  this repository is public, where standard GitHub-hosted runners are free: the block is a failed payment, a locked account or a paid runner (Settings → Billing and plans)');
  return lines;
}

/**
 * The offer, shared by `pocp doctor` and `pocp ci off`. `found` holds only workflows that aren't
 * POCP's (ci off switches those). Acts only on `disable` (--disable-billing-failed) or on a yes
 * to one question listing everything; anything else reports. `retry` is the command that acts.
 * Returns { found, private, decision: "disabled" | "declined" | "report-only", disabled, failed }.
 */
export async function offerDisable({ repo, found, isPrivate = null, disable = false, interactive = false, ask, say = () => {}, retry, call = gh }) {
  const result = { found, private: isPrivate, decision: 'report-only', disabled: [], failed: [] };
  if (!found.length) return result;
  for (const l of evidenceLines(repo, found, isPrivate)) say(l);
  let yes = disable;
  if (!yes && interactive) {
    const answer = await ask(`Disable ${found.length === 1 ? 'it' : `these ${found.length}`} on GitHub? The workflow files stay as they are, and gh workflow enable <file> turns one back on. [y/N] `);
    yes = /^y(es)?$/i.test(String(answer || '').trim());
    if (!yes) result.decision = 'declined';
  }
  if (!yes) {
    say(result.decision === 'declined'
      ? `  left as they are. Later: ${retry}, or gh workflow disable <file>`
      : `  not disabled (nothing was asked: no terminal, or --json). To disable them: ${retry}, or gh workflow disable <file>`);
    return result;
  }
  const d = disableWorkflows(repo, found, { call });
  Object.assign(result, { decision: 'disabled', ...d });
  if (d.disabled.length) say(`  disabled on ${repo}: ${d.disabled.join(', ')} (the files are unchanged)`);
  for (const f of d.failed) say(`  could not disable ${f.path}: ${f.error}`);
  for (const p of d.disabled) say(`  to turn it back on: gh workflow enable ${path.basename(p)}`);
  return result;
}
