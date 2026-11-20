// Handing heavy checks to CI (`ci.defer_heavy`): in a repository where GitHub CI re-runs every
// check (`verify --rerun`) and a required status blocks the merge, `pocp fix` can record a check
// as "handed to CI" instead of running it on the developer's machine. A hand-off is never a
// proof: the gate lets the commit through, and verify accepts it only when it re-runs that exact
// check itself and the run passes.
//
// Who may hand off what is decided by two policies at once, the committed base (HEAD locally, the
// base branch in CI) and the change's own, combined strictly (policy.js combinePolicy): a change
// can't turn hand-offs on for itself, or mark its own checks "defer". Local mode never hands off.
import { combinePolicy } from './policy.js';
import { normalizeRequirement } from './rules.js';
import { deferAllowed } from './store.js';
import { isGuard, isRunnable, obligationDigest } from './obligations.js';

/** The `to` of a hand-off record in a packet's `deferrals` (a failed guard awaiting approval is "ci-approval"). */
export const HANDOFF_TO = 'ci-run';

/**
 * The policy hand-offs are judged by: the base's and the head's rules and config combined
 * strictly, never the head's alone (an approved loosening doesn't let a change defer its own
 * checks). Null when there is no enrolled base, or either side doesn't allow hand-offs.
 * `base` and `head` are { rules, config, hasRules? } as policyAt returns them.
 */
export function handoffPolicy(base, head) {
  // No base rules: nothing the base marks "defer", so nothing is handed off.
  if (!base || base.unenrolled || base.hasRules === false || !head) return null;
  if (!deferAllowed(base.config) || !deferAllowed(head.config)) return null;
  const combined = combinePolicy({ base, head });
  return deferAllowed(combined.config) ? combined : null;
}

/**
 * May this check be handed to CI under `policy` (from handoffPolicy)? A runnable check only when
 * every rule that requires it marks it `"defer": "ci"`. The test guard only in block mode, where
 * CI never takes a local guard result anyway: a test change passes there only on CI's own
 * re-run of the check (or a maintainer's approval).
 */
export function canHandOff(ob, policy) {
  if (!policy || !ob) return false;
  if (isGuard(ob)) return policy.config.guard?.tests === 'block';
  if (!isRunnable(ob)) return false;
  const d = obligationDigest(ob);
  const same = (policy.rules.requirements || []).flatMap((r) => {
    try {
      return [normalizeRequirement(r)];
    } catch {
      return [];
    }
  }).filter((r) => r.digest === d);
  return same.length > 0 && same.every((r) => r.defer === 'ci');
}

/** Set POCP_DEFER=off (or pass --no-defer to pocp fix / prove) to run every check locally. */
export function handoffDisabled(env = process.env) {
  return String(env.POCP_DEFER || '').toLowerCase() === 'off';
}

/**
 * Checks handed to CI that this verify didn't run itself and pass: [{ packet, ob }]. A run
 * that failed is left out (rerun_failed reports it); a pass taken from a CI results file or a
 * signature doesn't count. `handed` is [{ packet, ob }], `reruns` verify's re-run entries.
 */
export function handoffsNotRun(handed, reruns) {
  return handed.filter((h) => {
    const d = obligationDigest(h.ob);
    const runs = reruns.filter((r) => r.digest === d);
    return !runs.some((r) => (r.status === 'passed' || r.status === 'failed') && !r.evidence);
  });
}

/** The finding text for a check handed to CI that this verify didn't run. */
export function handoffNotRunText(h) {
  return `${h.packet} ${h.ob.id} (${h.ob.run}) was handed to CI and this verify didn't run it: only verify's own re-run can pass a handed-off check (not a CI results file or a signature)`;
}
