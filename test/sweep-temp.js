// Which leftover temporary folders the test suite may sweep, and a way to sweep them by hand:
//
//   node test/sweep-temp.js        remove what killed test runs and killed pocp runs left in the
//                                  temp folder (only folders whose owner is gone; see src/temp-sweep.js)
//
// Every test run also sweeps on its own (test/temp.js), at most every few minutes and for a few
// seconds at a time; this does the whole backlog at once. Not a test file: npm test never runs it.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_KINDS, sweepStale } from '../src/temp-sweep.js';

/**
 * Folders the suite makes directly in the temp folder. 'suite' is the one root each test process
 * makes (with its owner in the name). The rest are names test files used before every file kept its
 * folders inside that root; they have no owner, so they go only once a day old.
 */
export const SUITE_SWEEP = Object.freeze({
  kinds: ['suite'],
  legacyKinds: ['suite', 'adopt', 'bench-deep', 'cleanup-check', 'demo', 'demo-bin', 'demo-test', 'footer', 'gitenv', 'harden', 'lifecycle', 'lock2', 'orphans', 'proc', 'unit', 'wf', 'wfs'],
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = os.tmpdir();
  const suite = sweepStale(base, SUITE_SWEEP);
  const product = sweepStale(base, { kinds: PRODUCT_KINDS, legacyKinds: PRODUCT_KINDS });
  const removed = suite.removed.length + product.removed.length;
  console.log(`${base}: removed ${removed} folder(s) (${suite.removed.length} from tests, ${product.removed.length} from pocp runs); kept ${suite.live + product.live} with a live owner and ${suite.young + product.young} without a recorded owner that changed in the last day`);
}
