// No test, and no pocp a test starts, may see the CI job's step files (GITHUB_OUTPUT,
// GITHUB_ENV, GITHUB_PATH, GITHUB_STATE, GITHUB_STEP_SUMMARY). `pocp verify` appends needs=
// lines to GITHUB_OUTPUT whenever it is set: on CI, test files that ran verify changed the real
// job's outputs, and broke isolation.test.js, which checks those files are left unchanged.
// test/helpers.js removes them from every test process; isolation.test.js gets the real
// paths from RUNNER_STEP_FILES.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BIN, TEST_TMP } from './helpers.js';

const VARS = ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY'];

test('a test process started inside a CI step never passes the step files on', () => {
  // A job's step files, as a runner sets them.
  const job = fs.mkdtempSync(path.join(TEST_TMP, 'job-'));
  const env = { ...process.env };
  for (const k of VARS) {
    env[k] = path.join(job, k.toLowerCase());
    fs.writeFileSync(env[k], '');
  }
  // A test file that loads the helpers, then starts a process (as pocp() and sh() do) that
  // writes to every step file it is given, and a real pocp.
  const script = path.join(job, 'probe.test.mjs');
  fs.writeFileSync(script, `
import { spawnSync } from 'node:child_process';
import { RUNNER_STEP_FILES, sh } from ${JSON.stringify(new URL('./helpers.js', import.meta.url).href)};
const vars = ${JSON.stringify(VARS)};
const seen = vars.filter((k) => process.env[k]);
sh(process.cwd(), process.execPath, ['-e', ${JSON.stringify(`for (const k of ${JSON.stringify(VARS)}) if (process.env[k]) require('fs').appendFileSync(process.env[k], 'leaked=1\\n');`)}]);
const v = spawnSync(process.execPath, [${JSON.stringify(BIN)}, '--version'], { env: process.env, encoding: 'utf8' });
console.log(JSON.stringify({ seen, kept: RUNNER_STEP_FILES, pocp: v.status }));
`);
  const r = spawnSync(process.execPath, [script], { cwd: job, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.seen, [], 'the test process still sees step files');
  assert.equal(out.pocp, 0);
  // The real paths are kept for isolation.test.js, and nothing was written to them.
  assert.deepEqual(out.kept, Object.fromEntries(VARS.map((k) => [k, env[k]])));
  for (const k of VARS) assert.equal(fs.readFileSync(env[k], 'utf8'), '', `${k} was written`);
});
