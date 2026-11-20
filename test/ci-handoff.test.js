// ci.defer_heavy: in GitHub CI mode, checks a rule marks "defer": "ci" are handed to CI at commit
// instead of run on the developer's machine. A hand-off is never a proof: only verify's own
// re-run of the check, in CI, passes it. Local mode never hands off. Each attack below is one a
// change could try to get its checks out of running anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, pocp, read, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { commit } from './fixtures.js';
import { configWeakening, rulesWithDefaults, strictConfig, validateConfig, withDefaults } from '../src/store.js';
import { policyWeakening, strictUnion, validateRules } from '../src/rules.js';
import { canHandOff, handoffPolicy, handoffsNotRun } from '../src/handoff.js';
import { applyHandoff, applyEvaluation, createPacket, evaluatePacket, recordHandoff } from '../src/packets.js';
import { formatTrailer, parseTrailerValue } from '../src/trailer.js';
import { obligationDigest } from '../src/obligations.js';
import { formatFix } from '../src/fix.js';
import { setCiMode } from '../src/init.js';

const CHECK = 'node test/math.check.mjs';
const rule = (defer) => ({ id: 'math-tests', globs: ['src/**'], obligation: { kind: 'test', run: CHECK }, source: 'author', ...(defer ? { defer: 'ci' } : {}) });
const BROKEN = 'export function add(a, b) {\n  return a - b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';
const CHANGED = 'export function add(a, b) {\n  return b + a;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';

/** A sample repository whose committed policy is `cfg` and `defer` on its rule, on main. */
function repo({ cfg = { ci: { defer_heavy: true } }, defer = true } = {}) {
  const dir = sampleRepo({ hooks: true, deep: false, rules: { requirements: [rule(false)] } });
  writeConfig(dir, { guard: { mutants: 0 }, ...cfg });
  writeRules(dir, { requirements: [rule(defer)] });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'policy');
  return dir;
}

const packetOf = (dir, f) => {
  const id = f.json.actions.find((a) => a.action === 'open').packet;
  return { id, packet: JSON.parse(read(dir, `.proof/packets/${id}.json`)) };
};
const blocking = (v) => [...(v.json.findings || []), ...v.json.commits.flatMap((c) => c.findings), ...(v.json.net?.findings || [])].filter((f) => f.blocking);

test('the commit hands the check to CI: not run, not proven, said plainly; verify --rerun runs it', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', CHANGED);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'swap', '--json']);
  assert.equal(f.code, 0, f.stderr);
  const prove = f.json.actions.find((a) => a.action === 'prove');
  assert.equal(prove.ran, 0, 'nothing ran on this machine');
  assert.deepEqual(prove.handed_to_ci.map((x) => x.obligation), ['o1']);
  const { packet } = packetOf(dir, f);
  assert.match(formatFix({ ...f.json, gate: {} }), /handed p-[0-9a-f]+ o1 \(node test\/math\.check\.mjs\) to CI instead of running it here/);
  assert.equal(packet.proofs.length, 0, 'no proof is recorded for a check handed to CI');
  assert.deepEqual(packet.deferrals.map((d) => d.to), ['ci-run']);
  assert.notEqual(packet.state, 'proven', 'a packet with a check handed to CI is never "proven"');
  assert.ok(packet.history.some((h) => h.event === 'handed_to_ci'));

  const human = pocp(dir, ['fix']);
  assert.match(human.stdout, /p-[0-9a-f]+ o1 handed to CI, not run here/);
  assert.match(human.stdout, /Not proven yet: CI's verify --rerun runs it before merge/);
  const g = pocp(dir, ['gate']);
  assert.equal(g.code, 0, g.stderr);
  assert.match(g.stdout + g.stderr, /handed to CI, not run on this machine/);
  assert.match(g.stdout, /gate passed \(0 packet\(s\) proven, 1 with checks handed to CI/);

  assert.equal(commit(dir, 'swap').status, 0);
  const msg = git(dir, 'log', '-1', '--format=%B');
  assert.match(msg, /proven=0\/1 attested=0\/0 handed-to-ci=o1/, 'the trailer says handed to CI, not proven');

  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.ok(v.json.reruns.some((r) => r.run === CHECK && r.status === 'passed' && !r.evidence), 'verify ran the check itself');
  assert.equal(v.json.commits[0].packets[0].evidence.o1, 'rerun');

  const plain = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(plain.code, 1, 'without --rerun nothing ran the check: never a pass');
  assert.ok(blocking(plain).some((x) => x.code === 'unproven' && /handed to CI, and only verify --rerun runs it/.test(x.detail)));
});

test('a check handed to CI that fails there blocks the merge', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'broken', '--json']);
  assert.equal(f.code, 0, 'not run here, so the break is not seen at commit');
  assert.equal(commit(dir, 'broken').status, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 1);
  assert.ok(blocking(v).some((x) => x.code === 'rerun_failed'));
});

test('--ci-results can never stand in for a check handed to CI', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'broken', '--json']).code, 0);
  assert.equal(commit(dir, 'broken').status, 0);
  // A results file the change's own tests could have written in the CI job: a pass for the check.
  const subject = pocp(dir, ['verify', 'HEAD', '--json']).json.subject;
  const results = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-results-')), 'results.jsonl');
  fs.writeFileSync(results, `${JSON.stringify({ pocp: 1, kind: 'ci-result', run: CHECK, cwd: null, subject, passed: true, exit: 0, duration_ms: 1 })}\n`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--ci-results', results, '--json']);
  assert.equal(v.code, 1, 'verify ran the check itself and it failed');
  assert.ok(v.json.reruns.some((r) => r.run === CHECK && r.status === 'failed'));
  assert.ok(!v.json.reruns.some((r) => r.run === CHECK && r.evidence === 'ci-result'));
  // Without a re-run, the results file is all there is: still no pass.
  const noRerun = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--ci-results', results, '--json']);
  assert.equal(noRerun.code, 1);
  assert.ok(blocking(noRerun).some((x) => x.code === 'unproven'));
});

test('a pull request that turns hand-offs on for itself is judged by the base: it runs its checks, and CI flags any hand-off', () => {
  const dir = repo({ cfg: {}, defer: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  // Commit 1 turns it on. HEAD's policy doesn't allow it, so this commit's checks run here.
  writeConfig(dir, { guard: { mutants: 0 }, ci: { defer_heavy: true } });
  writeRules(dir, { requirements: [rule(true)] });
  write(dir, 'src/math.js', CHANGED);
  git(dir, 'add', '-A');
  const f1 = pocp(dir, ['fix', '--intent', 'turn on', '--json']);
  assert.equal(f1.code, 0, f1.stderr);
  const p1 = f1.json.actions.find((a) => a.action === 'prove');
  assert.equal(p1.ran, 1, 'the enabling commit runs its own checks');
  assert.equal(p1.handed_to_ci, undefined);
  assert.equal(commit(dir, 'turn on').status, 0);
  // Commit 2, in the same pull request: HEAD now allows it, so the commit hands its check off.
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  const f2 = pocp(dir, ['fix', '--intent', 'break', '--json']);
  assert.equal(f2.json.actions.find((a) => a.action === 'prove').handed_to_ci.length, 1);
  assert.equal(commit(dir, 'break').status, 0);
  // CI judges both by main, which doesn't allow hand-offs: a loosening, and commit 2 is unproven,
  // even with the loosening approved.
  for (const extra of [[], ['--accept-policy-change']]) {
    const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', ...extra, '--json']);
    assert.equal(v.code, 1);
    const codes = blocking(v).map((x) => x.code);
    assert.ok(codes.includes('unproven'), codes.join());
    assert.ok(blocking(v).some((x) => /policy that judges this commit doesn't allow that/.test(x.detail)));
    if (!extra.length) assert.ok(codes.includes('policy_loosened'));
  }
});

test('a pull request that marks its own check "defer" is judged by the base rules', () => {
  const dir = repo({ defer: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { requirements: [rule(true)] });
  write(dir, 'src/math.js', CHANGED);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'defer my check', '--json']);
  assert.equal(f.json.actions.find((a) => a.action === 'prove').ran, 1, 'HEAD\'s rules don\'t defer it, so it runs');
  assert.equal(commit(dir, 'defer my check').status, 0);
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'break', '--json']).json.actions.find((a) => a.action === 'prove').handed_to_ci.length, 1);
  assert.equal(commit(dir, 'break').status, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 1);
  assert.ok(blocking(v).some((x) => x.code === 'policy_loosened' && /now hands its check to CI/.test(x.detail)));
  assert.ok(blocking(v).some((x) => x.code === 'unproven'));
});

test('local mode never hands off: the setting is refused, and a hand-off made elsewhere is no proof here', () => {
  // Refused outright.
  const local = repo({ cfg: {}, defer: true });
  writeConfig(local, { guard: { mutants: 0 }, ci: { mode: 'local', defer_heavy: true } });
  const check = pocp(local, ['rules', 'check']);
  assert.notEqual(check.code, 0);
  assert.match(check.stdout + check.stderr, /ci\.defer_heavy needs ci\.mode "github"/);
  assert.deepEqual(validateConfig(withDefaults({ ci: { mode: 'local', defer_heavy: true } })).filter((p) => /defer_heavy/.test(p)).length, 1);
  // pocp ci off's config change drops it.
  const off = repo();
  assert.equal(setCiMode(off, 'local'), true);
  const cfg = JSON.parse(read(off, '.proof/config.json'));
  assert.equal(cfg.ci.mode, 'local');
  assert.equal(cfg.ci.defer_heavy, undefined);

  // A commit made with hand-offs on lands where the base is in local mode.
  const dir = repo();
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'break', '--json']).json.actions.find((a) => a.action === 'prove').handed_to_ci.length, 1);
  assert.equal(commit(dir, 'break').status, 0);
  git(dir, 'branch', 'feature');
  git(dir, 'checkout', '-q', '-b', 'localmain', 'HEAD~1');
  writeConfig(dir, { guard: { mutants: 0 }, ci: { mode: 'local' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'local mode');
  const v = pocp(dir, ['verify', 'localmain..feature', '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 1);
  assert.ok(blocking(v).some((x) => x.code === 'unproven' && /doesn't allow that/.test(x.detail)), JSON.stringify(blocking(v)));
});

test('--no-defer and POCP_DEFER=off run the check here', () => {
  const dir = repo();
  write(dir, 'src/math.js', CHANGED);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'swap', '--no-defer', '--json']);
  const prove = f.json.actions.find((a) => a.action === 'prove');
  assert.equal(prove.ran, 1);
  assert.equal(prove.handed_to_ci, undefined);
  assert.equal(packetOf(dir, f).packet.state, 'proven');
  assert.equal(commit(dir, 'swap').status, 0);
  assert.match(git(dir, 'log', '-1', '--format=%B'), /proven=1\/1 attested=0\/0\s*$/m);
});

test('a local result always stands: a check that failed here is not handed off', () => {
  const dir = repo();
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'broken', '--no-defer', '--json']);
  assert.equal(f.code, 1, 'it fails here');
  const again = pocp(dir, ['fix', '--json']);
  assert.equal(again.code, 1, 'the failure stands; fix doesn\'t hand it off to get past it');
  assert.equal(pocp(dir, ['gate']).code, 1);
});

test('block mode hands the test guard to CI too, and CI still judges the test change', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { requirements: [{ ...rule(true), globs: ['src/**', 'test/**'] }] });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'guard tests too');
  const start = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${read(dir, 'test/math.check.mjs')}// note\n`);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'note', '--json']);
  assert.equal(f.code, 0, f.stderr);
  const prove = f.json.actions.find((a) => a.action === 'prove');
  assert.equal(prove.ran, 0, 'neither the check nor the guard ran here');
  assert.equal(prove.handed_to_ci.length, 2);
  // Fast mode: the approval CI will ask for is certain, so fix says so now.
  assert.ok(f.json.needs_person.some((x) => x.code === 'test_change' && /pocp-approve-tests/.test(x.next)));
  assert.equal(commit(dir, 'note').status, 0);
  const v = pocp(dir, ['verify', `${start}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 1);
  assert.deepEqual([...new Set(blocking(v).map((x) => x.code))], ['test_change'], 'only the maintainer approval is left: no hand-off passes the test change');
  assert.ok(base);
});

test('unit: turning it on, or marking a check "defer", is a loosening; both sides must allow it', () => {
  const on = withDefaults({ ci: { defer_heavy: true } });
  const off = withDefaults({});
  assert.deepEqual(configWeakening(off, on), ['ci.defer_heavy turned on (checks marked "defer": "ci" run in CI, not at commit)']);
  assert.deepEqual(configWeakening(on, off), []);
  assert.equal(strictConfig(off, on).ci.defer_heavy, false);
  assert.equal(strictConfig(on, off).ci.defer_heavy, false);
  assert.equal(strictConfig(on, on).ci.defer_heavy, true);
  assert.equal(strictConfig(on, withDefaults({ ci: { defer_heavy: true, mode: 'local' } })).ci.defer_heavy, false);

  const plain = rulesWithDefaults({ requirements: [rule(false)] });
  const deferred = rulesWithDefaults({ requirements: [rule(true)] });
  assert.deepEqual(policyWeakening(plain, deferred), ['requirement "math-tests" now hands its check to CI ("defer": "ci")']);
  assert.deepEqual(policyWeakening(deferred, plain), []);
  assert.equal(strictUnion(plain, deferred).requirements[0].defer, undefined, 'the head alone can\'t defer');
  assert.equal(strictUnion(deferred, plain).requirements[0].defer, undefined, 'the base alone can\'t either');
  assert.equal(strictUnion(deferred, deferred).requirements[0].defer, 'ci');

  assert.deepEqual(validateRules({ requirements: [{ ...rule(false), defer: 'later' }] }).length, 1);
  assert.match(validateConfig(withDefaults({ ci: { defer_heavy: true }, verify: { fail_on: ['failed_proof'] } })).join('\n'), /needs verify\.fail_on to include "unproven", "rerun_failed", "test_change"/);
  assert.deepEqual(validateConfig(on), []);

  const pol = (cfg, rules) => ({ config: cfg, rules, hasRules: true });
  assert.equal(handoffPolicy(null, pol(on, deferred)), null, 'no base: nothing is handed off');
  assert.equal(handoffPolicy(pol(off, deferred), pol(on, deferred)), null);
  const both = handoffPolicy(pol(on, deferred), pol(on, deferred));
  const ob = { id: 'o1', kind: 'test', run: CHECK, source: 'rule:math-tests' };
  assert.equal(canHandOff(ob, both), true);
  assert.equal(canHandOff({ ...ob, run: 'other' }, both), false, 'only a check a rule marks "defer"');
  assert.equal(canHandOff({ id: 'o2', kind: 'guard', files: ['t'], mutants: 0, seed: 1 }, both), true, 'block mode is the default');
  assert.equal(canHandOff({ id: 'o2', kind: 'guard', files: ['t'], mutants: 0, seed: 1 }, handoffPolicy(pol(withDefaults({ ci: { defer_heavy: true }, guard: { tests: 'attest' } }), deferred), pol(withDefaults({ ci: { defer_heavy: true }, guard: { tests: 'attest' } }), deferred))), false, 'attest mode runs the guard here');
  // Two rules with the same check: both must defer it.
  const mixed = handoffPolicy(pol(on, rulesWithDefaults({ requirements: [rule(true), { ...rule(false), id: 'again' }] })), pol(on, rulesWithDefaults({ requirements: [rule(true), { ...rule(false), id: 'again' }] })));
  assert.equal(canHandOff(ob, mixed), false);
});

test('unit: a hand-off is never counted as proven, and only a run by verify settles it', () => {
  const now = new Date(0).toISOString();
  const packet = createPacket({ intent: 'x', touches: ['src/**'], obligations: [{ kind: 'test', run: CHECK }], now });
  recordHandoff(packet, 'o1', { by: 'me', subject: 's', now });
  const ev = evaluatePacket(packet, { subject: 's' });
  assert.deepEqual(ev.unproven, ['o1']);
  const handed = applyHandoff(packet, ev, () => true);
  assert.deepEqual(handed.handed_to_ci, ['o1']);
  assert.equal(handed.ok, true);
  assert.equal(handed.counts.proven, 0);
  assert.equal(applyHandoff(packet, ev, () => false).ok, false, 'not allowed by the policy: still unproven');
  assert.equal(applyHandoff(packet, evaluatePacket(packet, { subject: 'other' }), () => true).ok, false, 'a hand-off is for one subject');
  applyEvaluation(packet, handed, { now });
  assert.equal(packet.state, 'open');

  assert.equal(formatTrailer({ id: 'p-1', subject: 'sha256:aa', policy: 'sha256:bb', proven: 0, runnable: 1, attested: 0, manual: 0, handed: ['o1'] }).endsWith('proven=0/1 attested=0/0 handed-to-ci=o1'), true);
  assert.deepEqual(parseTrailerValue('p-1 proven=0/1 handed-to-ci=o1,o2').handed_to_ci, ['o1', 'o2']);

  const ob = packet.obligations[0];
  const d = obligationDigest(ob);
  const list = [{ packet: packet.id, ob }];
  assert.equal(handoffsNotRun(list, []).length, 1);
  assert.equal(handoffsNotRun(list, [{ digest: d, status: 'skipped: passing CI result for this code', evidence: 'ci-result' }]).length, 1);
  assert.equal(handoffsNotRun(list, [{ digest: d, status: 'skipped: signed by an allowed signer', evidence: 'signed' }]).length, 1);
  assert.equal(handoffsNotRun(list, [{ digest: d, status: 'passed' }]).length, 0);
  assert.equal(handoffsNotRun(list, [{ digest: d, status: 'failed' }]).length, 0, 'a failed run is rerun_failed, reported on its own');
});

test('doctor: hand-offs with no required status enforce nothing', () => {
  const dir = repo();
  const r = pocp(dir, ['doctor', '--offline', '--json']);
  const c = r.json.checks.find((x) => x.id === 'defer-heavy');
  assert.equal(c.status, 'problem');
  assert.match(c.why, /enforced only by a required status/);
  writeConfig(dir, { guard: { mutants: 0 }, ci: { defer_heavy: true, required_checks: ['pocp'] } });
  const ok = pocp(dir, ['doctor', '--offline', '--json']).json.checks.find((x) => x.id === 'defer-heavy');
  assert.equal(ok.status, 'ok');
  assert.match(ok.what, /math-tests/);
});

test('a pull request of several commits: every hand-off is run once, at the head, by verify', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', CHANGED);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'one', '--json']).code, 0);
  assert.equal(commit(dir, 'one').status, 0);
  write(dir, 'src/extra.js', 'export const x = 1;\n');
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'two', '--json']).code, 0);
  assert.equal(commit(dir, 'two').status, 0);
  assert.match(git(dir, 'log', '-1', '--format=%B'), /handed-to-ci=o1/);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0, JSON.stringify(blocking(v)));
  assert.equal(v.json.reruns.filter((r) => r.run === CHECK && r.status === 'passed' && !r.evidence).length, 1, 'one run at the head');
  assert.equal(v.json.commits[0].packets[0].evidence.o1, 'handed-to-ci', 'an earlier commit was not run on its own code, and says so');
  // The head breaks the check: the earlier commits' hand-offs don't pass it.
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'three', '--json']).code, 0);
  assert.equal(commit(dir, 'three').status, 0);
  const bad = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(bad.code, 1);
  assert.ok(blocking(bad).some((x) => x.code === 'rerun_failed'));
});

test('an approved loosening of the guard mode can\'t let a handed-off guard pass unchecked', () => {
  const dir = repo();
  writeRules(dir, { requirements: [{ ...rule(true), globs: ['src/**', 'test/**'] }] });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'guard tests too');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${read(dir, 'test/math.check.mjs')}// note\n`);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'note', '--json']).json.actions.find((a) => a.action === 'prove').handed_to_ci.length, 2);
  const trailer = pocp(dir, ['trailer']).stdout.trim().replace(/^Proof-Of-Change: /, '');
  assert.match(trailer, /handed-to-ci=o1,o2|handed-to-ci=o2,o1/);
  // The same commit lowers the guard to attest mode (a loosening a maintainer then approves).
  writeConfig(dir, { guard: { mutants: 0, tests: 'attest' }, ci: { defer_heavy: true } });
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['gate']).code, 1, 'locally, attest mode runs the guard: no hand-off');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `note\n\nProof-Of-Change: ${trailer}`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', `--accept-policy-change=${git(dir, 'rev-parse', 'HEAD')}`, '--json']);
  assert.equal(v.code, 1);
  assert.ok(blocking(v).some((x) => x.code === 'unproven' && /o2/.test(x.detail)), JSON.stringify(blocking(v)));
});

test('a head that is a merge ("Update branch"): hand-offs still run, and a break still fails', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'src/math.js', CHANGED);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'swap', '--json']).code, 0);
  assert.equal(commit(dir, 'swap').status, 0);
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'README.md', '# sample\n\nmore\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'main moves');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-edit', 'main');
  const v = pocp(dir, ['verify', 'main..feature', '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0, JSON.stringify(blocking(v)));
  assert.ok(v.json.reruns.some((r) => r.run === CHECK && r.status === 'passed' && !r.evidence));
  // Break it on the branch, then update from main again: the head is a merge once more.
  write(dir, 'src/math.js', BROKEN);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'break', '--json']).code, 0);
  assert.equal(commit(dir, 'break').status, 0);
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'README.md', '# sample\n\nmore\nagain\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'main moves again');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-edit', 'main');
  const bad = pocp(dir, ['verify', 'main..feature', '--rerun', '--require-coverage', '--json']);
  assert.equal(bad.code, 1);
  assert.ok(blocking(bad).some((x) => x.code === 'rerun_failed'), JSON.stringify(blocking(bad)));
  assert.ok(base);
});

test('the suite ignores a POCP_DEFER=off from the shell that runs it (pocp fix --no-defer sets it for its checks)', () => {
  // helpers.js removes it on import; with it left in, every hand-off test above sees no hand-off.
  assert.equal(process.env.POCP_DEFER, undefined);
});
