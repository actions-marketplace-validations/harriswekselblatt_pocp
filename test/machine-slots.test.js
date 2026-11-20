// The machine-wide limit on pocp processes running checks at once (src/machine-slots.js).
// Several worktrees each running a full test suite at once made every check slower than its
// time limit; with the limit they take turns. These tests pin: two runs queue instead of
// overlapping, in order; a crashed holder's slot is reclaimed; time spent waiting never counts
// toward a check's time limit; a pocp inside a check never waits (no deadlock); CI and a
// broken cache folder run uncapped instead of failing.
//
// Nothing here races a fixed time window: a holder keeps its slot until the test writes a
// release file, and the test releases it only once the waiter is seen in the queue. Under a
// loaded machine, the tests just take longer.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { BIN, TEST_TMP, git, read, sampleRepo, write } from './helpers.js';
import { DEFAULT_LIMIT, STALE_MS, _resetForTests, acquireMachineSlot, keepMachineSlot, machineSettings, machineStatus, slotsDir } from '../src/machine-slots.js';
import { workerEnv } from '../src/isolate.js';

const SLOTS = pathToFileURL(path.join(path.dirname(BIN), '..', 'src', 'machine-slots.js')).href;
let n = 0;
const freshDir = () => fs.mkdtempSync(path.join(TEST_TMP, `slots-${n++}-`));
const capped = (dir, limit = 1, extra = {}) => ({ ...process.env, POCP_MACHINE_CHECKS: String(limit), POCP_MACHINE_DIR: dir, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

// A separate pocp-like process: takes a slot, logs start, holds it until `hold` (a number of
// ms, or a file to wait for) is over, logs end, releases it and exits.
const DRIVER = `
import fs from 'node:fs';
import { acquireMachineSlot } from ${JSON.stringify(SLOTS)};
const [log, hold, name] = process.argv.slice(-3);
const s = await acquireMachineSlot({ label: name, repo: 'r' });
fs.appendFileSync(log, JSON.stringify({ name, ev: 'start', t: Date.now(), queued: s.queued_ms }) + '\\n');
if (/^\\d+$/.test(hold)) await new Promise((r) => setTimeout(r, Number(hold)));
else while (!fs.existsSync(hold)) await new Promise((r) => setTimeout(r, 20));
fs.appendFileSync(log, JSON.stringify({ name, ev: 'end', t: Date.now() }) + '\\n');
s.release();
`;

function run(cmd, args, { env, cwd } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const driver = (env, log, hold, name) => run(process.execPath, ['--input-type=module', '-e', DRIVER, '--', log, String(hold), name], { env });

const tickets = (dir) => (fs.existsSync(path.join(dir, 'queue')) ? fs.readdirSync(path.join(dir, 'queue')).filter((f) => f.endsWith('.json')).length : 0);
const slotFiles = (dir) => fs.readdirSync(dir).filter((f) => /^slot-\d+\.json$/.test(f));

/**
 * A holder in its own process (not this one: a pocp whose parent holds a slot counts as running
 * inside that holder's check, and rightly doesn't wait). Resolves once it holds the slot, with
 * release() and done.
 */
async function holdSlot(env, log, name) {
  const releaseFile = path.join(env.POCP_MACHINE_DIR, `release-${n++}`);
  const done = driver(env, log, releaseFile, name);
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(`"name":${JSON.stringify(name)},"ev":"start"`), `${name} to take a slot`);
  return { done, release: () => fs.writeFileSync(releaseFile, '') };
}

function intervals(log) {
  const ev = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const by = {};
  for (const e of ev) (by[e.name] ||= {})[e.ev] = e.t;
  for (const e of ev) if (e.ev === 'start') by[e.name].queued = e.queued;
  return by;
}
/** The most intervals open at once. */
function peak(by) {
  const pts = Object.values(by).flatMap((x) => [[x.start, 1], [x.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of pts) max = Math.max(max, (cur += d));
  return max;
}

test('settings: default 1, then the limit file, then POCP_MACHINE_CHECKS; off, CI and nested', () => {
  assert.equal(DEFAULT_LIMIT, 1);
  const dir = freshDir();
  assert.deepEqual(machineSettings({ POCP_MACHINE_DIR: dir }), { limit: 1, dir, why: null, warning: null, from: 'default' });
  // The account-wide setting, in the slots folder.
  write(dir, 'limit', '3\n');
  assert.equal(machineSettings({ POCP_MACHINE_DIR: dir }).limit, 3);
  assert.equal(machineSettings({ POCP_MACHINE_DIR: dir }).from, path.join(dir, 'limit'));
  write(dir, 'limit', 'off\n');
  assert.equal(machineSettings({ POCP_MACHINE_DIR: dir }).why, 'off');
  write(dir, 'limit', 'lots\n');
  assert.equal(machineSettings({ POCP_MACHINE_DIR: dir }).limit, 1);
  assert.match(machineSettings({ POCP_MACHINE_DIR: dir }).warning, /not a number or "off", so the default \(1\) applies/);
  // The variable wins over the file.
  write(dir, 'limit', '3\n');
  assert.equal(machineSettings({ POCP_MACHINE_CHECKS: '2', POCP_MACHINE_DIR: dir }).limit, 2);
  assert.equal(machineSettings({ POCP_MACHINE_CHECKS: 'off', POCP_MACHINE_DIR: dir }).why, 'off');
  assert.equal(machineSettings({ POCP_MACHINE_CHECKS: '0', POCP_MACHINE_DIR: dir }).limit, 0);
  const bad = machineSettings({ POCP_MACHINE_CHECKS: 'lots', POCP_MACHINE_DIR: dir });
  assert.equal(bad.limit, 1);
  assert.match(bad.warning, /POCP_MACHINE_CHECKS="lots" is not a number/);
  // CI has its machine to itself: off, unless the variable is set.
  assert.equal(machineSettings({ CI: 'true', POCP_MACHINE_DIR: dir }).why, 'ci');
  assert.equal(machineSettings({ CI: 'false', POCP_MACHINE_DIR: dir }).limit, 3);
  assert.equal(machineSettings({ CI: 'true', POCP_MACHINE_CHECKS: '1', POCP_MACHINE_DIR: dir }).limit, 1);
  // Inside a check that holds a slot: never waits, whatever the limit says.
  assert.equal(machineSettings({ POCP_MACHINE_SLOT: '1', POCP_MACHINE_CHECKS: '1' }).why, 'nested');
});

test('the slots folder: POCP_MACHINE_DIR, XDG_CACHE_HOME, then the platform cache folder', () => {
  assert.equal(slotsDir({ POCP_MACHINE_DIR: '/a/b' }), '/a/b');
  assert.equal(slotsDir({ XDG_CACHE_HOME: '/xdg' }, { platform: 'darwin', home: '/h' }), '/xdg/pocp/check-slots');
  assert.equal(slotsDir({ XDG_CACHE_HOME: 'relative' }, { platform: 'linux', home: '/h' }), '/h/.cache/pocp/check-slots');
  assert.equal(slotsDir({}, { platform: 'darwin', home: '/h' }), '/h/Library/Caches/pocp/check-slots');
  assert.equal(slotsDir({}, { platform: 'linux', home: '/h' }), '/h/.cache/pocp/check-slots');
  assert.equal(slotsDir({}, { platform: 'linux', home: null }), null);
});

test('an isolated check keeps the marker, so a pocp it starts never waits for its own verify', () => {
  assert.equal(workerEnv({ PATH: '/bin', POCP_MACHINE_SLOT: '1' }, [], {}).POCP_MACHINE_SLOT, '1');
});

test('two pocp processes with a limit of 1 take turns instead of overlapping', async () => {
  const dir = freshDir();
  const log = path.join(dir, 'log.jsonl');
  await Promise.all([driver(capped(dir), log, 800, 'a'), driver(capped(dir), log, 800, 'b')]);
  assert.equal(peak(intervals(log)), 1, fs.readFileSync(log, 'utf8'));
  // Released on exit: nothing is left holding a slot.
  assert.deepEqual(slotFiles(dir), []);
});

test('with a limit of 2, three processes run at most two at a time', async () => {
  const dir = freshDir();
  const log = path.join(dir, 'log.jsonl');
  await Promise.all(['a', 'b', 'c'].map((x) => driver(capped(dir, 2), log, 800, x)));
  assert.ok(peak(intervals(log)) <= 2, fs.readFileSync(log, 'utf8'));
});

test('a waiter says who it waits for, and starts once the holder is done', async () => {
  const dir = freshDir();
  const log = path.join(dir, 'log.jsonl');
  const holder = await holdSlot(capped(dir), log, 'npm test');
  const waiter = driver(capped(dir), log, 10, 'b');
  await until(() => tickets(dir) === 1, 'the waiter to queue');
  holder.release();
  const r = await waiter;
  await holder.done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /waiting for 1 other POCP check on this machine \(limit 1, set by POCP_MACHINE_CHECKS\)/);
  assert.match(r.stderr, /running: "npm test" in r \(pid \d+/);
  assert.match(r.stderr, /got a check slot after/);
  const by = intervals(log);
  assert.ok(by.b.start >= by['npm test'].end, JSON.stringify(by));
});

test('waiters are served in the order they arrived', async () => {
  const dir = freshDir();
  const log = path.join(dir, 'log.jsonl');
  const holder = await holdSlot(capped(dir), log, 'holder');
  const first = driver(capped(dir), log, 10, 'first');
  await until(() => tickets(dir) === 1, 'the first waiter to queue');
  const second = driver(capped(dir), log, 10, 'second');
  await until(() => tickets(dir) === 2, 'the second waiter to queue');
  holder.release();
  await Promise.all([holder.done, first, second]);
  const by = intervals(log);
  assert.ok(by.first.start < by.second.start, JSON.stringify(by));
  assert.equal(peak(by), 1);
});

test('a slot left by a crashed pocp is reclaimed: dead pid, or no heartbeat while the pid lives on', async () => {
  const dir = freshDir();
  const dead = spawnSync('true').pid;
  write(dir, 'slot-0.json', JSON.stringify({ pid: dead, token: 'x', since: Date.now() }));
  let r = await driver(capped(dir), path.join(dir, 'log1.jsonl'), 10, 'a');
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /waiting/, 'a dead holder does not block');
  // A live pid that stopped touching its slot (a reused pid after a crash): reclaimed once stale.
  write(dir, 'slot-0.json', JSON.stringify({ pid: process.pid, token: 'y', since: Date.now() }));
  const old = new Date(Date.now() - STALE_MS - 60_000);
  fs.utimesSync(path.join(dir, 'slot-0.json'), old, old);
  r = await driver(capped(dir), path.join(dir, 'log2.jsonl'), 10, 'b');
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /waiting/, 'a silent holder does not block');
  // A crashed waiter's ticket doesn't hold up the queue either.
  write(dir, 'queue/000000000000001-00000001-dead.json', JSON.stringify({ pid: dead, limit: 1, since: 1 }));
  r = await driver(capped(dir), path.join(dir, 'log3.jsonl'), 10, 'c');
  assert.doesNotMatch(r.stderr, /waiting/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'queue')), []);
});

test('one process takes one slot for all its checks at once, and keeps it briefly for the next', async () => {
  const dir = freshDir();
  const env = capped(dir);
  try {
    const [a, b] = await Promise.all([acquireMachineSlot({ env }), acquireMachineSlot({ env })]);
    assert.deepEqual(slotFiles(dir), ['slot-0.json']);
    a.release();
    b.release();
    // The next check of the same process gets the slot without waiting.
    const c = await acquireMachineSlot({ env });
    assert.ok(c.queued_ms < 100);
    assert.equal(machineStatus(env).running.length, 1);
    c.release();
  } finally {
    _resetForTests();
  }
  assert.deepEqual(slotFiles(dir), []);
});

test('a prove keeps its slot between checks, and takes none if it runs nothing', async () => {
  const dir = freshDir();
  const env = capped(dir);
  try {
    const idle = keepMachineSlot();
    idle.done();
    assert.deepEqual(slotFiles(dir), [], 'keeping takes no slot by itself');
    const keep = keepMachineSlot();
    const a = await acquireMachineSlot({ env });
    a.release();
    await sleep(3_500); // longer than the linger after a check
    assert.deepEqual(slotFiles(dir), ['slot-0.json'], 'still held while the prove goes on');
    keep.done();
    await sleep(3_500);
    assert.deepEqual(slotFiles(dir), [], 'let go once the prove is done and the linger is over');
  } finally {
    _resetForTests();
  }
});

test('CI, an explicit off, and an unusable folder run uncapped (never a failed check)', async () => {
  const dir = freshDir();
  const env = capped(dir);
  const held = await holdSlot(env, path.join(dir, 'holder.jsonl'), 'holder');
  try {
    for (const extra of [{ CI: 'true', POCP_MACHINE_CHECKS: '' }, { POCP_MACHINE_CHECKS: 'off' }]) {
      const r = await driver({ ...env, ...extra }, path.join(dir, `log-${n++}.jsonl`), 10, 'x');
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /waiting/, JSON.stringify(extra));
    }
    write(dir, 'not-a-folder', 'x');
    const r = await driver({ ...env, POCP_MACHINE_DIR: path.join(dir, 'not-a-folder', 'slots') }, path.join(dir, 'log-broken.jsonl'), 10, 'x');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /checks run without it/);
  } finally {
    held.release();
    await held.done;
  }
});

// End to end through pocp fix.
const STAMP = path.join(TEST_TMP, 'stamp-check.mjs');
fs.writeFileSync(STAMP, "import fs from 'node:fs';\nconst [log, ms] = process.argv.slice(2);\nfs.appendFileSync(log, `start ${Date.now()}\\n`);\nawait new Promise((r) => setTimeout(r, Number(ms)));\nfs.appendFileSync(log, `end ${Date.now()}\\n`);\n");

function repoWithCheck(run, timeoutMs = 120_000) {
  const dir = sampleRepo({
    deep: false,
    rules: { triggers: { globs: [] }, requirements: [{ id: 'check', glob: 'src/**', obligation: { kind: 'test', run, timeout_ms: timeoutMs }, source: 'author' }] },
  });
  write(dir, 'src/math.js', `${read(dir, 'src/math.js')}// touched\n`);
  git(dir, 'add', '-A');
  return dir;
}
const proofOf = (dir, json) => {
  const id = json.actions.find((a) => a.action === 'open').packet;
  return JSON.parse(read(dir, `.proof/packets/${id}.json`)).proofs.find((p) => p.obligation !== undefined);
};

test('time spent waiting for a slot does not count toward the check\'s time limit', { timeout: 180_000 }, async () => {
  const slots = freshDir();
  const env = capped(slots);
  const log = path.join(slots, 'check.log');
  // The check needs about 0.3 s of its 10 s limit; it waits in line for longer than that limit.
  const LIMIT = 10_000;
  const dir = repoWithCheck(`node ${STAMP} ${log} 300`, LIMIT);
  const holderLog = path.join(slots, 'holder.jsonl');
  const holder = await holdSlot(env, holderLog, 'npm test');
  const fix = run(process.execPath, [BIN, 'fix', '--intent', 'touch math', '--json'], { cwd: dir, env });
  await until(() => tickets(slots) === 1, 'pocp fix to queue', 120_000);
  const queuedAt = Date.now();
  await sleep(LIMIT + 1_000);
  assert.equal(fs.existsSync(log), false, 'the check has not started while the slot is held');
  holder.release();
  const r = await fix;
  await holder.done;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /waiting for 1 other POCP check on this machine/);
  assert.match(r.stderr, /running: "npm test" in r/);
  assert.match(r.stderr, /got a check slot after/);
  const proof = proofOf(dir, JSON.parse(r.stdout));
  assert.equal(proof.passed, true, JSON.stringify(proof));
  assert.equal(proof.timed_out, false);
  assert.ok(proof.duration_ms < LIMIT, `duration_ms (${proof.duration_ms}) leaves out the wait`);
  const heldUntil = intervals(holderLog)['npm test'].end;
  assert.ok(Number(fs.readFileSync(log, 'utf8').split('\n')[0].split(' ')[1]) >= heldUntil, 'the check started after the holder was done');
  assert.ok(heldUntil - queuedAt > LIMIT, 'it waited longer than its own time limit');
  assert.ok(Date.parse(proof.started_at) >= heldUntil - 1_000, 'started_at is when the check started, after the wait');
});

test('a pocp run inside a check never waits for a slot: no deadlock at a limit of 1', { timeout: 300_000 }, async () => {
  const slots = freshDir();
  for (const scrub of [false, true]) {
    const inner = repoWithCheck(`node ${STAMP} ${path.join(slots, `inner-${scrub}.log`)} 10`);
    // The outer check runs pocp fix in another repository; with `scrub`, it drops the marker
    // from the environment, as a test harness with a clean environment would.
    const nested = `${scrub ? 'env -u POCP_MACHINE_SLOT ' : ''}${process.execPath} ${BIN} fix --intent inner --json`;
    const outer = repoWithCheck(`cd ${inner} && ${nested}`, 240_000);
    const r = await run(process.execPath, [BIN, 'fix', '--intent', 'outer', '--json'], { cwd: outer, env: capped(slots) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(proofOf(outer, JSON.parse(r.stdout)).passed, true, `scrub=${scrub}`);
    assert.ok(fs.existsSync(path.join(slots, `inner-${scrub}.log`)), 'the nested check ran');
  }
});

test('two repositories proving at once run their checks one at a time', { timeout: 300_000 }, async () => {
  const slots = freshDir();
  const log = path.join(slots, 'both.log');
  const a = repoWithCheck(`node ${STAMP} ${log} 1000`);
  const b = repoWithCheck(`node ${STAMP} ${log} 1000`);
  const [ra, rb] = await Promise.all([a, b].map((cwd) => run(process.execPath, [BIN, 'fix', '--intent', 'x', '--json'], { cwd, env: capped(slots) })));
  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(lines, ['start', 'end', 'start', 'end'], 'never two checks at once');
  // Without the limit the same two fixes overlap, so the order above is the limit's doing.
  // Each check waits (up to 120 s) until both have started, so they overlap however slow the
  // machine is.
  const log2 = path.join(slots, 'free.log');
  const meet = path.join(TEST_TMP, 'meet-check.mjs');
  fs.writeFileSync(meet, "import fs from 'node:fs';\nconst log = process.argv[2];\nfs.appendFileSync(log, 'start\\n');\nconst until = Date.now() + 120000;\nwhile (Date.now() < until && fs.readFileSync(log, 'utf8').split('start').length < 3) await new Promise((r) => setTimeout(r, 50));\nfs.appendFileSync(log, 'end\\n');\n");
  const c = repoWithCheck(`node ${meet} ${log2}`, 200_000);
  const d = repoWithCheck(`node ${meet} ${log2}`, 200_000);
  await Promise.all([c, d].map((cwd) => run(process.execPath, [BIN, 'fix', '--intent', 'x', '--json'], { cwd, env: capped(slots, 'off') })));
  assert.deepEqual(fs.readFileSync(log2, 'utf8').trim().split('\n'), ['start', 'start', 'end', 'end'], 'uncapped, the two checks overlap');
});
