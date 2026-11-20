// The commit gate: decide whether the staged change may be committed (gate, finishGate), suggest a
// packet for uncovered files (suggestPacket), and check an edit before it is made (checkEdit).
import * as g from '../git.js';
import * as P from '../packets.js';
import { POLICY_FILES, policyChange, policyLoosenings } from '../policy.js';
import { evaluateTriggers, requirementsFor, ruleWarnings, validateRules } from '../rules.js';
import { APPROVE_POLICY_LABEL, APPROVE_TESTS_LABEL, gateRemedies, laterApproval, pendingApprovals, pendingHold } from '../remedies.js';
import { policyKeyWarnings } from '../schema.js';
import { protectedChangeText } from './shared.js';
import { validateConfig } from '../store.js';
import { withFacts } from '../finding.js';

/** Gate for one engine, given the packet, proving and policy-reading functions it uses. */
export function createGate({ root, store, hostName, nowFn, emit, config, rules, activePackets, stagedGuard, mergeFilter, mergeAware, hostRequirements, hostTriggers, evaluate, prove, policyAt, readRulesAt, changedCiFiles }) {

  async function gate({ prove: doProve = false, mode, source = 'api' } = {}) {
    const allChanges = g.stagedChanges(root);
    const changes = mergeAware(allChanges);
    const files = g.changedPaths(changes);
    let subject = g.subjectHashIndex(root);
    const rulesObj = rules();
    const cfg = config();
    const result = { decision: 'pass', subject, files, required_files: [], reasons: [], uncovered: [], unpacketed: [], packets: [], problems: [], warnings: [] };
    // Local mode: no CI will ask anyone, so the approvals below are yours, before a merge.
    if (cfg.ci?.mode === 'local') result.local_mode = true;

    const rawRules = store.readRawRules();
    const rulesProblems = validateRules(rawRules || {});
    const configProblems = validateConfig(cfg);
    if (rulesProblems.length || configProblems.length) {
      result.decision = 'error';
      result.problems.push(...rulesProblems.map((p) => ({ code: 'invalid_rules', detail: p })));
      result.problems.push(...configProblems.map((p) => ({ code: 'invalid_config', detail: p })));
      return finishGate(result, source);
    }
    for (const w of policyKeyWarnings({ rules: rawRules, config: store.readRawConfig?.() })) result.warnings.push({ code: 'unknown_key', detail: w });
    if (files.length === 0 && !changes.some((c) => POLICY_FILES.includes(c.path) || POLICY_FILES.includes(c.oldPath))) {
      return finishGate(result, source);
    }
    for (const w of ruleWarnings(rulesObj, root)) result.warnings.push({ code: 'rule_glob', detail: w });
    if (changes.length !== allChanges.length) {
      result.merge = { heads: mergeFilter().heads, judged: files.length, taken: allChanges.length - changes.length };
      result.warnings.push({ code: 'merge', detail: `merge in progress: ${result.merge.taken} file(s) match the branch being merged and carry its proofs; only the ${files.length} file(s) changed while merging are checked here` });
    }

    const trig = evaluateTriggers(files, {
      rules: rulesObj,
      hostTriggers: await hostTriggers(files),
      hostRequirements: await hostRequirements(files),
      config: cfg,
      hostName,
    });
    // Adopting POCP (no policy at HEAD, or no HEAD yet) is not a policy change: there is no
    // earlier policy to loosen, and no rule yet to say which check would prove the new one.
    const basePolicy = g.hasHead(root) ? policyAt(g.resolveRev(root, 'HEAD')) : null;
    const adopting = !basePolicy || basePolicy.unenrolled;
    const pc = adopting ? null : policyChange(changes, rulesObj, readRulesAt('HEAD'));
    if (adopting && changes.some((c) => POLICY_FILES.includes(c.path))) {
      result.warnings.push({ code: 'adopting', detail: 'this commit adopts POCP (no earlier policy): the rules take effect for the commits after it' });
    }
    if (pc) {
      trig.required_files = [...new Set([...trig.required_files, ...pc.files])].sort();
      trig.reasons.push(pc.reason);
      // What verify will call a loosening (base policy vs this one): CI needs a maintainer for it.
      const weakened = policyLoosenings({ rules: { base: basePolicy.hasRules ? basePolicy.rules : null, head: rulesObj }, config: { base: basePolicy.config, head: cfg } });
      if (weakened.length) result.warnings.push({ code: 'awaiting_policy_approval', detail: `this loosens POCP policy (${weakened.slice(0, 3).join('; ')}${weakened.length > 3 ? '; …' : ''}); ${laterApproval(result, APPROVE_POLICY_LABEL)}` });
    }
    const ciChanged = changedCiFiles(changes, cfg);
    if (ciChanged.length) {
      result.warnings.push({ code: 'awaiting_policy_approval', detail: `${protectedChangeText(ciChanged)}; ${laterApproval(result, APPROVE_POLICY_LABEL)}` });
      trig.required_files = [...new Set([...trig.required_files, ...ciChanged])].sort();
      trig.reasons.push({ code: 'ci_config', detail: protectedChangeText(ciChanged), files: ciChanged });
    }
    const guard = stagedGuard();
    result.guard_mode = guard.mode;
    if (guard.files.length) {
      result.test_guard = guard;
      if (guard.mode !== 'warn') trig.required_files = [...new Set([...trig.required_files, ...guard.files])].sort();
      const weak = guard.signals.filter((x) => x.removed_asserts || x.added_skips);
      trig.reasons.push({
        code: 'test_change',
        detail: `existing tests or test setup changed (${guard.files.length} file(s))${weak.length ? `; possible weakening: ${weak.map((x) => `${x.file} -${x.removed_asserts} asserts +${x.added_skips} skips`).join(', ')}` : ''}${guard.mode === 'warn' ? '' : '; pocp prove checks mechanically that nothing was weakened'}`,
        files: guard.files,
      });
    }
    result.required_files = trig.required_files;
    result.reasons = trig.reasons;
    if (trig.required_files.length === 0) return finishGate(result, source);

    let active = activePackets();
    const covering = (list) => list.filter((p) => p.state !== 'draft' && trig.required_files.some((f) => P.covers(p, f)));

    if (doProve) {
      const targets = covering(active);
      if (targets.length) {
        try {
          await prove({ ids: targets.map((p) => p.id), mode });
        } catch (err) {
          result.problems.push(withFacts({ code: 'prove_failed', detail: err.message, ...(err.details || {}) }, { errorCode: err.code }));
        }
        active = activePackets();
        subject = g.subjectHashIndex(root);
        result.subject = subject;
      }
    }

    const drafts = active.filter((p) => p.state === 'draft' && trig.required_files.some((f) => P.covers(p, f)));
    for (const d of drafts) result.warnings.push({ code: 'draft_packet', detail: `packet ${d.id} is a draft and covers nothing until "pocp ready ${d.id}"` });

    // Each required file needs at least one proven packet whose file is staged. A covering
    // packet with a failed check always blocks, so a failing check can't be routed around
    // with a weaker packet. Other unproven packets on the same files are only warnings.
    const cov = covering(active);
    const evaluated = [];
    for (const packet of cov) {
      const ev = await evaluate(packet, subject, rulesObj);
      const fileOk = store.kind !== 'fs' || g.isStagedClean(root, store.packetRelPath(packet.id));
      evaluated.push({ packet, ev, fileOk });
      result.packets.push({
        id: packet.id,
        intent: packet.intent,
        covers: trig.required_files.filter((f) => P.covers(packet, f)),
        evaluation: ev,
        packet_file_staged: fileOk,
      });
    }
    const good = evaluated.filter((e) => e.ev.ok && e.fileOk).map((e) => e.packet);
    result.unpacketed = trig.required_files.filter((f) => !cov.some((p) => P.covers(p, f)));
    result.uncovered = trig.required_files.filter((f) => !good.some((p) => P.covers(p, f)));
    for (const e of evaluated) {
      if (e.ev.ok && !e.fileOk) {
        result.problems.push({ code: 'packet_not_staged', detail: `stage ${store.packetRelPath(e.packet.id)} so its proofs ship with the commit`, packet: e.packet.id });
      } else if (e.ev.failed.length) {
        // A check that didn't finish (timeout, signal, failed start) says nothing about the code:
        // it blocks just the same, but as "re-run", never as "fails on this code".
        const unfinished = e.ev.unfinished || [];
        const ranAndFailedIds = e.ev.failed.filter((id) => !unfinished.includes(id));
        if (ranAndFailedIds.length) result.problems.push({ code: 'failed_proof', detail: `packet ${e.packet.id} has failing checks: ${ranAndFailedIds.join(', ')}`, packet: e.packet.id });
        if (unfinished.length) result.problems.push({ code: 'unfinished_proof', detail: `packet ${e.packet.id} has checks that didn't finish (timed out, killed or didn't start): ${unfinished.join(', ')}`, packet: e.packet.id });
      } else if (!e.ev.ok && !result.uncovered.some((f) => P.covers(e.packet, f))) {
        result.warnings.push({ code: 'open_packet', detail: `packet ${e.packet.id} also covers these files and isn't proven for this code`, packet: e.packet.id });
      }
      if (e.ev.handed_to_ci?.length) {
        const what = e.ev.handed_to_ci.map((id) => {
          const ob = e.packet.obligations.find((o) => o.id === id);
          return ob?.run ? `${id} (${ob.run})` : ob?.kind === 'guard' ? `${id} (the test guard)` : id;
        });
        (result.handed_to_ci ||= []).push({ packet: e.packet.id, obligations: e.ev.handed_to_ci });
        // Fast mode (guard.mutants 0): no test change passes on its own, so the approval CI will
        // ask for is already certain. Said now, as when the guard runs here.
        const guardOb = e.packet.obligations.find((o) => o.kind === 'guard' && e.ev.handed_to_ci.includes(o.id));
        if (guardOb && guardOb.mutants === 0) result.warnings.push({ code: 'awaiting_test_approval', detail: `${e.packet.id}: the test-change check was handed to CI; in fast mode (guard.mutants: 0) every test change goes to a person, so the commit can go ahead and ${laterApproval(result, APPROVE_TESTS_LABEL)}`, packet: e.packet.id });
        result.warnings.push({ code: 'handed_to_ci', detail: `${e.packet.id}: ${what.join(', ')} handed to CI, not run on this machine (ci.defer_heavy). Not proven yet: CI's verify --rerun runs ${e.ev.handed_to_ci.length > 1 ? 'them' : 'it'} before merge, and the required pocp status blocks the merge until ${e.ev.handed_to_ci.length > 1 ? 'they pass' : 'it passes'}`, packet: e.packet.id, obligations: e.ev.handed_to_ci });
      }
      for (const a of e.ev.awaiting_approval || []) {
        result.warnings.push({ code: 'awaiting_test_approval', detail: `${e.packet.id}: the test-change check did not pass (${a.detail || a.status}); the commit can go ahead, and ${laterApproval(result, APPROVE_TESTS_LABEL)}`, packet: e.packet.id, ...(a.status ? { verdict: a.status } : {}) });
      }
    }
    const blocked = result.uncovered.length > 0 || result.problems.length > 0;
    result.decision = blocked ? 'blocked' : 'pass';
    if (result.unpacketed.length) result.suggestion = await suggestPacket(result.unpacketed, rulesObj);
    return finishGate(result, source);
  }

  // source: who asked for this evaluation, so the gate log can tell commit attempts (hook)
  // from manual checks (gate), pocp fix's rounds (fix) and library callers (api).
  function finishGate(result, source) {
    result.remedies = gateRemedies(result);
    result.pending_approvals = pendingApprovals(result);
    // The same plain explanation the pocp status, the PR comment and pocp approvals give (hold.js),
    // for agents (--json) to relay word for word. Only when something waits for a person.
    const hold = pendingHold(result);
    if (hold) result.hold = hold;
    try {
      store.appendLog?.('gate', {
        at: nowFn(),
        source,
        decision: result.decision,
        subject: result.subject,
        required: result.required_files.length,
        uncovered: (result.unpacketed || []).length,
        packets: result.packets.map((p) => ({ id: p.id, ok: p.evaluation.ok, failed: p.evaluation.failed.length })),
      });
    } catch { /* logging is best effort */ }
    emit(result.decision === 'pass' ? 'gate.passed' : 'gate.blocked', { subject: result.subject, uncovered: result.uncovered });
    return result;
  }

  /** A suggested packet whose obligations come only from requirements. Never filler. */
  async function suggestPacket(files, rulesObj = rules()) {
    const req = requirementsFor(files, { rules: rulesObj, hostRequirements: await hostRequirements(files), hostName });
    const touches = files.slice(0, 50);
    const obligations = req.merged.map((r) => ({ from: r.id, ...r.obligation }));
    const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const cmd = ['pocp open --intent', quote('<what this change does>'), ...touches.map((t) => `--touch ${quote(t)}`)];
    return {
      touches,
      obligations,
      note: obligations.length
        ? 'Required checks for these files are added automatically when the packet opens.'
        : 'No rule requires a check for these files yet. Add at least one runnable obligation (--test, --command or --probe).',
      command: cmd.join(' ') + (obligations.length ? '' : ` --test ${quote('<command that proves it>')}`),
    };
  }

  /**
   * For pre-edit hooks: which of these files would need a packet if changed, and is
   * one already open? Uses glob triggers and requirements (not broad/cross-area,
   * which depend on the whole change).
   */
  async function checkEdit(files) {
    const rulesObj = rules();
    const norm = files.map((f) => String(f).replace(/^\.\//, ''));
    const trig = evaluateTriggers(norm, {
      rules: { ...rulesObj, triggers: { ...rulesObj.triggers, broad_files: undefined, cross_area: undefined } },
      hostTriggers: await hostTriggers(norm),
      hostRequirements: await hostRequirements(norm),
      config: config(),
      hostName,
    });
    for (const f of norm) if (POLICY_FILES.includes(f) && !trig.required_files.includes(f)) trig.required_files.push(f);
    const active = activePackets().filter((p) => p.state !== 'draft');
    const uncovered = trig.required_files.filter((f) => !active.some((p) => P.covers(p, f)));
    return {
      ok: uncovered.length === 0,
      protected: trig.required_files,
      uncovered,
      suggestion: uncovered.length ? await suggestPacket(uncovered, rulesObj) : null,
    };
  }

  return { gate, finishGate, suggestPacket, checkEdit };
}
