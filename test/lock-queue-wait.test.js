// A pocp waiting for the repository lock doesn't run out of time while the lock's holder is
// itself waiting in the machine-wide queue for a check slot: that wait isn't this repository's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TEST_TMP } from './helpers.js';
import { withLockAsync } from '../src/store.js';

let n = 0;
const lockFile = () => {
  const dir = path.join(TEST_TMP, `lockwait-${process.pid}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'pocp.lock');
  // Held by this (live) process, so it is never broken as abandoned.
  fs.writeFileSync(f, `${process.pid} feedfacecafebeef`);
  return f;
};

test('the lock wait gives up at its limit when the holder is working', async () => {
  const f = lockFile();
  await assert.rejects(withLockAsync(f, async () => 'ran', { waitMs: 50 }), /another pocp process holds/);
  await assert.rejects(withLockAsync(f, async () => 'ran', { waitMs: 50, stillWaiting: () => false }), /another pocp process holds/);
});

test('the lock wait keeps going while the holder waits in the machine queue, then takes the lock', async () => {
  const f = lockFile();
  let asked = 0;
  // The holder is queued; after a while it finishes and releases the lock.
  setTimeout(() => fs.rmSync(f, { force: true }), 400);
  const r = await withLockAsync(f, async () => 'ran', { waitMs: 50, stillWaiting: (pid) => { asked++; return pid === process.pid; } });
  assert.equal(r, 'ran');
  assert.ok(asked >= 1, 'the holder was checked once the limit passed');
});

test('a stillWaiting that throws leaves the limit in force', async () => {
  const f = lockFile();
  await assert.rejects(withLockAsync(f, async () => 'ran', { waitMs: 50, stillWaiting: () => { throw new Error('boom'); } }), /another pocp process holds/);
});
