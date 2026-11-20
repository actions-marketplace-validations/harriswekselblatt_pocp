// Temporary folders left by killed processes are removed by the next run, and only those: a
// test process stopped with a signal removes its own folder; one killed with SIGKILL (which can't
// be caught) leaves it, and the next test run's sweep removes it; a live run's folder is never
// touched; a pocp killed mid-proof leaves its copy of the repository until the next pocp run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, TEST_TMP, git, pocp, sampleRepo, write } from './helpers.js';
import { OWNER, ownedPrefix, ownerOf, processStarts, sweepDue, sweepStale } from '../src/temp-sweep.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = path.join(here, 'helpers.js');
const SWEEP = path.join(here, '..', 'src', 'temp-sweep.js');

let n = 0;
/** A fresh folder standing in for the machine's temp folder. */
const freshBase = () => {
  const dir = path.join(TEST_TMP, `base-${n++}`);
  fs.mkdirSync(dir);
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const exited = (child) => (child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise((r) => child.once('exit', r)));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const mkdirs = (base, ...names) => names.map((name) => {
  const d = path.join(base, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'file'), 'x');
  return d;
});
const daysAgo = (p, days) => {
  const t = Date.now() / 1000 - days * 86400;
  fs.utimesSync(p, t, t);
};

test('a folder name records its owner, and only pocp names with that shape parse', () => {
  assert.match(ownedPrefix('copy'), new RegExp(`^pocp-copy-${process.pid}-[0-9a-z]+-$`));
  const owner = ownerOf(`${ownedPrefix('suite')}AbC123`, ['suite']);
  assert.equal(`${owner.pid}-${owner.start.toString(36)}`, OWNER);
  // The recorded start is the one ps reports, so a sweep recognises this process as the owner.
  const fromPs = processStarts([process.pid]).get(process.pid);
  assert.ok(Math.abs(fromPs - owner.start) <= 2, `recorded ${owner.start}, ps says ${fromPs}`);
  for (const name of [`${ownedPrefix('suite')}AbC12`, `${ownedPrefix('suite')}AbC123.log`, `${ownedPrefix('other')}AbC123`, 'pocp-suite-AbC123', `x${ownedPrefix('suite')}AbC123`]) {
    assert.equal(ownerOf(name, ['suite']), null, name);
  }
});

test('the sweep removes folders whose owner is gone and keeps live ones', async () => {
  const base = freshBase();
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await waitFor('the live process to show in ps', () => processStarts([live.pid])?.get(live.pid));
    const start = processStarts([live.pid]).get(live.pid);
    const [dead, mine, other, reused] = mkdirs(base,
      `pocp-suite-${deadPid()}-${(Math.floor(Date.now() / 1000) - 5).toString(36)}-dead01`,
      `${ownedPrefix('suite')}mine01`,
      `pocp-suite-${live.pid}-${start.toString(36)}-live01`,
      // The live process's ID, but an owner that started an hour earlier: the ID was reused.
      `pocp-suite-${live.pid}-${(start - 3600).toString(36)}-reuse1`);
    const r = sweepStale(base, { kinds: ['suite'] });
    assert.deepEqual(r.removed.sort(), [path.basename(dead), path.basename(reused)].sort());
    assert.equal(r.live, 2);
    for (const d of [mine, other]) assert.ok(fs.existsSync(path.join(d, 'file')), `${d} kept, with its files`);
    for (const d of [dead, reused]) assert.ok(!fs.existsSync(d), `${d} removed`);
  } finally {
    live.kill('SIGKILL');
  }
});

test('the sweep touches nothing but its own kinds of folder, directly in the temp folder', () => {
  const base = freshBase();
  const outside = freshBase();
  fs.writeFileSync(path.join(outside, 'precious'), 'x');
  const stale = `${deadPid()}-${(Math.floor(Date.now() / 1000) - 5).toString(36)}`;
  const [otherKind, notPocp, nested] = mkdirs(base, `pocp-other-${stale}-AbC123`, `tool-suite-${stale}-AbC123`, 'holder');
  const deep = mkdirs(nested, `pocp-suite-${stale}-deep01`)[0];
  fs.writeFileSync(path.join(base, `pocp-suite-${stale}-file01`), 'a file, not a folder');
  fs.symlinkSync(outside, path.join(base, `pocp-suite-${stale}-link01`));
  fs.symlinkSync(outside, path.join(base, 'pocp-suite-link02'));
  daysAgo(path.join(base, 'pocp-suite-link02'), 3);

  const r = sweepStale(base, { kinds: ['suite'], legacyKinds: ['suite'] });
  assert.deepEqual(r.removed, []);
  for (const p of [otherKind, notPocp, deep, path.join(base, `pocp-suite-${stale}-file01`), path.join(base, `pocp-suite-${stale}-link01`)]) {
    assert.ok(fs.existsSync(p), `${p} untouched`);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'x', 'a link is never followed');
});

test('a folder from before owners were recorded goes only once nothing in it changed for a day', () => {
  const base = freshBase();
  const [old, young, busy] = mkdirs(base, 'pocp-suite-old001', 'pocp-adopt-young1', 'pocp-suite-busy01');
  for (const d of [old, busy]) {
    daysAgo(path.join(d, 'file'), 2);
    daysAgo(d, 2);
  }
  fs.writeFileSync(path.join(busy, 'new'), 'written by a run that is still going');
  daysAgo(busy, 2);
  const r = sweepStale(base, { kinds: ['suite'], legacyKinds: ['suite', 'adopt'] });
  assert.deepEqual(r.removed, ['pocp-suite-old001']);
  assert.equal(r.young, 2);
  assert.ok(fs.existsSync(young) && fs.existsSync(busy));
});

test('if ps cannot say when a running process started, its folders are kept', () => {
  const base = freshBase();
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    // An owner ID that is running, with a start time that doesn't match: removed only if ps confirms.
    const name = `pocp-suite-${live.pid}-${(Math.floor(Date.now() / 1000) - 7200).toString(36)}-noPs01`;
    mkdirs(base, name);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { sweepStale } from ${JSON.stringify(SWEEP)}; console.log(JSON.stringify(sweepStale(process.argv[1], { kinds: ['suite'] })));`, base],
    { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).removed, []);
    assert.ok(fs.existsSync(path.join(base, name)));
  } finally {
    live.kill('SIGKILL');
  }
});

test('sweeps are shared: one per stamp per period', () => {
  const stamp = path.join(freshBase(), 'stamps', 'temp-sweep');
  assert.equal(sweepDue(stamp, 60_000), true);
  assert.equal(sweepDue(stamp, 60_000), false);
  assert.equal(sweepDue(stamp, 60_000, Date.now() + 61_000), true);
});

test('when several runs start at once, one of them sweeps', async () => {
  const dir = freshBase();
  const stamp = path.join(dir, 'temp-sweep');
  fs.writeFileSync(stamp, 'old');
  daysAgo(stamp, 1);
  const go = path.join(dir, 'go');
  const code = `import fs from 'node:fs'; import { sweepDue } from ${JSON.stringify(SWEEP)};
    while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
    console.log(sweepDue(${JSON.stringify(stamp)}, 60_000));`;
  const kids = Array.from({ length: 6 }, () => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.out = '';
    c.stdout.on('data', (b) => { c.out += b; });
    return c;
  });
  await sleep(500);
  fs.writeFileSync(go, '');
  await Promise.all(kids.map(exited));
  assert.deepEqual(kids.map((c) => c.out.trim()).sort(), ['false', 'false', 'false', 'false', 'false', 'true']);
});

// A test file using the helpers, run as its own process the way `node --test` runs each file.
function suiteChild(box, { hang = false, stamps }) {
  const file = path.join(box, `child-${n++}.test.mjs`);
  const ready = `${file}.ready`;
  fs.writeFileSync(file, [
    "import { test } from 'node:test';",
    "import fs from 'node:fs';",
    `import { tmpRepo } from ${JSON.stringify(HELPERS)};`,
    "test('makes a repository', async () => {",
    '  tmpRepo();',
    `  fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    hang ? '  await new Promise(() => setInterval(() => {}, 1000));' : '',
    '});',
    '',
  ].join('\n'));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawn(process.execPath, [file], { cwd: box, stdio: 'ignore', env: { ...env, TMPDIR: path.join(box, 'tmp'), POCP_SWEEP_DIR: path.join(box, stamps) } });
  child.ready = () => fs.existsSync(ready);
  return child;
}
const suiteFolders = (box) => fs.readdirSync(path.join(box, 'tmp')).filter((f) => f.startsWith('pocp-suite-'));

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`a test process stopped with ${sig} removes its temporary folders`, async () => {
    const box = freshBase();
    fs.mkdirSync(path.join(box, 'tmp'));
    const child = suiteChild(box, { hang: true, stamps: 's1' });
    try {
      await waitFor('the child to make its repository', () => child.ready());
      assert.equal(suiteFolders(box).length, 1);
      child.kill(sig);
      await exited(child);
      assert.equal(child.signalCode, sig, 'it still ends by the signal');
      assert.deepEqual(fs.readdirSync(path.join(box, 'tmp')), []);
    } finally {
      child.kill('SIGKILL');
    }
  });
}

test('a test process killed with SIGKILL leaves its folder, and the next run removes it; a live run\'s folder survives', async () => {
  const box = freshBase();
  fs.mkdirSync(path.join(box, 'tmp'));
  const killed = suiteChild(box, { hang: true, stamps: 's1' });
  const running = suiteChild(box, { hang: true, stamps: 's2' });
  try {
    await waitFor('both children to make their repositories', () => killed.ready() && running.ready());
    const [left] = suiteFolders(box).filter((f) => ownerOf(f, ['suite'])?.pid === killed.pid);
    const [live] = suiteFolders(box).filter((f) => ownerOf(f, ['suite'])?.pid === running.pid);
    killed.kill('SIGKILL');
    await exited(killed);
    assert.ok(fs.readdirSync(path.join(box, 'tmp', left)).length > 0, 'SIGKILL left the whole folder behind');

    const next = suiteChild(box, { stamps: 's3' });
    await exited(next);
    assert.equal(next.exitCode, 0);
    assert.deepEqual(suiteFolders(box), [live], 'the dead run\'s folder is gone, the live run\'s is not');
    assert.ok(fs.readdirSync(path.join(box, 'tmp', live)).length > 0, 'and the live one still holds its files');
  } finally {
    killed.kill('SIGKILL');
    running.kill('SIGTERM');
    await exited(running);
  }
  assert.deepEqual(fs.readdirSync(path.join(box, 'tmp')), []);
});

test('a pocp killed with SIGKILL mid-proof leaves its copy, and the next pocp run removes it; a live one\'s copy survives', async () => {
  const box = freshBase();
  const tmp = path.join(box, 'tmp');
  fs.mkdirSync(tmp);
  const env = (stamps) => ({ TMPDIR: tmp, POCP_SWEEP_DIR: path.join(box, stamps) });
  const copies = () => fs.readdirSync(tmp).filter((f) => /^pocp-(snap|tree|copy)-/.test(f));
  const change = (dir) => {
    write(dir, 'src/math.js', 'export function add(a, b) {\n  return b + a;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
    git(dir, 'add', '-A');
  };

  // A proof whose check never ends, so pocp is mid-proof with its copy in the temp folder.
  const start = (stamps) => {
    const hung = sampleRepo({ deep: false, rules: { requirements: [{ id: 'hang', glob: 'src/**', obligation: { kind: 'test', run: 'node -e "setInterval(() => {}, 1000)"' }, source: 'author' }] } });
    change(hung);
    return spawn(process.execPath, [BIN, 'fix', '--intent', 'x', '--mode', 'snapshot'], { cwd: hung, stdio: 'ignore', env: { ...process.env, ...env(stamps) } });
  };
  const doomed = start('s1');
  const alive = start('s2');
  try {
    const owned = (child) => () => copies().find((f) => ownerOf(f, ['snap', 'tree', 'copy'])?.pid === child.pid);
    const left = await waitFor('the first pocp\'s snapshot', owned(doomed));
    const kept = await waitFor('the second pocp\'s snapshot', owned(alive));
    doomed.kill('SIGKILL');
    await exited(doomed);
    assert.ok(fs.existsSync(path.join(tmp, left)), 'SIGKILL left the snapshot behind');

    const other = sampleRepo({ deep: false });
    change(other);
    const r = pocp(other, ['fix', '--intent', 'y', '--mode', 'snapshot'], { env: env('s3') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(copies(), [kept], 'the killed pocp\'s snapshot is gone, the live one\'s is not');
  } finally {
    doomed.kill('SIGKILL');
    alive.kill('SIGTERM');
    await exited(alive);
  }
  await waitFor('the live pocp to remove its snapshot when stopped', () => copies().length === 0, 30_000);
});
