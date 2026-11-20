import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as g from './git.js';
import { matchGlob } from './glob.js';
import { GITHUB_WORKFLOWS, hooksHealth, INSTALL_HINT, LEGACY_GITHUB_WORKFLOWS, recordedBin } from './init.js';
import { LOCAL_MODE_TRADE, STATUS_CHECK, listWorkflows, localVerifyCommand, protectionGaps, reporterIdentityNote, requiredChecksPlan, verifyBase } from './ci-github.js';
import { validateRules } from './rules.js';
import { policyKeyWarnings } from './schema.js';
import { validateConfig } from './store.js';
import { APPROVE_INCONCLUSIVE_LABEL, APPROVE_POLICY_LABEL, APPROVE_TESTS_LABEL } from './remedies.js';
import { APPROVE_WORKFLOW_LABEL } from './status-report.js';
import { versionChecks } from './upgrade.js';

// Every approval label, and what a maintainer approves with it (for `gh label create`).
export const APPROVAL_LABELS = Object.freeze({
  [APPROVE_TESTS_LABEL]: 'a test change',
  [APPROVE_POLICY_LABEL]: 'a policy change',
  'pocp-approve-coverage': 'commits listed in .proof/exceptions.json',
  [APPROVE_INCONCLUSIVE_LABEL]: "a test change whose check didn't finish",
  [APPROVE_WORKFLOW_LABEL]: 'a CI workflow change',
});

// `pocp doctor`: the adoption pitfalls, checked. Each check is
//   { id, status: "ok" | "problem" | "warning" | "skipped", what, why?, fix? }
// Read-only: it never changes the repository, the host, or GitHub.

function gh(root, args) {
  const r = spawnSync(process.env.POCP_GH || 'gh', args, { cwd: root, encoding: 'utf8' });
  if (r.error) return { ok: false, missing: true, error: r.error.message, stdout: '' };
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch { /* not JSON */ }
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: (r.stderr || '').trim(), json, message: json?.message || (r.stderr || '').trim() };
}

/** Workflow files and what they say about POCP. */
export function scanWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/pocp/i.test(text)) continue;
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*['"]?([\w.-]+\/[\w.-]+)(?:\/[^@\s'"]*)?@([^\s'"#]+)/gm)]
      .map((m) => ({ repo: m[1], ref: m[2] }))
      .filter((u) => /pocp/i.test(u.repo));
    const codeLines = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).filter((l) => l.trim());
    const verifyUses = [...text.matchAll(/^\s*-?\s*uses:\s*['"]?([\w.-]+\/[\w.-]*pocp[\w.-]*)@/gim)];
    const jobs = [];
    const jobsAt = text.search(/^jobs:\s*$/m);
    if (jobsAt !== -1) {
      for (const m of text.slice(jobsAt).matchAll(/^ {2}([\w-]+):\s*$/gm)) {
        const block = text.slice(jobsAt + m.index, jobsAt + m.index + 2000);
        const name = /^ {4}name:\s*['"]?([^'"\n]+)/m.exec(block)?.[1]?.trim();
        jobs.push(name || m[1]);
      }
    }
    out.push({
      file: `.github/workflows/${f}`,
      uses,
      local_action: /^\s*-?\s*uses:\s*\.\/?\s*$/m.test(text),
      // Runs verify: calls `pocp verify` / `pocp.js verify`, or uses the POCP action itself (not
      // only its /status reporter). A comment mentioning "verify" doesn't count.
      runs_verify: codeLines.some((l) => /\bpocp(\.js)?\s+verify\b/.test(l)) || verifyUses.length > 0,
      jobs,
      labels: { tests: text.includes(APPROVE_TESTS_LABEL), policy: text.includes(APPROVE_POLICY_LABEL) },
      mentions: Object.keys(APPROVAL_LABELS).filter((l) => text.includes(l)),
      exit_detail: /exit-detail:\s*true|--exit-detail/.test(text),
      label_freshness: codeLines.some((l) => /^\s*label-freshness:\s*['"]?github\b|--label-freshness/.test(l)),
      // Sets the status: runs status-report, or uses the status action, other than to predict
      // (pocp.yml's approval job uses them too, with --predict-approval / predict-approval).
      reporter: codeLines.some((l) => /\bstatus-report\b/.test(l) && !/--predict-approval/.test(l))
        || codeLines.filter((l) => /\/pocp\/status@/.test(l)).length > codeLines.filter((l) => /^\s*predict-approval:\s*['"]?true/.test(l)).length,
      // The status action's refs: in pocp-status.yml (the reporter) and in pocp.yml (the approval
      // job's prediction).
      status_refs: [...new Set([...text.matchAll(/^\s*-?\s*uses:\s*['"]?[\w.-]+\/[\w.-]*pocp[\w.-]*\/status@([^\s'"#]+)/gim)].map((m) => m[1]))],
    });
  }
  return out;
}

/** Obligations that run pocp itself: CI can't, unless it installs pocp first. */
export function selfCallingRequirements(rules) {
  return (rules.requirements || []).filter((r) => /(^|[\s;&|(])(npx\s+(--yes\s+)?)?pocp(\s|$)/.test(r.obligation?.run || '')).map((r) => r.id);
}

/**
 * The first adoption pull request should carry only .proof/ and CI files. Until it merges, the
 * local gate judges with this branch's rules while CI judges with the base's (none: defaults),
 * so any other change gets two different verdicts.
 */
export function adoptionScope(root, base, cfg) {
  const baseSha = g.git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true });
  if (!baseSha) return { base, known: false };
  const adopted = g.showFile(root, baseSha, '.proof/rules.json') !== null;
  if (adopted) return { base, known: true, adopted: true };
  const mb = g.git(root, ['merge-base', baseSha, 'HEAD'], { allowFail: true }) || baseSha;
  const committed = (g.git(root, ['diff', '--name-only', '-z', mb, 'HEAD'], { trim: false, allowFail: true }) || '').split('\0').filter(Boolean);
  const staged = (g.git(root, ['diff', '--cached', '--name-only', '-z'], { trim: false, allowFail: true }) || '').split('\0').filter(Boolean);
  const ciGlobs = cfg.ci?.files || ['.github/workflows/**'];
  const isAdoptionFile = (f) => g.isProofPath(f) || ciGlobs.some((gl) => matchGlob(f, gl));
  const files = [...new Set([...committed, ...staged])].sort();
  return { base, known: true, adopted: false, files, extra: files.filter((f) => !isAdoptionFile(f)) };
}

// The annotation GitHub puts on a job it never started because of the account's billing.
const ACTIONS_BILLING = /recent account payments have failed|spending limit/i;

/**
 * Whether GitHub Actions jobs are failing before they start, for billing: the latest finished
 * run of a workflow that is still enabled failed, with a job that ran no steps, whose annotation
 * is GitHub's billing message. Three gh calls; null when not (or when anything can't be read).
 */
function actionsBlocked(root, repo, workflows) {
  const active = new Set(workflows.filter((w) => w.state === 'active').map((w) => w.path));
  if (!active.size) return null;
  const runs = gh(root, ['api', `repos/${repo}/actions/runs?per_page=20&status=completed`]);
  const latest = (runs.json?.workflow_runs || []).find((r) => active.has(r.path));
  if (!latest || latest.conclusion !== 'failure') return null;
  const jobs = gh(root, ['api', `repos/${repo}/actions/runs/${latest.id}/jobs`]);
  const job = (jobs.json?.jobs || []).find((j) => j.conclusion === 'failure' && !(j.steps || []).length);
  if (!job) return null;
  const notes = gh(root, ['api', `repos/${repo}/check-runs/${job.id}/annotations`]);
  const hit = (Array.isArray(notes.json) ? notes.json : []).find((a) => ACTIONS_BILLING.test(a.message || ''));
  return hit ? { message: hit.message, active: [...active].sort() } : null;
}

export async function runDoctor(engine, { base, offline = false } = {}) {
  const root = engine.root;
  const checks = [];
  const add = (c) => checks.push(c);
  const cfg = engine.config();
  // Local mode (ci.mode "local"): no CI by choice, so the CI checks below don't apply.
  const local = cfg.ci?.mode === 'local';

  // 1. POCP set up here, and the policy valid.
  const rulesFile = path.join(root, '.proof', 'rules.json');
  if (!fs.existsSync(rulesFile)) {
    add({ id: 'adopted', status: 'problem', what: 'POCP is not set up in this checkout (no .proof/rules.json)', why: 'without rules the hooks do nothing', fix: 'pocp init --hooks' });
  } else {
    const problems = [...validateRules(engine.store.readRawRules() || {}), ...validateConfig(cfg).map((p) => `config: ${p}`)];
    add(problems.length
      ? { id: 'policy', status: 'problem', what: `invalid policy: ${problems.slice(0, 3).join('; ')}`, why: 'the gate refuses every commit and verify fails every PR while the policy is invalid', fix: 'edit .proof/rules.json / .proof/config.json until "pocp rules check" passes' }
      : { id: 'policy', status: 'ok', what: 'rules and config are valid' });
    const keys = policyKeyWarnings({ rules: engine.store.readRawRules(), config: engine.store.readRawConfig?.() });
    if (keys.length) add({ id: 'policy_keys', status: 'warning', what: keys.slice(0, 3).join('; ') + (keys.length > 3 ? ` (and ${keys.length - 3} more)` : ''), why: 'POCP ignores keys it doesn\'t know, so a misspelled setting is silently off', fix: 'correct each key, or start it with "$" to keep it as a comment; "pocp rules check" lists them all' });
  }

  // 2. Hooks installed and able to find pocp.
  const h = hooksHealth(root);
  const broken = Object.entries(h.hooks).filter(([, st]) => st === 'broken' || st === 'never runs');
  if (!h.installed) add({ id: 'hooks', status: 'problem', what: 'git hooks are not installed', why: local ? 'in local mode the hooks are the only check, so nothing checks a commit' : 'without them nothing checks a commit until CI, where fixing it means rewriting pushed commits', fix: 'pocp hooks install' });
  else if (broken.length) {
    // Hooks an older pocp appended to: a node/python hook (syntax error), or one that ends in exec.
    add({
      id: 'hooks',
      status: 'problem',
      what: h.problems.join('; '),
      why: broken.some(([, st]) => st === 'broken')
        ? "pocp's block is shell, and the hook runs with another interpreter"
        : 'the existing hook hands over to another program (or exits) before reaching pocp, so the gate is silently off',
      fix: `pocp hooks install (it moves the original hook to <hook>.pre-pocp and chains it: the original runs first, then pocp)`,
    });
  } else if (h.problems.length) add({ id: 'hooks', status: 'problem', what: h.problems.join('; '), why: 'git skips a hook that is missing or not executable', fix: h.managedBy === 'pre-commit' ? 'add the missing pocp hook ids to .pre-commit-config.yaml, then pre-commit install' : 'pocp hooks install' });
  else if (h.managedBy === 'pre-commit') add({ id: 'hooks', status: 'ok', what: 'hooks run through the pre-commit framework (pocp-gate, pocp-trailer, pocp-land), which installs pocp for them' });
  else {
    // The order the hooks use: POCP_BIN, the project's own copy, PATH, then the pocp that installed them.
    const local = fs.existsSync(path.join(root, 'node_modules', '.bin', 'pocp')) ? 'node_modules/.bin/pocp' : '';
    const onPath = spawnSync('sh', ['-c', 'command -v pocp'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const pre = path.join(h.dir, 'pre-commit');
    const recorded = recordedBin(fs.existsSync(pre) ? fs.readFileSync(pre, 'utf8') : '');
    const known = recorded && fs.existsSync(recorded) ? `the pocp that installed them (${recorded})` : '';
    const found = process.env.POCP_BIN || local || (onPath && 'pocp from PATH') || known;
    add(found
      ? { id: 'hooks', status: 'ok', what: `hooks installed in ${path.relative(root, h.dir) || h.dir}; they run ${found}` }
      : { id: 'hooks', status: 'problem', what: 'hooks are installed but cannot find pocp', why: 'each commit would fail with "pocp: not found"', fix: `${INSTALL_HINT}, put pocp on PATH, or set POCP_BIN` });
    if (g.git(root, ['rev-parse', '--git-common-dir']) !== g.git(root, ['rev-parse', '--git-dir'])) {
      add({ id: 'hooks-shared', status: 'warning', what: 'this is a linked worktree: git hooks are shared by every checkout of the repository', why: 'checkouts without .proof/rules.json are left alone, so this is safe, but every checkout that has adopted POCP is gated' });
    }
  }

  // 3. The test guard's mode.
  const mode = cfg.guard?.tests || 'attest';
  if (mode !== 'block') {
    add({ id: 'guard-mode', status: 'warning', what: `guard.tests is "${mode}"`, why: mode === 'attest' ? 'the author can sign off on its own test change; "block" lets only an independent pass or a maintainer accept it' : 'changed tests are not checked', fix: 'set "guard": { "tests": "block" } in .proof/config.json (a stricter policy needs no approval)' });
  } else add({ id: 'guard-mode', status: 'ok', what: 'guard.tests is "block": only an independent pass or a maintainer accepts a test change' });

  // 4. Checks CI can't run.
  const selfCalling = selfCallingRequirements(engine.rules());
  if (selfCalling.length) add({ id: 'self-calling', status: 'warning', what: `requirements run pocp itself: ${selfCalling.join(', ')}`, why: 'CI re-runs every check, and pocp is not on PATH there unless the workflow installs it', fix: 'call the underlying command directly, or install pocp in the workflow first' });

  // 5. CI workflow.
  const workflows = scanWorkflows(root);
  const wf = workflows.find((w) => w.runs_verify);
  const plan = requiredChecksPlan(root, cfg);
  // A repository pushed rather than cloned has no origin/HEAD, so git alone can't say which
  // branch is the default one. Ask GitHub before falling back to main, master or the branch
  // checked out (defaultBranch): otherwise doctor judges an adoption branch against itself.
  if (!cfg.ci?.branch && !offline && !g.git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true })
    && /github\.com[:/]/.test(g.git(root, ['remote', 'get-url', 'origin'], { allowFail: true }) || '')) {
    const r = gh(root, ['repo', 'view', '--json', 'defaultBranchRef']);
    if (r.ok && typeof r.json?.defaultBranchRef?.name === 'string' && r.json.defaultBranchRef.name) plan.branch = r.json.defaultBranchRef.name;
  }
  if (local) {
    add({ id: 'workflow', status: 'skipped', what: 'local mode (ci.mode "local"): no CI workflow expected' });
    add({ id: 'local-mode', status: 'warning', what: 'local mode: no CI', why: LOCAL_MODE_TRADE, fix: `before merging: ${localVerifyCommand(root, plan.branch)}; for CI: pocp ci on (or pocp init --github)` });
  } else if (!wf) {
    add({ id: 'workflow', status: 'problem', what: 'no CI workflow runs pocp verify', why: 'the hooks are local and can be skipped; only CI checks every pull request', fix: 'copy examples/github/pocp.yml to .github/workflows/pocp.yml' });
  } else {
    const missing = [!wf.labels.tests && APPROVE_TESTS_LABEL, !wf.labels.policy && APPROVE_POLICY_LABEL].filter(Boolean);
    add(missing.length
      ? { id: 'workflow', status: 'problem', what: `${wf.file} does not pass the ${missing.join(' / ')} label(s) to verify`, why: 'without them a maintainer has no way to approve a test or policy change, and the only way past a block is rewriting history', fix: 'wire accept-test-change / accept-policy-change to the labels as in examples/github/pocp.yml' }
      : { id: 'workflow', status: 'ok', what: `${wf.file} runs verify and reads the approval labels` });
    // The "pocp" status (docs/STATUS.md): verify reports a wait apart from a failure, and a
    // separate trusted workflow turns that into the status.
    const reporter = workflows.some((w) => w.reporter);
    if (wf.exit_detail && !reporter) add({ id: 'reporter', status: 'problem', what: `${wf.file} reports verify's result, but no workflow sets the "pocp" status`, why: 'without the reporter, nothing turns a wait or a pass into a status a branch can require', fix: 'add .github/workflows/pocp-status.yml (pocp init --github writes it)' });
    else if (!wf.exit_detail) add({ id: 'reporter', status: 'warning', what: `${wf.file} makes verify fail on every wait for approval`, why: 'each push that needs an approval shows a red ✗ and sends a failure email', fix: 'use the "pocp" status instead: pocp init --github --force writes the workflows (docs/STATUS.md)' });
    else add({ id: 'reporter', status: 'ok', what: 'a trusted reporter sets the "pocp" status' });
    // pocp.yml's approval job predicts what the reporter will decide, to skip a verify run that
    // would change nothing. Different versions could disagree: a prediction that verify needn't
    // run, from a reporter that can't then turn the wait green, leaves the status pending.
    const reporterRefs = new Set(workflows.filter((w) => w.reporter && w !== wf).flatMap((w) => w.status_refs));
    const predictRefs = wf.status_refs || [];
    if (predictRefs.length && reporterRefs.size && predictRefs.some((r) => !reporterRefs.has(r))) {
      add({ id: 'status-refs', status: 'problem', what: `${wf.file} predicts with the status action at ${predictRefs.join(', ')}, but the reporter runs ${[...reporterRefs].join(', ')}`, why: 'when they disagree, an approval can skip verify while the reporter never turns the wait green, so the status stays pending', fix: 'use the same ref in both (pocp init --github --force writes them together)' });
    }
  }
  // Workflows from before 1.3.1: approval labels taken as given, removed on push by
  // pocp-labels.yml, which runs on pull_request_target (blocked by default in public
  // repositories from 2026-12-02, so labels stay on after a push).
  if (!local) {
    const outdated = [
      ...(wf && (wf.labels.tests || wf.labels.policy) && !wf.label_freshness ? [`${wf.file} doesn't check approval labels against the head (label-freshness)`] : []),
      ...LEGACY_GITHUB_WORKFLOWS.map((f) => `.github/workflows/${f}`).filter((f) => fs.existsSync(path.join(root, f))).map((f) => `${f} runs on pull_request_target, which GitHub blocks by default in public repositories`),
    ];
    const live = plan.required_checks.includes(STATUS_CHECK);
    if (outdated.length) add({ id: 'workflows-outdated', status: live ? 'warning' : 'problem', what: outdated.join('; '), why: live ? 'an approval label left on after a push passes verify; the reporter still refuses it, so the pocp status stays yellow' : 'with verify as the required check, an approval label left on after a push lets verify pass commits nobody reviewed', fix: 'regenerate with pocp init --github --force (it also removes pocp-labels.yml), then commit .github/workflows' });
  }

  // The copies of POCP this repository uses (hooks, lockfile, workflow pins) agree: local files only.
  for (const c of versionChecks(root, { local })) add(c);

  // 6. What the adoption pull request carries.
  const scope = adoptionScope(root, base || verifyBase(root, plan.branch), cfg);
  if (!scope.known) add({ id: 'adoption-scope', status: 'skipped', what: `base ${scope.base} not found (pass --base <rev>)` });
  else if (scope.adopted) add({ id: 'adoption-scope', status: 'ok', what: `${scope.base} already has POCP` });
  else if (scope.extra.length) {
    add({ id: 'adoption-scope', status: 'problem', what: `this adoption branch also changes ${scope.extra.length} other file(s): ${scope.extra.slice(0, 6).join(', ')}${scope.extra.length > 6 ? ' …' : ''}`, why: `until POCP is on ${scope.base}, CI judges with default rules while your hooks use this branch's, so these changes get two different verdicts`, fix: 'move them to a pull request opened after the adoption merges; the adoption PR should carry only .proof/ and CI files' });
  } else {
    add({ id: 'adoption-scope', status: 'ok', what: `adoption branch carries only .proof/ and CI files (${scope.files.length})` });
    if (!local) add({ id: 'adoption-approval', status: 'warning', what: 'the adoption PR adds CI configuration and rules', why: 'verify treats both as policy changes, so it fails until approved', fix: `a maintainer adds the \`${APPROVE_POLICY_LABEL}\` label to the adoption PR` });
  }

  // 7. Required checks: configured, and the verify job among them.
  if (local) add({ id: 'required-checks', status: 'skipped', what: 'local mode: nothing blocks a merge' });
  else if (!plan.required_checks.length) {
    const live = workflows.some((w) => w.reporter);
    add({ id: 'required-checks', status: 'problem', what: 'ci.required_checks is empty', why: 'nothing makes a failed verify block a merge', fix: live
      ? 'list "pocp" (the status the reporter sets) and your test jobs in ci.required_checks in .proof/config.json; while you try it in report-only mode, list the verify job instead (docs/STATUS.md)'
      : `list the verify job (${wf?.jobs?.[0] || 'verify'}) and your test jobs in ci.required_checks in .proof/config.json` });
  }
  // The pocp status stands in for the verify job when the reporter workflow sets it (docs/STATUS.md).
  else if (wf && wf.jobs.length && !wf.jobs.some((j) => plan.required_checks.includes(j)) && !(plan.required_checks.includes('pocp') && workflows.some((w) => w.reporter))) add({ id: 'required-checks', status: 'problem', what: `ci.required_checks does not include the verify job (${wf.jobs.join(', ')})`, why: 'a pull request that deletes the POCP step would still merge', fix: `add "${wf.jobs[0]}" to ci.required_checks in .proof/config.json, then pocp ci required --apply` });
  else add({ id: 'required-checks', status: 'ok', what: `ci.required_checks: ${plan.required_checks.join(', ')}` });

  // 7b. Checks handed to CI at commit (ci.defer_heavy): sound only where a required status makes
  // CI's re-run block the merge. Local mode never hands off (the config is refused there).
  const deferred = cfg.ci?.defer_heavy === true;
  const deferredIds = deferred ? (engine.rules().requirements || []).filter((r) => r?.defer === 'ci').map((r) => r.id) : [];
  const requiredStatus = plan.required_checks.includes(STATUS_CHECK) || Boolean(wf && wf.jobs.some((j) => plan.required_checks.includes(j)));
  if (deferred && local) add({ id: 'defer-heavy', status: 'problem', what: 'ci.defer_heavy is on in local mode', why: 'in local mode the git hooks are the only gate, so no check may be handed to CI; POCP refuses this config', fix: 'remove ci.defer_heavy from .proof/config.json' });
  else if (deferred && !requiredStatus) add({ id: 'defer-heavy', status: 'problem', what: `ci.defer_heavy hands ${deferredIds.length ? deferredIds.join(', ') : 'checks'} to CI, but ci.required_checks names neither "pocp" nor the verify job`, why: 'a check handed to CI is enforced only by a required status: without one it runs nowhere that blocks a merge', fix: 'add "pocp" to ci.required_checks in .proof/config.json, then pocp ci required --apply' });
  else if (deferred) add({ id: 'defer-heavy', status: deferredIds.length ? 'ok' : 'warning', what: deferredIds.length ? `ci.defer_heavy: ${deferredIds.join(', ')} (and the test guard, in block mode) are handed to CI at commit; CI's verify --rerun runs them before merge` : 'ci.defer_heavy is on, but no rule marks a check "defer": "ci"', ...(deferredIds.length ? {} : { why: 'only the test guard (block mode) is handed to CI', fix: 'mark heavy checks in .proof/rules.json with "defer": "ci"' }) });

  // 8. GitHub: Action access, labels, branch protection.
  const remote = g.git(root, ['remote', 'get-url', 'origin'], { allowFail: true }) || '';
  if (offline || !/github\.com[:/]/.test(remote)) {
    add({ id: 'github', status: 'skipped', what: offline ? 'GitHub checks skipped (--offline)' : 'origin is not a GitHub repository; GitHub checks skipped' });
  } else {
    const repoInfo = gh(root, ['repo', 'view', '--json', 'nameWithOwner,isPrivate']);
    if (!repoInfo.ok || !repoInfo.json?.nameWithOwner) {
      add({ id: 'github', status: 'skipped', what: `could not ask GitHub (${repoInfo.missing ? 'gh is not installed' : repoInfo.message || 'gh failed'}); run "gh auth login" and try again` });
    } else {
      const repo = repoInfo.json.nameWithOwner;
      // POCP's workflows on GitHub (what pocp ci off / on switch), and whether Actions starts at all.
      const listed = listWorkflows(repo);
      if (listed.workflows) {
        const ours = [...GITHUB_WORKFLOWS, ...LEGACY_GITHUB_WORKFLOWS].map((f) => `.github/workflows/${f}`);
        const mine = listed.workflows.filter((w) => ours.includes(w.path));
        const active = mine.filter((w) => w.state === 'active').map((w) => w.path);
        const disabled = mine.filter((w) => w.state !== 'active').map((w) => w.path);
        if (local && active.length) add({ id: 'ci-mode', status: 'warning', what: `local mode, but POCP's workflows still run on ${repo}: ${active.join(', ')}`, why: 'each push spends Actions minutes on checks nothing requires', fix: 'pocp ci off' });
        else if (local && disabled.length) add({ id: 'ci-mode', status: 'ok', what: `POCP's workflows are off on ${repo}, as local mode expects` });
        else if (!local && disabled.length) add({ id: 'ci-mode', status: 'problem', what: `POCP's workflows are disabled on ${repo}: ${disabled.join(', ')}`, why: 'nothing checks pull requests, and .proof/config.json does not say local mode', fix: 'pocp ci on; or, for no CI, pocp ci off and commit .proof/config.json' });
        const blocked = actionsBlocked(root, repo, listed.workflows);
        if (blocked) {
          const others = blocked.active.filter((f) => !ours.includes(f));
          const steps = [...(blocked.active.some((f) => ours.includes(f)) ? ['pocp ci off (local mode)'] : []), ...others.map((f) => `gh workflow disable ${path.basename(f)}`)];
          add({ id: 'actions-billing', status: 'problem', what: `GitHub Actions jobs on ${repo} are not starting: ${blocked.message.split(/\.\s/)[0]}`, why: `every push starts ${blocked.active.length} workflow(s) that fail at once and email you: ${blocked.active.join(', ')}`, fix: `${steps.join(', then ')}; or fix billing in Settings → Billing and plans` });
        }
      }
      if (local) {
        add({ id: 'github', status: 'skipped', what: 'local mode: Action access, labels and branch protection not checked' });
        return { ok: !checks.some((c) => c.status === 'problem'), checks };
      }
      for (const u of (wf?.uses || []).filter((x) => x.repo.toLowerCase() !== repo.toLowerCase())) {
        const a = gh(root, ['api', `repos/${u.repo}`]);
        if (!a.ok) {
          add({ id: 'action-access', status: 'problem', what: `${wf.file} uses ${u.repo}@${u.ref}, which this account cannot see`, why: 'the job fails at "Set up job" with "repository not found"', fix: `check the name, or ask the owner of ${u.repo} for access` });
          continue;
        }
        if (!a.json?.private) {
          add({ id: 'action-access', status: 'ok', what: `${u.repo} is public, so any workflow can use it` });
          continue;
        }
        const acc = gh(root, ['api', `repos/${u.repo}/actions/permissions/access`]);
        const level = acc.json?.access_level;
        if (!acc.ok) add({ id: 'action-access', status: 'warning', what: `${u.repo} is private and its Actions access could not be read (${acc.message})`, why: 'other repositories can only use a private action when its owner allows it', fix: `the owner runs: gh api -X PUT repos/${u.repo}/actions/permissions/access -f access_level=user` });
        else if (level === 'none') add({ id: 'action-access', status: 'problem', what: `${u.repo} is private and does not share its Actions (access_level "none")`, why: `every ${repo} workflow that uses it fails at "Set up job" with "repository not found"`, fix: `gh api -X PUT repos/${u.repo}/actions/permissions/access -f access_level=${u.repo.split('/')[0] === repo.split('/')[0] ? 'user' : 'organization'}` });
        else add({ id: 'action-access', status: 'ok', what: `${u.repo} is private and shares its Actions (access_level "${level}")` });
      }

      const labels = gh(root, ['api', `repos/${repo}/labels?per_page=100`]);
      if (labels.ok && Array.isArray(labels.json)) {
        const have = new Set(labels.json.map((l) => l.name));
        // The two core labels, plus any other approval label the workflows use.
        const wanted = [...new Set([APPROVE_TESTS_LABEL, APPROVE_POLICY_LABEL, ...workflows.flatMap((w) => w.mentions || [])])];
        const missing = wanted.filter((l) => !have.has(l));
        add(missing.length
          ? { id: 'labels', status: 'problem', what: `label(s) missing on ${repo}: ${missing.join(', ')}`, why: 'a maintainer approves a change by adding its label', fix: missing.map((l) => `gh label create ${l} --repo ${repo} --description "POCP: a maintainer approves ${APPROVAL_LABELS[l]}"`).join(' && ') }
          : { id: 'labels', status: 'ok', what: `approval labels exist on ${repo}` });
      } else add({ id: 'labels', status: 'skipped', what: `could not list labels (${labels.message})` });

      const prot = gh(root, ['api', `repos/${repo}/branches/${plan.branch}/protection`]);
      // ci.defer_heavy: GitHub must actually require the status, or a handed-off check enforces nothing.
      if (deferred) {
        const contexts = new Set([...(prot.json?.required_status_checks?.contexts || []), ...(prot.json?.required_status_checks?.checks || []).map((c) => c.context)]);
        const enforced = prot.ok && prot.json && (contexts.has(STATUS_CHECK) || Boolean(wf && wf.jobs.some((j) => contexts.has(j))));
        if (!enforced) add({ id: 'defer-heavy-protection', status: prot.ok || /not protected/i.test(prot.message || '') ? 'problem' : 'warning', what: `${repo}@${plan.branch} does not require the "${STATUS_CHECK}" status${prot.ok || /not protected/i.test(prot.message || '') ? '' : ` (could not read branch protection: ${prot.message})`}`, why: 'ci.defer_heavy hands checks to CI at commit; without a required status, a pull request whose handed-off checks fail can still merge', fix: 'pocp ci required --apply' });
      }
      if (prot.ok && prot.json) {
        // Everything the plan asks of the branch, as `pocp ci required --check` reports it:
        // required checks, pull requests only, admins included, branches up to date.
        const gaps = protectionGaps(prot.json, plan);
        add(gaps.length
          ? { id: 'branch-protection', status: 'problem', what: `${repo}@${plan.branch}: ${gaps.join('; ')}`, why: 'POCP can only block a merge GitHub enforces: each gap is a way for unverified code to merge', fix: 'pocp ci required --apply' }
          : { id: 'branch-protection', status: 'ok', what: `${repo}@${plan.branch} enforces the plan: ${plan.required_checks.join(', ')} required, pull requests only, admins included${plan.require_up_to_date ? ', branches up to date' : ''}` });
        const identity = reporterIdentityNote(prot.json, plan);
        if (identity) add({ id: 'reporter-identity', status: 'warning', what: identity.split('. Optional:')[0], why: 'optional hardening for repositories where branches are pushed with a maintainer\'s token (agents, for example)', fix: 'docs/STATUS.md, "Give the reporter its own identity" (needs a public repository or GitHub Pro or Team)' });
        if (!plan.require_up_to_date) add({ id: 'up-to-date', status: 'warning', what: 'ci.require_up_to_date is false', why: 'a pull request can merge without the latest base, so the merged code is not the code that was verified', fix: 'remove ci.require_up_to_date from .proof/config.json (or set it to true), then pocp ci required --apply' });
      } else if (/upgrade to github pro|make this repository public/i.test(prot.message || '')) {
        add({ id: 'branch-protection', status: 'warning', what: `${repo} is private on a free plan, which has no branch protection`, why: 'verify still runs and reports, but GitHub will not block a merge on it: POCP is advisory here, and anyone with write access can merge unverified code', fix: 'make the repository public, or move it to a plan with branch protection (GitHub Pro, Team or Enterprise); or, if CI isn\'t worth its Actions minutes here, use local mode: pocp ci off' });
      } else if (/not protected/i.test(prot.message || '')) {
        add({ id: 'branch-protection', status: 'problem', what: `${repo}@${plan.branch} is not protected`, why: 'a failing verify would not block the merge', fix: 'pocp ci required --apply' });
      } else add({ id: 'branch-protection', status: 'skipped', what: `could not read branch protection (${prot.message})` });
    }
  }
  return { ok: !checks.some((c) => c.status === 'problem'), checks };
}

export function formatDoctor(r) {
  const mark = { ok: 'ok  ', problem: 'FIX ', warning: 'note', skipped: 'skip' };
  const lines = [r.ok ? 'pocp doctor: no problems found' : `pocp doctor: ${r.checks.filter((c) => c.status === 'problem').length} problem(s)`];
  for (const c of r.checks) {
    lines.push(`  ${mark[c.status]} ${c.what}`);
    if (c.status !== 'ok' && c.why) lines.push(`         why: ${c.why}`);
    if (c.status !== 'ok' && c.fix) lines.push(`         fix: ${c.fix}`);
  }
  return lines.join('\n');
}
