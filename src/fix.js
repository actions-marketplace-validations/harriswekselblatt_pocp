import * as g from './git.js';
import * as P from './packets.js';
import { dontRewrite, UNFINISHED_PROOF } from './remedies.js';
import { normalizeObligation, obligationDigest } from './obligations.js';

const MAX_ROUNDS = 4;

/**
 * The check to use when no rule names one for these files: --test, then the repo's own.
 * A rule's check is borrowed whole (its cwd, timeout_ms and every other setting), never just
 * its command: the command alone can't run outside its folder.
 */
export function fallbackCheck(engine, test) {
  if (test) return { obligation: { kind: 'test', run: test }, from: '--test' };
  const cfg = engine.config();
  const ci = cfg.verify?.require_ci?.[0];
  if (ci) return { obligation: { kind: 'test', run: ci }, from: 'verify.require_ci in .proof/config.json' };
  const counts = new Map(); // digest -> { obligation, n }: two rules are the same check only when every setting matches
  for (const r of engine.rules().requirements || []) {
    if (r.obligation?.kind !== 'test' || !r.obligation.run) continue;
    const { id, source, ...obligation } = r.obligation;
    let d;
    try { d = obligationDigest(normalizeObligation(obligation)); } catch { continue; } // an invalid rule can't lend its check
    counts.set(d, { obligation, n: (counts.get(d)?.n || 0) + 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { obligation: best.obligation, from: 'the test command .proof/rules.json requires most often' } : null;
}

function defaultIntent(files) {
  const shown = files.slice(0, 3).join(', ');
  return `Change to ${shown}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
}

/**
 * The packet `fix` widens instead of opening another: an active packet the same author opened
 * that already covers some of the staged files (the one they are working in).
 */
function packetToWiden(engine, gate, actor) {
  const staged = gate.files || [];
  const mine = engine.activePackets()
    .filter((p) => p.state !== 'draft' && p.opened_by === actor && staged.some((f) => P.covers(p, f)))
    .sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
  return mine[0] || null;
}

/**
 * `pocp fix`: take every mechanical step the gate asks for, then say what is left and who
 * has to do it. It opens or widens a packet, adds required checks, proves (a snapshot of the
 * staged code when the working folder differs), and stages packet files. It never signs off
 * for anyone, and never re-runs a check that already failed on this exact code.
 */
export async function runFix(engine, { intent, test, mode, actor } = {}) {
  const actions = [];
  let gate = await engine.gate({ source: 'fix' });
  const proved = new Set();
  for (let round = 0; round < MAX_ROUNDS && gate.decision === 'blocked'; round++) {
    let progressed = false;
    if (gate.unpacketed.length) {
      const target = packetToWiden(engine, gate, actor);
      if (target) {
        const r = await engine.widen(target.id, gate.unpacketed);
        actions.push({ action: 'widen', packet: target.id, files: gate.unpacketed, checks_added: r.required_added.map((o) => o.id) });
      } else {
        const sug = gate.suggestion || (await engine.suggestPacket(gate.unpacketed));
        const obligations = [];
        let fallback = null;
        if (!sug.obligations.length) {
          fallback = fallbackCheck(engine, test);
          if (!fallback) break; // nothing to prove it with: reported below
          obligations.push(fallback.obligation);
        }
        const r = await engine.open({ intent: intent || defaultIntent(gate.unpacketed), touches: gate.unpacketed, obligations });
        actions.push({ action: 'open', packet: r.packet.id, files: gate.unpacketed, checks: r.packet.obligations.map((o) => (o.source && o.source !== 'author' ? `${o.id} (${o.source})` : o.id)), ...(fallback ? { check_from: fallback.from, check: fallback.obligation.run, ...(fallback.obligation.cwd ? { check_cwd: fallback.obligation.cwd } : {}) } : {}), ...(intent ? {} : { intent: r.packet.intent }) });
      }
      progressed = true;
      gate = await engine.gate({ source: 'fix' });
    }
    const stale = gate.packets.filter((p) => p.evaluation.missing_required.length);
    if (stale.length) {
      await engine.sync(stale.map((p) => p.id));
      actions.push({ action: 'sync', packets: stale.map((p) => p.id) });
      progressed = true;
    }
    const toProve = gate.packets.filter((p) => !p.evaluation.ok || p.evaluation.missing_required.length).map((p) => p.id).filter((id) => !proved.has(`${id}\0${gate.subject}`));
    if (toProve.length) {
      let r;
      let usedMode = mode;
      try {
        r = await engine.prove({ ids: toProve, mode, retryFailed: false });
      } catch (err) {
        if (mode || err?.code !== 'clean_mode_refused') throw err;
        usedMode = 'snapshot';
        r = await engine.prove({ ids: toProve, mode: 'snapshot', retryFailed: false });
        actions.push({ action: 'note', detail: 'the working folder differs from what is staged, so a snapshot of exactly the staged code was proven' });
      }
      for (const id of toProve) proved.add(`${id}\0${gate.subject}`);
      const ran = r.packets.flatMap((p) => p.runs.filter((x) => !x.skipped && !x.cached && !x.reused_from && !x.handed_to_ci));
      actions.push({
        action: 'prove',
        packets: toProve,
        mode: usedMode || r.mode,
        ran: ran.length,
        // ci.defer_heavy: checks recorded as handed to CI instead of run here (never proven here).
        ...(() => {
          const handed = r.packets.flatMap((p) => p.runs.filter((x) => x.handed_to_ci).map((x) => ({ packet: p.id, obligation: x.obligation, ...(x.run ? { run: x.run } : {}) })));
          return handed.length ? { handed_to_ci: handed } : {};
        })(),
        checks: r.packets.reduce((n, p) => n + p.runs.length, 0),
        ms: ran.reduce((a, x) => a + (x.duration_ms || 0), 0),
        failed: r.packets.flatMap((p) => p.runs.filter((x) => x.passed === false || x.failed_before).map((x) => ({
          packet: p.id, obligation: x.obligation, log: x.run_id ? `.proof/runs/${x.run_id}.log` : null, before: Boolean(x.failed_before),
          // Timed out, killed or didn't start: says nothing about the code (a guard's own
          // verdict is judged elsewhere).
          ...(x.outcome === 'unfinished' ? { unfinished: true } : {}),
        }))),
      });
      for (const detail of nearTimeout(engine, r.packets, engine.config())) actions.push({ action: 'note', detail });
      progressed = true;
    }
    // Block mode: a test change the check couldn't pass goes to a maintainer in CI. Recorded as
    // a hand-over, never as a sign-off: the author can't approve its own test change.
    if (gate.guard_mode === 'block') {
      const fresh = await engine.gate({ source: 'fix' });
      for (const p of fresh.packets.filter((x) => (x.evaluation.guard || []).some((gd) => x.evaluation.unattested.includes(gd.id) && gd.status !== 'unproven'))) {
        const d = engine.deferToCi(p.id);
        if (d.length) {
          actions.push({ action: 'defer', packet: p.id, obligations: d.map((x) => x.obligation) });
          progressed = true;
        }
      }
    }
    const unstaged = gate.problems.filter((p) => p.code === 'packet_not_staged');
    if (unstaged.length) {
      engine.stagePackets(unstaged.map((p) => p.packet));
      actions.push({ action: 'stage', packets: unstaged.map((p) => p.packet) });
      progressed = true;
    }
    if (!progressed) break;
    gate = await engine.gate({ source: 'fix' });
  }

  const remaining = gate.decision === 'pass' ? [] : gate.remedies;
  const needsPerson = [...remaining.filter((r) => r.by === 'person'), ...(gate.pending_approvals || [])];
  const needsAgent = remaining.filter((r) => r.by !== 'person');
  if (gate.decision === 'blocked' && gate.unpacketed.length && !actions.some((a) => a.action === 'open' || a.action === 'widen')) {
    needsAgent.unshift({ code: 'no_check', what: `no rule names a check for ${gate.unpacketed.join(', ')}`, why: 'a packet needs at least one check that proves the change.', next: 'pocp fix --test "<command that proves it>"', by: 'agent' });
  }
  // A failed test-change check handed to CI (now or by an earlier fix on this code) is the
  // maintainer's to decide, not the author's to fix.
  const handed = new Set();
  for (const p of gate.packets || []) {
    let packet = null;
    try { packet = engine.loadPacket(p.id); } catch { continue; }
    for (const ob of packet.obligations || []) if (P.currentDeferral(packet, ob, gate.subject)) handed.add(`${p.id}\0${ob.id}`);
  }
  for (const a of actions.filter((x) => x.action === 'defer')) for (const o of a.obligations) handed.add(`${a.packet}\0${o}`);
  for (const a of actions.filter((x) => x.action === 'prove')) {
    a.handed = a.failed.filter((f) => handed.has(`${f.packet}\0${f.obligation}`)).map((f) => f.obligation);
    for (const f of a.failed) {
      if (handed.has(`${f.packet}\0${f.obligation}`)) continue;
      if (f.unfinished) {
        needsAgent.unshift({
          code: 'unfinished_proof',
          what: `${f.obligation} didn't finish on this code (timed out, killed or didn't start)${f.log ? ` · log ${f.log}` : ''}`,
          why: UNFINISHED_PROOF.why,
          next: 'run pocp fix again (it re-runs checks that didn\'t finish); if it still can\'t finish, fix the hang or raise the check\'s timeout_ms. Do not change the code because of it.',
          by: 'agent',
        });
        continue;
      }
      needsAgent.unshift({
        code: 'failed_proof',
        what: `${f.obligation} fails on this exact code${f.before ? ' (it failed here before, so it was not run again)' : ''}${f.log ? ` · log ${f.log}` : ''}`,
        why: 'a required check fails, so the change would break what it protects.',
        next: 'fix the code (not the tests), stage it, and run pocp fix again',
        by: 'agent',
      });
    }
  }
  return {
    ok: gate.decision === 'pass',
    decision: gate.decision,
    nothing_staged: (gate.files || []).length === 0 && stagedPaths(engine.root).length === 0,
    // Staged, but nothing in it needs proof (for example only .proof/ policy files).
    nothing_to_prove: (gate.files || []).length === 0 && stagedPaths(engine.root).length > 0,
    actions,
    needs_agent: dedupe(needsAgent),
    needs_person: dedupe(needsPerson),
    advice: needsPerson.length ? dontRewrite(needsPerson) : null,
    gate,
  };
}

/**
 * Checks that passed but used more than half their time limit. On a busy machine (several
 * agents proving at once) such a check is the next to time out, and a timeout means the whole
 * run again with nothing learned. Advice only: nothing here changes a result.
 */
export function nearTimeout(engine, packets, cfg) {
  const out = [];
  for (const p of packets || []) {
    let packet = null;
    try { packet = engine.loadPacket(p.id); } catch { continue; }
    for (const x of p.runs || []) {
      if (!x.passed || x.skipped || x.cached || x.reused_from || x.guard) continue;
      const ob = (packet.obligations || []).find((o) => o.id === x.obligation);
      const limit = ob?.timeout_ms || cfg.run.timeout_ms;
      if (!limit || !(x.duration_ms > limit / 2)) continue;
      const where = ob?.timeout_ms ? `the check's timeout_ms (${ob.source && ob.source !== 'author' ? `in ${ob.source.replace(/^rule:/, 'rule ')}` : `in packet ${p.id}`})` : 'run.timeout_ms in .proof/config.json';
      const [took, of] = durations(x.duration_ms, limit);
      out.push(`${p.id}: ${x.obligation} took ${took} of its ${of} limit; under load it may time out. Consider raising ${where}.`);
    }
  }
  return out;
}

/** Both in the limit's unit: whole seconds under two minutes, else minutes to one decimal. */
function durations(ms, limit) {
  if (limit < 120_000) return [`${Math.round(ms / 1000)}s`, `${Math.round(limit / 1000)}s`];
  const min = (v) => `${Number((v / 60_000).toFixed(1))} min`;
  return [min(ms), min(limit)];
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((r) => {
    const k = `${r.code}\0${r.what}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Paths in the index that differ from HEAD (what a commit now would change). */
function stagedPaths(root) {
  // Through git.js, so it gets the same hardening as every other git call.
  const out = g.git(root, ['diff', '--cached', '--name-only', '-z'], { allowFail: true, trim: false });
  return out ? out.split('\0').filter(Boolean) : [];
}

/** Human output for a fix result. */
export function formatFix(r) {
  const lines = [];
  if (r.ok && r.nothing_staged) return 'pocp fix: nothing is staged; stage the change (git add) and run pocp fix again';
  if (r.ok && r.nothing_to_prove) return 'pocp fix: ready to commit (git commit): nothing staged needs proof';
  const onlyTests = r.needs_person.length && r.needs_person.every((x) => x.code === 'test_change');
  // Local mode (ci.mode "local"): no CI; you approve before merging, through verify.
  const local = Boolean(r.gate?.local_mode);
  const awaiting = local
    ? (onlyTests ? 'the test change needs your approval before you merge (local mode)' : 'it needs your approval before you merge (local mode, see below)')
    : (onlyTests ? 'CI requires human approval of the test change' : 'CI requires human approval (see below)');
  const head = r.ok
    ? r.needs_person.length
      ? `pocp fix: committable now; ${awaiting}`
      : r.actions.some((a) => a.handed_to_ci?.length) || r.gate?.handed_to_ci?.length
        ? 'pocp fix: ready to commit (git commit); some checks were handed to CI, which runs them before merge'
        : 'pocp fix: ready to commit (git commit)'
    : r.needs_person.length && !r.needs_agent.length ? 'pocp fix: needs a person' : 'pocp fix: needs you';
  lines.push(head);
  for (const a of r.actions) {
    if (a.action === 'open') lines.push(`  did: opened ${a.packet} for ${a.files.length} file(s) with checks ${a.checks.join(', ') || 'none'}${a.check_from ? ` (check "${a.check}"${a.check_cwd ? ` in ${a.check_cwd}` : ''} from ${a.check_from})` : ''}${a.intent ? `; intent "${a.intent}" (pass --intent to say what the change does)` : ''}`);
    else if (a.action === 'widen') lines.push(`  did: widened ${a.packet} to cover ${a.files.join(', ')}${a.checks_added.length ? `; required checks added: ${a.checks_added.join(', ')}` : ''}`);
    else if (a.action === 'sync') lines.push(`  did: added the checks the rules now require to ${a.packets.join(', ')}`);
    else if (a.action === 'prove') {
      const extra = `${a.ran ? `, ${Math.round(a.ms / 1000)}s` : ''}${a.mode === 'snapshot' ? ', snapshot of the staged code' : ''}`;
      const toCi = a.handed_to_ci || [];
      if (!a.failed.length && toCi.length) lines.push(`  did: checked ${a.packets.join(', ')} (${a.ran} check(s) run here${extra})`);
      else if (!a.failed.length) lines.push(`  did: proved ${a.packets.join(', ')} (${a.ran} check(s) run${a.ran ? '' : '; nothing new to run'}${extra})`);
      else {
        // Say what passed and what didn't: a failed check is never counted as proved.
        const handed = a.handed || [];
        const failing = a.failed.filter((f) => !f.unfinished).map((f) => f.obligation).filter((o) => !handed.includes(o));
        const unfinished = a.failed.filter((f) => f.unfinished).map((f) => f.obligation).filter((o) => !handed.includes(o));
        const total = Math.max(a.checks ?? a.ran, a.failed.length);
        lines.push(`  did: proved ${total - a.failed.length} of ${total} check(s) for ${a.packets.join(', ')}${extra ? ` (${extra.slice(2)})` : ''}${handed.length ? `; ${handed.join(', ')} ${local ? 'left for your approval' : 'handed to CI'}` : ''}${failing.length ? `; ${failing.join(', ')} failed` : ''}${unfinished.length ? `; ${unfinished.join(', ')} didn't finish` : ''}`);
      }
      if (toCi.length) {
        const n = toCi.length;
        const what = toCi.map((x) => `${x.packet} ${x.obligation}${x.run ? ` (${x.run})` : ' (the test guard)'}`).join(', ');
        lines.push(`  did: handed ${what} to CI instead of running ${n > 1 ? 'them' : 'it'} here (ci.defer_heavy). Not proven yet: CI's verify --rerun runs ${n > 1 ? 'them' : 'it'} before merge, and the required pocp status holds the merge until ${n > 1 ? 'they pass' : 'it passes'}. To run ${n > 1 ? 'them' : 'it'} here instead: pocp fix --no-defer`);
      }
    }
    else if (a.action === 'defer') lines.push(local ? `  did: left ${a.packet} ${a.obligations.join(', ')} for your approval: in local mode you approve the test change before merging, through verify` : `  did: handed ${a.packet} ${a.obligations.join(', ')} to CI: a maintainer approves the test change there (no sign-off from you)`);
    else if (a.action === 'stage') lines.push(`  did: staged ${a.packets.map((id) => `.proof/packets/${id}.json`).join(', ')}`);
    else if (a.action === 'note') lines.push(`  note: ${a.detail}`);
  }
  // Checks an earlier fix handed to CI for this same code: still not proven, still said.
  const shown = new Set(r.actions.flatMap((a) => (a.handed_to_ci || []).map((x) => `${x.packet}\0${x.obligation}`)));
  for (const h of r.gate?.handed_to_ci || []) {
    const left = h.obligations.filter((o) => !shown.has(`${h.packet}\0${o}`));
    if (left.length) lines.push(`  note: ${h.packet} ${left.join(', ')} handed to CI, not run here (ci.defer_heavy). Not proven yet: CI's verify --rerun runs ${left.length > 1 ? 'them' : 'it'} before merge. To run ${left.length > 1 ? 'them' : 'it'} here instead: pocp fix --no-defer`);
  }
  for (const x of r.needs_agent) {
    lines.push(`  needs you: ${x.what}`);
    if (x.why) lines.push(`    why: ${x.why}`);
    lines.push(`    next: ${x.next}`);
  }
  for (const x of r.needs_person) {
    lines.push(`  needs a person: ${x.what}`);
    if (x.why) lines.push(`    why: ${x.why}`);
    lines.push(`    the one action: ${x.next}`);
  }
  if (r.advice) lines.push(`  ${r.advice}`);
  return lines.join('\n');
}
