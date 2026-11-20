// pocp verify: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { COOPERATIVE } from '../runner.js';
import { dontRewrite, pullRequestRef, verifyRemedy, whoOf } from '../remedies.js';
import { EXIT } from '../errors.js';
import { VERIFY_EXIT } from '../approvals.js';
import { createRevCheckout } from '../workspace.js';
import { decideVerify } from '../decision.js';
import { errWrite, evidenceSummary, list, out, writeGithubSummary } from '../cli/shared.js';
import { failedOutputLines } from '../output-tail.js';
import { git, resolveRev, showFile } from '../git.js';
import { approvalLines, approvalPlan, APPROVE_WORKFLOW_LABEL, explainWorkflow, sortLabels } from '../explain.js';
import { withDefaults } from '../store.js';
import { changedWorkflowFiles, FAST_PATH_LABELS, githubClient, workflowFiles } from '../status-report.js';
import { readCiResults } from '../ci-results.js';
import { shortDigest } from '../hash.js';
import { UsageError } from '../cli-args.js';
import { freshnessFacts, labelFreshness } from '../label-freshness.js';
import { compareWithApproved, heldTestFiles, recordLines } from '../sticky-approval.js';

// Which label gives each approval (examples/github/pocp.yml).
const APPROVAL_LABELS = Object.freeze({
  'accept-test-change': 'pocp-approve-tests',
  'accept-policy-change': 'pocp-approve-policy',
  'accept-inconclusive': 'pocp-approve-inconclusive',
  'accept-uncovered': 'pocp-approve-coverage',
});
// Labels a wait may need and still be `approvable`: pocp-approve-tests (status-report.js,
// FAST_PATH_LABELS), and the workflow label the reporter checks itself. A policy or inconclusive
// approval is decided by a new run, so a wait for one is never approvable.
const APPROVABLE_LABELS = new Set([...FAST_PATH_LABELS, APPROVE_WORKFLOW_LABEL]);

/**
 * Whether verify may tell the workflow its wait is for approvals only (`approvable`): nothing
 * else blocks, every label is one the workflow lists, and the checks ran isolated, so no check
 * could have written the step's outputs.
 */
/** The labels verify writes to --approval-file for this result, or null for none. */
export function approvalFileLabels({ result, flags, secure, waitingOnly }) {
  // --ci-results trusts what ran before verify in the job (the pull request's tests could have
  // written it), so a wait that rests on it is never approvable.
  const ok = approvableWait({ waitingOnly, outcome: result.approval?.outcome, secure, labels: result.labels_needed, trusting: [].concat(flags['ci-results'] ?? []).length > 0 });
  return ok ? result.labels_needed : null;
}

export function approvableWait({ waitingOnly, outcome, secure, labels, trusting = false }) {
  return Boolean(waitingOnly) && outcome === 'waiting' && secure === true && !trusting
    && Array.isArray(labels) && labels.some((l) => FAST_PATH_LABELS.has(l)) && labels.every((l) => APPROVABLE_LABELS.has(l));
}

/**
 * --label-freshness=github: whether each approval's label counts for this head, by the rule the
 * reporter uses (src/label-freshness.js), from GitHub's API. { label: verdict } for the
 * approvals given. One GitHub can't settle is refused, never assumed.
 */
async function labelVerdicts(engine, flags, headRev, token, compared = {}) {
  if (flags['label-freshness'] !== 'github') throw new UsageError(`--label-freshness takes "github", not "${flags['label-freshness']}"`);
  if (!token) throw new UsageError("--label-freshness=github needs a token in POCP_GITHUB_TOKEN (the action's github-token input)");
  const repository = flags.repo || process.env.GITHUB_REPOSITORY;
  const prNumber = Number(flags['pull-request']) || null;
  if (!repository || !prNumber) throw new UsageError('--label-freshness=github needs --repo <owner/name> (or GITHUB_REPOSITORY) and --pull-request <n>');
  const given = (name) => [].concat(flags[name] ?? false).some((v) => v && v !== 'false');
  const labels = Object.entries(APPROVAL_LABELS).filter(([name]) => given(name)).map(([, label]) => label);
  const verdicts = {};
  if (!labels.length) return verdicts;
  const sha = resolveRev(engine.root, headRev);
  try {
    const facts = await freshnessFacts(githubClient({ token, api: process.env.GITHUB_API_URL || undefined }), { repository, prNumber, sha, labels });
    // A sticky label given for an earlier head: is this head exactly that head plus base content?
    // Decided here, with git, before any of the pull request's code runs; recorded for the
    // reporter (--record-file). verify itself applies only pocp-approve-policy this way: which
    // test changes it holds is known after the checks, so the reporter decides the test label.
    const range = /\.\./.test(rest0(flags)) ? rest0(flags).split(/\.\.\.?/)[0] : null;
    facts.records_now = { any: true, held: {}, approvals: {} };
    for (const [label, s] of Object.entries(facts.sticky || {})) {
      if (!s.complete || !s.head || !range) continue;
      let c;
      try {
        c = compareWithApproved(engine.root, { approved: s.head, head: sha, base: resolveRev(engine.root, range), approvedBase: s.base, baseConfig: baseConfigAt(engine.root, range) });
      } catch (e) {
        // Only this label's comparison is lost: every other label is judged as before.
        c = { verdict: null, files: [], why: e.message };
      }
      if (!c.verdict) {
        errWrite(`pocp: ${label}: couldn't compare this head with ${s.head.slice(0, 12)}, the head it was given for: ${c.why}\n`);
        continue;
      }
      compared[label] = { verdict: c.verdict, head: s.head };
      facts.records_now.approvals[label] = compared[label];
      if (c.verdict === 'same') errWrite(`pocp: ${label} was given for ${s.head.slice(0, 12)}; this head is that head plus base content only\n`);
      else errWrite(`pocp: ${label} was given for ${s.head.slice(0, 12)}, and ${c.why}${c.files.length ? ` (${c.files.slice(0, 5).join(', ')}${c.files.length > 5 ? ', ...' : ''})` : ''}\n`);
    }
    // Only a label verify compared is judged by the sticky rule here; any other, as before.
    facts.records_now.any = Object.keys(facts.records_now.approvals).length > 0;
    for (const label of labels) verdicts[label] = labelFreshness(facts, label, sha);
  } catch (e) {
    for (const label of labels) verdicts[label] = { ok: false, stale: false, why: `couldn't check ${label} against GitHub (${e.message}): re-run this job` };
  }
  return verdicts;
}

/** The range given to verify (its first argument), or ''. */
const rest0 = (flags) => String(flags._range || '');

/** The base's .proof/config.json, with defaults, or null when it has none or it can't be read. */
function baseConfigAt(root, rev) {
  try {
    const text = showFile(root, rev, '.proof/config.json');
    return text === null ? null : withDefaults(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The CI files a range changes that the trusted reporter (pocp-status.yml) holds for
 * pocp-approve-workflow, by the reporter's own rule (status-report.js): the base's ci.files and
 * ci.files_except, CI definitions always included, over the pull request's diff from its merge
 * base. Empty in local mode, outside a range, or when the base runs no reporter.
 */
export function workflowLabelFiles(root, range, cfg) {
  if (cfg.ci?.mode === 'local' || !range || !range.includes('..')) return [];
  const [b, h] = range.split(/\.\.\.?/);
  const base = git(root, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`], { allowFail: true });
  const head = git(root, ['rev-parse', '--verify', '--quiet', `${h || 'HEAD'}^{commit}`], { allowFail: true });
  if (!base || !head) return [];
  if (!git(root, ['grep', '-l', '-F', 'status-report', base, '--', '.github/workflows'], { allowFail: true })) return [];
  let baseConfig = null;
  try {
    const text = showFile(root, base, '.proof/config.json');
    baseConfig = text === null ? null : withDefaults(JSON.parse(text));
  } catch { /* an unreadable base config: the defaults still apply */ }
  const mb = git(root, ['merge-base', base, head], { allowFail: true }) || base;
  const files = (git(root, ['diff', '--name-only', '--no-renames', '-z', mb, head], { trim: false, allowFail: true }) || '').split('\0').filter(Boolean);
  return changedWorkflowFiles(files.map((filename) => ({ filename })), workflowFiles(baseConfig), baseConfig?.ci?.files_except || []);
}

/** verify's first line: a result that waits only for labels says so, so it doesn't read as a failure. */
const headline = (result) => (result.ok ? 'verified' : decideVerify(result)?.only ? 'NOT verified yet: waiting for a maintainer\'s approval' : 'NOT verified');

/** The labels on the pull request when this run's event fired (GitHub's event payload), or []. */
function eventLabels() {
  try {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    return (ev.pull_request?.labels || []).map((l) => l.name);
  } catch {
    return [];
  }
}

/** The pull request verify is checking: { number, repository }, from flags or GitHub's environment. */
function pullRequestOf(flags) {
  const ref = pullRequestRef();
  const number = Number(flags['pull-request']) || Number(ref?.split('#')[1]) || null;
  const repository = flags.repo || process.env.GITHUB_REPOSITORY || null;
  return { number, repository };
}

export async function run({ engine, flags, isolated, json, rest }) {
  const started = Date.now();
  // The token for --label-freshness: read, then taken out of this process's environment before
  // anything else runs, so no check (cooperative or isolated) or install inherits it.
  const ghToken = process.env.POCP_GITHUB_TOKEN || '';
  delete process.env.POCP_GITHUB_TOKEN;
  const headRev = rest[0] && rest[0].includes('..') ? rest[0].split(/\.\.\.?/)[1] || 'HEAD' : rest[0] || 'HEAD';
  // Sticky approvals this run compared with the head they were given for (labelVerdicts).
  const compared = {};
  const verdicts = flags['label-freshness'] ? await labelVerdicts(engine, { ...flags, _range: rest[0] || '' }, headRev, ghToken, compared) : null;
  // Before any of the pull request's code runs: set up and probe the isolation. If it
  // can't be set up, this throws and verify fails; it never falls back.
  const isolation = isolated ? isolated.isolation : COOPERATIVE;
  if (isolated) {
    await isolated.prepare({ root: engine.root });
    if (flags.install) {
      const cfg = engine.config();
      const co = createRevCheckout(engine.root, resolveRev(engine.root, headRev), { links: [] });
      try {
        const logFile = engine.store.kind === 'fs' ? path.join(engine.store.runsDir(), 'install.log') : null;
        const r = await isolated.installDeps(flags.install, { dir: co.dir, links: cfg.snapshot.link, timeoutMs: cfg.run.timeout_ms, killGraceMs: cfg.run.kill_grace_ms, logFile, logCapBytes: cfg.run.log_cap_bytes, envAllow: cfg.run.env_allow || [] });
        errWrite(`pocp: installed dependencies isolated (${flags.install}): ${r.installed.join(', ') || 'no dependency folders'}\n`);
      } finally {
        co.cleanup();
      }
    } else if ((engine.config().snapshot.link || []).some((l) => fs.existsSync(path.join(engine.root, l)))) {
      errWrite('pocp: note: isolated checks can\'t read this checkout, so dependency folders installed in it aren\'t visible to them; install with verify --install <cmd>\n');
    }
  }
  let ignoredCi = 0;
  const ciResults = list(flags['ci-results']).flatMap((file) => {
    const r = readCiResults(file, { root: engine.root });
    ignoredCi += r.ignored;
    return r.records;
  });
  if (ignoredCi) errWrite(`pocp: ignored ${ignoredCi} CI result(s) recorded by a different CI run\n`);
  if (ciResults.length) errWrite('pocp: trusting CI results from --ci-results: anything that ran earlier in this job could have written them (docs/THREAT-MODEL.md)\n');
  // An approval that names a commit covers only that head: a later push needs a new one. With
  // --label-freshness, its label must also count for this head (labelVerdicts).
  const approval = (name) => {
    const ok = approvalFor(name);
    const verdict = verdicts?.[APPROVAL_LABELS[name]];
    if (!ok || !verdict || verdict.ok) return ok;
    errWrite(`pocp: ${APPROVAL_LABELS[name]} not applied: ${verdict.why}\n`);
    return false;
  };
  const approvalFor = (name) => {
    const v = [].concat(flags[name] ?? false).pop();
    if (typeof v !== 'string') return Boolean(v);
    const head = resolveRev(engine.root, headRev);
    const given = /^[0-9a-f]{7,64}$/i.test(v) ? git(engine.root, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`], { allowFail: true }) : null;
    if (given === head) return true;
    errWrite(`pocp: approval for ${v} does not cover ${head.slice(0, 12)}, the head being verified: a push after the approval needs a new one (--${name})\n`);
    return false;
  };
  const vopts = {
    rerun: flags['rerun-unsigned'] ? 'unsigned' : Boolean(flags.rerun),
    requireCoverage: Boolean(flags['require-coverage']),
    ciResults,
    policyFrom: flags['policy-from'],
    acceptPolicyChange: approval('accept-policy-change'),
    acceptTestChange: approval('accept-test-change'),
    acceptInconclusive: approval('accept-inconclusive'),
    acceptUncovered: approval('accept-uncovered'),
    allowedSignersFile: flags['allowed-signers'],
    jobs: flags.jobs,
  };
  const rerunLines = (reruns) => reruns.map((x) => `  rerun ${x.status.padEnd(8)} ${x.run}${x.duration_ms !== undefined ? ` (${x.duration_ms}ms)` : ''}${x.kind === 'guard' && x.summary ? `: ${x.summary}` : ''}`);
  // What to do, who acts first: { by, code, why, next } per blocking finding code.
  const nextSteps = (rows2) => {
    const seen = new Map();
    const local = engine.config().ci?.mode === 'local';
    const add = (code, x) => seen.set(code, { by: x.by, ...(x.who ? { who: x.who } : {}), code, why: x.why, next: x.next });
    for (const c of rows2) for (const f of (c.findings || []).filter((x) => x.blocking)) if (!seen.has(f.code)) add(f.code, verifyRemedy(f.code, f.detail, f, { local }));
    // A re-run that ran and failed outranks one that only timed out, for what to do next.
    const reruns = (result?.rerun_failures || []).filter((x) => x.blocking !== false);
    const worst = reruns.find((x) => !x.unfinished) || reruns[0];
    if (worst && !seen.has('rerun_failed')) add('rerun_failed', verifyRemedy('rerun_failed', worst.detail || worst.problem, worst, { local }));
    return [...seen.values()];
  };
  const stepLines = (list2) => {
    if (!list2.length) return [];
    const out2 = ['  what to do:', ...list2.map((x) => `    [${whoOf(x)}] ${x.code}: ${x.why ? `${x.why} ` : ''}next: ${x.next}`)];
    if (list2.some((x) => x.by === 'person')) out2.push(`    ${dontRewrite(list2)}`);
    return out2;
  };
  let steps = [];
  // A range's own findings, apart from re-run failures (rerun_failures lists those).
  const rangeFindings = (r) => (r.findings && r.commits ? r.findings.filter((f) => f.code !== 'rerun_failed') : []);
  const commitProblems = (c) => [
    // Commit-level findings (policy, CI files, test guard, required CI); coverage is listed below.
    ...(c.findings || []).filter((f) => f.blocking && !f.packet && f.code !== 'uncovered').map((f) => f.detail),
    ...c.packets.filter((p) => !p.ok).map((p) => `${p.id}: ${p.problems.join('; ')}`),
    ...(c.coverage?.uncovered.length ? [`not covered: ${c.coverage.uncovered.join(', ')}`] : []),
  ];
  // How the checks verify ran were run: isolated, or the cooperative runner, which is not
  // the hosted secure profile. Shown whenever a check ran.
  const isolationLine = (reruns) => (isolated || reruns.some((x) => x.duration_ms !== undefined && !x.reused) ? [`  checks: ${isolation.mode}: ${isolation.detail}`] : []);
  let result;
  let human;
  let rows;
  if (rest[0] && rest[0].includes('..')) {
    result = await engine.verifyRange(rest[0], vopts);
    // The range's net change (all commits and merges as one change) is judged like a commit.
    rows = [...result.commits, ...(result.net ? [result.net] : [])];
    if (!result.ok) steps = nextSteps([...rows, { findings: rangeFindings(result) }]);
    human = [
      `${headline(result)}: ${result.commits.length} commit(s) in ${result.range} · ${Date.now() - started}ms`,
      ...result.commits.map((c) => `  ${c.ok ? 'ok ' : 'BAD'} ${c.commit.slice(0, 12)}${c.ok ? '' : `: ${commitProblems(c).join(' | ')}`}`),
      ...(result.net ? [`  ${result.net.ok ? 'ok ' : 'BAD'} net change ${result.net.base.slice(0, 12)}..${result.net.commit.slice(0, 12)}${result.net.ok ? '' : `: ${commitProblems(result.net).join(' | ')}`}`] : []),
      ...(result.notes || []).map((n) => `  note: ${n}`),
      ...isolationLine([...result.reruns, ...(result.net?.reruns || [])]),
      ...rerunLines([...result.reruns, ...(result.net?.reruns || [])]),
      ...stepLines(steps),
      ...failedOutputLines([...result.reruns, ...(result.net?.reruns || [])]),
    ].join('\n');
  } else {
    result = await engine.verify(rest[0] || 'HEAD', vopts);
    rows = [result];
    if (!result.ok) steps = nextSteps([result]);
    human = [
      `${headline(result)}: ${result.commit.slice(0, 12)} subject ${shortDigest(result.subject)} · ${Date.now() - started}ms`,
      ...result.notes.map((n) => `  note: ${n}`),
      ...result.warnings.map((w) => `  warning: ${w}`),
      ...result.packets.map((p) => `  ${p.id}: ${p.ok ? 'ok' : p.problems.join('; ')}${p.evidence && Object.keys(p.evidence).length ? ` · evidence: ${evidenceSummary(p.evidence)}` : ''}`),
      ...(result.coverage?.uncovered.length ? [`  not covered: ${result.coverage.uncovered.join(', ')}`] : []),
      ...isolationLine(result.reruns),
      ...rerunLines(result.reruns),
      ...stepLines(steps),
      ...failedOutputLines(result.reruns),
    ].join('\n');
  }
  result.isolation = { mode: isolation.mode, secure: isolation.secure };
  if (verdicts) result.label_freshness = Object.fromEntries(Object.entries(verdicts).map(([l, v]) => [l, v.ok ? { ok: true, how: v.how } : v]));
  // One decision for the library and the CLI, from typed findings (src/decision.js).
  if (!result.ok) result.approval = decideVerify(result);
  // What a maintainer approves, in plain words, and the one command that adds every label
  // (explain.js). Words only: the decision above is already made.
  const local = engine.config().ci?.mode === 'local';
  const wfFiles = workflowLabelFiles(engine.root, rest[0], engine.config());
  const waitingOnly = !result.ok && result.approval?.only;
  const wfNeed = wfFiles.length && (result.ok || waitingOnly) && !eventLabels().includes(APPROVE_WORKFLOW_LABEL) ? [{ label: APPROVE_WORKFLOW_LABEL, files: wfFiles, plain: [explainWorkflow(wfFiles)] }] : [];
  if (wfNeed.length) result.workflow_approval = { label: APPROVE_WORKFLOW_LABEL, files: wfFiles };
  const pr = pullRequestOf(flags);
  const plan = local ? null : approvalPlan(waitingOnly ? result.approval.needs : [], { extra: wfNeed, number: pr.number, repository: pr.repository });
  const block = approvalLines(plan, '    ');
  if (plan) result.approval_request = plan;
  if (block.length) human += `\n  ${result.ok ? 'the pocp status also waits for a maintainer (CI files changed):' : "waiting only for a maintainer's approval; nothing else is wrong:"}\n${block.join('\n')}`;
  const labelsNeeded = sortLabels([...(waitingOnly ? result.approval.needs.map((n) => n.label) : []), ...wfNeed.map((n) => n.label)]);
  if (labelsNeeded.length && !local) result.labels_needed = labelsNeeded;
  // For the pending text (needs-* steps in pocp.yml): the labels verify waits for. Text only: a
  // step's outputs can also be set by a line printed during the step.
  if (process.env.GITHUB_OUTPUT && result.labels_needed) {
    try {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `needs=${result.labels_needed.join(',')}\n`);
    } catch { /* the pending text falls back to the generic wait */ }
  }
  // --approval-file: when the wait is for these approvals only, the list is complete and the
  // checks ran isolated, write the labels to this file (the workflow's private temp folder, which
  // isolated checks can't reach). A later step that prints nothing of the pull request's reads
  // it, so the labels that turn the wait green come from verify alone (status-report.js,
  // APPROVABLE_STEP). Otherwise the file is removed.
  // Any error here leaves no file: the wait is then judged as before, never failed for it.
  if (flags['approval-file']) {
    const file = flags['approval-file'];
    try {
      fs.rmSync(file, { force: true });
      const labels = approvalFileLabels({ result, flags, secure: isolation.secure, waitingOnly });
      if (labels) fs.writeFileSync(file, `${labels.join(',')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      try { fs.rmSync(file, { force: true }); } catch { /* the mark step finds no valid file */ }
      errWrite(`pocp: couldn't write the approval file (${err.message}); an approval will re-run verify\n`);
    }
  }
  // --record-file: what an approval given for this head binds to (sticky-approval.js): the set
  // of files held as test changes, and how this head compares with the head each sticky label was
  // given for. Like --approval-file, only from isolated checks (which can't reach the file);
  // otherwise it is removed. Any error leaves no file, and the label is judged as before.
  if (flags['record-file']) {
    const file = flags['record-file'];
    try {
      fs.rmSync(file, { force: true });
      if (isolation.secure === true && ![].concat(flags['ci-results'] ?? []).length) {
        fs.writeFileSync(file, `${recordLines({ heldTests: heldTestFiles(result), approvals: compared }).join('\n')}\n`, { mode: 0o600, flag: 'wx' });
      }
    } catch (err) {
      try { fs.rmSync(file, { force: true }); } catch { /* the records step finds no file */ }
      errWrite(`pocp: couldn't write the record file (${err.message}); approvals given for this head won't carry over to a base update\n`);
    }
  }
  if (steps.length) result.next_steps = steps;
  writeGithubSummary(result, rows, commitProblems, Date.now() - started, { annotations: !json, approvalPlan: plan });
  out(json, result, human);
  if (result.ok) return EXIT.ok;
  // --exit-detail: 4 when only a maintainer's approval is missing, 5 when something didn't
  // finish (re-run, or approve with --accept-inconclusive); every other failure stays 1.
  if (flags['exit-detail'] && result.approval?.outcome in VERIFY_EXIT) return VERIFY_EXIT[result.approval.outcome];
  return EXIT.blocked;
}
