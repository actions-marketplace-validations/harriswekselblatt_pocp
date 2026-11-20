// Temporary folders for a test process. Import it before anything that makes one: test/helpers.js
// does, and so does every test file that makes temporary folders without the helpers.
//
// Every test process gets one root folder and points TMPDIR at it, so everything it (and every
// pocp it starts) puts in os.tmpdir() lands inside. A folder made elsewhere with fs.mkdtempSync
// (e.g. under /tmp) is remembered too. All of it is removed when the process exits, or when it is
// stopped with SIGINT, SIGTERM or SIGHUP, so no test needs its own cleanup.
//
// SIGKILL can't be caught. The root's name records this process (src/temp-sweep.js), so a later
// test run removes it once this process is gone: each run starts with a sweep of the temp folder,
// shared between runs (at most every few minutes) because reading a crowded temp folder takes seconds.
// Not in CI: the job's machine starts empty.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forceRemove, ownedPrefix, sweepDue, sweepStale, sweepStampDir } from '../src/temp-sweep.js';
import { SUITE_SWEEP } from './sweep-temp.js';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const stampDir = sweepStampDir(process.env);
const ci = process.env.CI && process.env.CI !== '0' && process.env.CI.toLowerCase() !== 'false';
if (!ci && stampDir && sweepDue(path.join(stampDir, 'temp-sweep-suite'), 5 * 60 * 1000)) {
  try {
    sweepStale(REAL_TMP, { ...SUITE_SWEEP, budgetMs: 10_000 });
  } catch { /* a failed sweep never fails a test */ }
}

export const TEST_TMP = fs.realpathSync(fs.mkdtempSync(path.join(REAL_TMP, ownedPrefix('suite'))));
process.env.TMPDIR = TEST_TMP;
// The pocp runs a test starts sweep their own temp folder, which is this root: their sweep
// stamps live here too, apart from the real ones, in a folder made now so that a test listing
// this root never sees it appear.
process.env.POCP_SWEEP_DIR = path.join(TEST_TMP, 'sweep-stamps');
fs.mkdirSync(process.env.POCP_SWEEP_DIR);

const elsewhere = new Set();
const realMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function mkdtempSync(...args) {
  const dir = realMkdtempSync.apply(fs, args);
  const full = path.resolve(typeof dir === 'string' ? dir : String(dir));
  let real = full;
  try { real = fs.realpathSync(full); } catch { /* keep as given */ }
  if (real !== TEST_TMP && !real.startsWith(`${TEST_TMP}${path.sep}`)) elsewhere.add(full);
  return dir;
};

function cleanup() {
  for (const d of elsewhere) forceRemove(d);
  elsewhere.clear();
  forceRemove(TEST_TMP);
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => {
    cleanup();
    // Nothing else handles it (src/exit.js would exit itself): end the way the signal would have.
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  });
}
