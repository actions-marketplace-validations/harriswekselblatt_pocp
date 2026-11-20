// Every block explains itself: what is wrong, why it matters, and the exact next step.
// A remedy is { code, what, why, next, by } where `by` says who can take the step, and is
// printed first (WHO):
//   "pocp fix"  mechanical; `pocp fix` does it
//   "agent"     the author changes code or files, then runs `pocp fix` again
//   "person"    only a person can approve it (never the agent that made the change)
//   "rerun"     nothing is known yet: run it again (a check didn't finish)
//   "infra"     the machine that runs verify lacks something; no code change helps

import { factsOf } from './finding.js';
import { holdExplanation, holdReason } from './hold.js';

export const APPROVE_TESTS_LABEL = 'pocp-approve-tests';
export const APPROVE_POLICY_LABEL = 'pocp-approve-policy';
export const APPROVE_INCONCLUSIVE_LABEL = 'pocp-approve-inconclusive';

/** Said with every block that needs a person. Rewriting history never clears an approval. */
/** Who takes a step, as printed before it. */
export const WHO = { 'pocp fix': 'author: pocp fix', agent: 'author', person: 'maintainer, not the author', rerun: 're-run', infra: 'infra' };

/** The pull request CI is verifying, as owner/repo#N, or null outside a pull request. */
export function pullRequestRef(env = process.env) {
  const n = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF || '')?.[1];
  return n && env.GITHUB_REPOSITORY ? `${env.GITHUB_REPOSITORY}#${n}` : null;
}

/** A label only a maintainer adds: names the pull request and `pocp approve` (docs/STATUS.md). */
const labelStep = (label, pr = pullRequestRef()) => `adds the \`${label}\` label to ${pr || 'the pull request'} (or runs: pocp approve ${pr || 'owner/repo#<number>'})`;

// Local mode (ci.mode "local", docs/QUICKSTART.md): no CI and no labels. The approval is the
// matching flag on verify before a merge, given by you, so a person step says so (`who`).
const ACCEPT_FLAG = { [APPROVE_TESTS_LABEL]: 'accept-test-change', [APPROVE_POLICY_LABEL]: 'accept-policy-change', [APPROVE_INCONCLUSIVE_LABEL]: 'accept-inconclusive' };
export const LOCAL_WHO = 'you, before merging (local mode)';
const localStep = (label) => `in local mode you approve it before merging, after reading it: pocp verify --require-coverage --rerun <base>..HEAD --${ACCEPT_FLAG[label]} <head sha>`;

/** The step that approves `label`: a maintainer adds it (CI), or, in local mode, you pass verify's flag. `how` reads "a maintainer <how>adds…". */
export function approvalStep(label, { local = false, how = '' } = {}) {
  return local ? localStep(label) : `a maintainer ${how}${labelStep(label)}`;
}

/** Who takes a step, as printed: local-mode approvals say you, everything else WHO[by]. */
export const whoOf = (x) => x.who || WHO[x.by] || x.by;

export const DONT_REWRITE = 'Do not squash, force-push, rewrite history or commit with --no-verify to get past this: push the commit as it is and ask for the approval.';
/** The same in local mode, where nothing is pushed for approval: you approve before merging. */
export const DONT_REWRITE_LOCAL = 'Do not squash, rewrite history or commit with --no-verify to get past this: keep the commit as it is and approve it before merging.';
/** DONT_REWRITE for a list of steps: the local wording when a step is yours (local mode). */
export const dontRewrite = (steps) => (steps.some((x) => x.who === LOCAL_WHO) ? DONT_REWRITE_LOCAL : DONT_REWRITE);

/**
 * A check that didn't finish (timed out, killed, didn't start, exit 126/127) says nothing
 * about the code. Telling an agent to "fix the code" for it would have it rewrite working code
 * because the machine was busy.
 */
export const UNFINISHED_PROOF = Object.freeze({
  why: "the check didn't finish (it timed out, was killed or didn't start), so nothing is known about the code yet; this is not a test failure.",
  next: 're-run it (pocp fix runs it again); if it still can\'t finish, fix the hang or raise the check\'s timeout_ms. Do not change the code because of it.',
  by: 'agent',
});

/** Does a rerun failure's text say it didn't finish? (For callers that only have the text.) */
const UNFINISHED_TEXT = /didn't finish|timed out|killed by SIG|could not start|exit 12[67]\b/;

const list = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

/** Why a set of files needs a packet, in the gate's own words. */
function whyPacket(reasons, files) {
  const hit = reasons.filter((r) => (r.files || []).some((f) => files.includes(f)));
  const parts = hit.map((r) => {
    if (r.code === 'requirement') return 'a rule requires checks for them';
    if (r.code === 'glob') return 'they match protected paths';
    if (r.code === 'broad') return r.detail;
    if (r.code === 'cross_area') return r.detail;
    if (r.code === 'policy_change') return 'they are POCP policy, which decides what every later change must prove';
    if (r.code === 'ci_config') return 'CI configuration can switch verification off';
    if (r.code === 'test_change') return 'existing tests or test setup changed, which can hide a bug instead of fixing it';
    return r.detail;
  });
  return parts.length ? `${[...new Set(parts)].join('; ')}.` : 'the rules in .proof/rules.json say these files need proof.';
}

/** Remedies for a gate result (engine.gate), in the order to take them. */
export function gateRemedies(r) {
  if (r.decision === 'pass') return [];
  const out = [];
  if (r.decision === 'error') {
    for (const p of r.problems) {
      out.push({ code: p.code, what: p.detail, why: 'POCP cannot judge any change while its rules or config are invalid.', next: 'edit .proof/rules.json or .proof/config.json until "pocp rules check" passes', by: 'agent' });
    }
    return out;
  }
  for (const p of r.problems.filter((x) => x.code === 'prove_failed')) {
    const clean = factsOf(p).errorCode === 'clean_mode_refused';
    out.push({
      code: p.code,
      what: p.detail,
      why: clean ? 'clean mode proves the working folder, so it must match what is staged.' : 'the checks could not run.',
      next: clean ? 'pocp fix (proves a snapshot of exactly what is staged)' : 'pocp fix',
      by: clean ? 'pocp fix' : 'agent',
    });
  }
  if (r.unpacketed?.length) {
    out.push({
      code: 'no_packet',
      what: `${r.unpacketed.length} staged file(s) are not covered by any packet: ${list(r.unpacketed)}`,
      why: `${whyPacket(r.reasons, r.unpacketed)} A packet records what the change is and the checks that prove it.`,
      next: 'pocp fix --intent "<what this change does>"',
      by: 'pocp fix',
    });
  }
  for (const p of r.packets || []) {
    const ev = p.evaluation;
    if (ev.ok && p.packet_file_staged !== false) continue;
    if (ev.ok) {
      out.push({ code: 'packet_not_staged', what: `${p.id} is proven but its file is not staged`, why: 'the proofs travel inside the commit, so CI can check them.', next: `pocp fix (or git add .proof/packets/${p.id}.json)`, by: 'pocp fix' });
      continue;
    }
    if (ev.missing_required.length) {
      out.push({ code: 'missing_required', what: `${p.id} lacks checks the rules now require: ${ev.missing_required.map((m) => m.id).join(', ')}`, why: 'the rules changed after the packet was opened.', next: `pocp fix (or pocp sync ${p.id})`, by: 'pocp fix' });
    }
    const unfinished = ev.unfinished || [];
    const failed = ev.failed.filter((id) => !unfinished.includes(id));
    if (unfinished.length) out.push({ code: 'unfinished_proof', ...UNFINISHED_PROOF, what: `${p.id}: ${unfinished.join(', ')} didn't finish on this code (timed out, killed or didn't start)` });
    if (failed.length) {
      out.push({
        code: 'failed_proof',
        what: `${p.id}: ${failed.join(', ')} failed on this exact code`,
        why: 'a required check fails, so the change would break what it protects.',
        next: 'fix the code (not the tests), stage it, then pocp fix. The log path is in "pocp show" or the prove output.',
        by: 'agent',
      });
    }
    if (ev.unproven.length) {
      out.push({ code: 'unproven', what: `${p.id}: no proof yet for this code (${ev.unproven.join(', ')})`, why: 'proofs are tied to the exact staged code; anything staged since the last prove needs a new one.', next: `pocp fix (or pocp prove ${p.id})`, by: 'pocp fix' });
    }
    const guardIds = new Set((ev.guard || []).map((x) => x.id));
    for (const g of (ev.guard || []).filter((x) => ev.unattested.includes(x.id))) {
      const block = r.guard_mode === 'block';
      out.push({
        code: 'test_change',
        what: `${p.id}: the test-change check did not pass: ${g.detail || g.status}`,
        why: 'existing tests changed and POCP could not show they still catch what they caught before; changed tests can hide a bug instead of fixing it.',
        next: block
          ? (r.local_mode ? `pocp fix (lets the commit go ahead; ${laterApproval(r, APPROVE_TESTS_LABEL)})` : `pocp fix (hands it to CI, where a maintainer approves it with the \`${APPROVE_TESTS_LABEL}\` label; the author can't sign off on its own test change)`)
          : `a person who reviewed the test change runs: pocp attest ${p.id} ${g.id} --by <their name>`,
        by: block ? 'pocp fix' : 'person',
      });
    }
    const manual = ev.unattested.filter((x) => !guardIds.has(x));
    if (manual.length) {
      out.push({ code: 'unattested', what: `${p.id}: needs a sign-off: ${manual.join(', ')}`, why: 'these obligations are checks only a person can do.', next: `the person who did each check runs: pocp attest ${p.id} <obligation> --by <their name>`, by: 'person' });
    }
  }
  for (const p of r.problems.filter((x) => !['prove_failed', 'failed_proof', 'unfinished_proof', 'packet_not_staged'].includes(x.code))) {
    out.push({ code: p.code, what: p.detail, why: 'the gate cannot pass until this is resolved.', next: 'pocp fix', by: 'agent' });
  }
  for (const w of (r.warnings || []).filter((x) => x.code === 'draft_packet')) {
    out.push({ code: 'draft_packet', what: w.detail, why: 'a draft covers nothing until it is ready.', next: w.detail.match(/"(pocp ready [^"]+)"/)?.[1] || 'pocp ready <packet>', by: 'agent' });
  }
  return out;
}

/** What the gate says about an approval it leaves for later: CI asks a maintainer, or, in local mode, you approve it before merging. */
export function laterApproval(r, label) {
  return r?.local_mode ? localStep(label) : 'CI will ask a maintainer to approve it';
}

/** Notes for a passing gate that CI will still need a person for (block mode). */
export function pendingApprovals(r) {
  return (r.warnings || []).filter((w) => w.code === 'awaiting_test_approval' || w.code === 'awaiting_policy_approval').map((w) => (w.code === 'awaiting_test_approval'
    ? {
        code: 'test_change',
        what: w.detail,
        why: holdReason(APPROVE_TESTS_LABEL, { verdict: w.verdict }),
        next: approvalStep(APPROVE_TESTS_LABEL, { local: r.local_mode }),
        by: 'person',
        ...(r.local_mode ? { who: LOCAL_WHO } : {}),
      }
    : {
        code: 'policy_change',
        what: w.detail,
        why: holdReason(APPROVE_POLICY_LABEL),
        next: approvalStep(APPROVE_POLICY_LABEL, { local: r.local_mode }),
        by: 'person',
        ...(r.local_mode ? { who: LOCAL_WHO } : {}),
      }));
}

/**
 * The hold explanation (hold.js) for what a passing gate leaves for a person, or null: the same
 * sentences as pendingApprovals' `why`, and the one command (none in local mode).
 */
export function pendingHold(r) {
  const needs = (r.warnings || []).flatMap((w) => (w.code === 'awaiting_test_approval' ? [{ label: APPROVE_TESTS_LABEL, verdict: w.verdict }] : w.code === 'awaiting_policy_approval' ? [{ label: APPROVE_POLICY_LABEL }] : []));
  return holdExplanation(needs, { local: Boolean(r.local_mode) });
}

/**
 * The remedy for one blocking verify finding (CI): words for a person, never a decision
 * (decision.js decides). `finding.unfinished`, when the caller has it, says whether a
 * rerun_failed didn't finish; without it the detail text picks the wording.
 */
export function verifyRemedy(code, detail = '', finding = {}, { local = false } = {}) {
  const person = local ? { by: 'person', who: LOCAL_WHO } : { by: 'person' };
  const { variant } = factsOf(finding);
  switch (code) {
    case 'test_change':
      if (variant === 'local_only') return { why: 'a local pass can be faked; CI must see the check pass itself.', next: 'run verify with --rerun or --rerun-unsigned (the Action does by default)', by: 'agent' };
      if (variant === 'packet_checks') return { why: 'the check must run tests a rule requires, not ones the change picked.', next: 'add a requirement in .proof/rules.json covering these tests (a policy change a maintainer approves)', by: 'person' };
      return { why: 'existing tests changed and POCP could not show they still catch what they caught before.', next: approvalStep(APPROVE_TESTS_LABEL, { local, how: 'reviews the test change and ' }), ...person };
    case 'test_inconclusive':
      return { why: 'existing tests changed and the check that judges them didn\'t finish (a timeout, a kill or a failed start), so nothing is known about them yet. A test approval doesn\'t cover this.', next: `re-run the job; if it still can't finish, fix the hang or the time limit, or ${approvalStep(APPROVE_INCONCLUSIVE_LABEL, { local, how: 'who has read why ' })}`, ...person };
    case 'policy_loosened':
    case 'ci_config_changed':
      return { why: 'this change loosens the rules or CI that judge every later change; the change cannot approve itself.', next: approvalStep(APPROVE_POLICY_LABEL, { local, how: 'reviews it and ' }), ...person };
    case 'invalid_policy':
      return { why: 'POCP cannot judge anything under an invalid policy.', next: 'fix .proof/rules.json or .proof/config.json until "pocp rules check" passes, in a new commit', by: 'agent' };
    case 'ci_unfinished':
      return { why: "a required CI check didn't finish when verify re-ran it (it timed out or was killed), so nothing is known about the code yet.", next: 're-run the job; if it still can\'t finish, fix the hang or raise the time limit', by: 'rerun' };
    case 'ci_missing':
    case 'ci_failed':
      return { why: 'verify.require_ci lists checks CI must run on this exact code.', next: code === 'ci_failed' ? 'fix the code (not the tests) in a new commit' : 'run verify with --rerun, which runs the required checks itself (see examples/github/pocp.yml)', by: 'agent' };
    case 'rerun_failed':
      if (finding?.unfinished ?? UNFINISHED_TEXT.test(detail)) return { why: "a required check didn't finish when verify re-ran it (it timed out, was killed or didn't start), so nothing is known about the code yet.", next: 're-run the job; if it still can\'t finish, fix the hang or raise the time limit', by: 'rerun' };
      // falls through: a check that ran and failed
    case 'failed_proof':
      if (finding?.unfinished) return { why: UNFINISHED_PROOF.why, next: 're-run the job (or pocp fix and commit the new proof); if it still can\'t finish, fix the hang or raise timeout_ms', by: 'rerun' };
      return { why: 'a required check fails on this code.', next: 'fix the code (not the tests) and commit the fix with "pocp fix" then "git commit"', by: 'agent' };
    case 'trailer_mismatch':
      return { why: 'the commit\'s code is not the code that was proven; this happens after a rebase or an edit after proving.', next: 'ask a maintainer how to update this branch; to bring in main, use git merge rather than rebase so proofs stay valid', by: 'person' };
    case 'uncovered':
    case 'missing_packet':
    case 'unproven':
    case 'missing_required':
    case 'unattested':
      return { why: 'this commit was made without the proof its files need (were the hooks skipped or not installed? see "pocp doctor").', next: 'ask a maintainer how to repair the commit; for new commits run "pocp fix" before "git commit"', by: 'person' };
    case 'policy_mismatch':
      return { why: 'the packet was proven under different rules than the ones in force.', next: 'pocp fix, then commit again', by: 'agent' };
    case 'unfinished_proof':
      return { why: UNFINISHED_PROOF.why, next: 're-run the job (or pocp fix and commit the new proof); if it still can\'t finish, fix the hang or raise timeout_ms', by: 'rerun' };
    case 'invalid_signature':
      return { why: 'a proof was edited after signing, or its signer is not trusted.', next: 'prove again with a trusted key (pocp fix) in a new commit', by: 'agent' };
    case 'signature_unavailable':
      return { why: "the signature could not be checked here (ssh-keygen is missing, failed or timed out), so nothing is known about it: it doesn't count as valid, and it isn't a sign of tampering either.", next: 'install OpenSSH 8.1 or later (ssh-keygen) on the machine that runs verify and re-run it', by: 'infra' };
    default:
      return { why: '', next: 'pocp fix', by: 'agent' };
  }
}

/** Human lines for a list of remedies: who acts first. */
export function remedyLines(remedies, indent = '  ') {
  const lines = [];
  for (const r of remedies) {
    lines.push(`${indent}[${whoOf(r)}] ${r.what}`);
    if (r.why) lines.push(`${indent}  why: ${r.why}`);
    lines.push(`${indent}  next: ${r.next}`);
  }
  if (remedies.some((r) => r.by === 'person')) lines.push(`${indent}${dontRewrite(remedies)}`);
  return lines;
}
