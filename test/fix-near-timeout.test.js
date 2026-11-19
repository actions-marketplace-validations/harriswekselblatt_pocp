// pocp fix notes a check that passed but used more than half its time limit: on a busy machine
// it is the next to time out, and a timeout costs a whole run with nothing learned. Advice only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearTimeout } from '../src/fix.js';

const engine = (obligations) => ({ loadPacket: () => ({ obligations }) });
const cfg = { run: { timeout_ms: 600_000 } };
const one = (ob, run) => nearTimeout(engine([ob]), [{ id: 'p-1', runs: [{ obligation: ob.id, passed: true, ...run }] }], cfg);

test('over half the config limit: one note, in the limit\'s unit, naming run.timeout_ms', () => {
  const notes = one({ id: 'o1' }, { duration_ms: 314_000 });
  assert.equal(notes.length, 1);
  assert.equal(notes[0], 'p-1: o1 took 5.2 min of its 10 min limit; under load it may time out. Consider raising run.timeout_ms in .proof/config.json.');
});

test("a check's own timeout_ms is the limit, and where it is set is named", () => {
  assert.match(one({ id: 'o1', timeout_ms: 20_000, source: 'rule:unit-tests' }, { duration_ms: 15_000 })[0], /o1 took 15s of its 20s limit; .* raising the check's timeout_ms \(in rule unit-tests\)\./);
  assert.match(one({ id: 'o1', timeout_ms: 20_000, source: 'author' }, { duration_ms: 15_000 })[0], /timeout_ms \(in packet p-1\)\./);
});

test('no rounding up to the limit: 270s of 300s reads as such', () => {
  assert.match(one({ id: 'o1', timeout_ms: 300_000 }, { duration_ms: 270_000 })[0], /took 4\.5 min of its 5 min limit/);
});

test('no note at or under half the limit, for a failure, a skip, a reuse or a guard', () => {
  const runs = [
    { obligation: 'a', passed: true, duration_ms: 300_000 },
    { obligation: 'b', passed: false, duration_ms: 500_000 },
    { obligation: 'c', skipped: 'already proven', duration_ms: 500_000 },
    { obligation: 'd', passed: true, reused_from: 'p-0', duration_ms: 500_000 },
    { obligation: 'e', passed: true, guard: 'needs-review', duration_ms: 500_000 },
  ];
  assert.deepEqual(nearTimeout(engine(runs.map((r) => ({ id: r.obligation }))), [{ id: 'p-1', runs }], cfg), []);
});
