// The README's demo: an agent breaks add() and edits the test so it passes; POCP must still
// report that the old test fails on the new code. Then the agent puts the test back and fixes
// add(), and verify passes. If POCP's verdict or wording changes, the demo must change with it,
// and docs/demo.svg must be re-recorded: the last test fails when it shows other text.
import './temp.js'; // this process's temporary folders: one root, removed on exit or interrupt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The lines an SVG shows, without markup or timings ("· 1234ms" differs on every recording).
const svgLines = (body) => [...body.matchAll(/<text [^>]*>(.*?)<\/text>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\d+ms\b/g, 'Nms'));
let rendered = null; // the lines of this run's recording, for the last test

test('the demo: verify holds the edited test, then passes once the agent fixes the code', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-demo-test-'));
  const cast = path.join(tmp, 'demo.cast');
  const env = { ...process.env };
  delete env.POCP_BIN;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'examples/demo/demo.mjs'), '--cast', cast], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `the demo expects POCP to block the change:\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /✗ 1 test failed: 2 !== 0/);
  assert.match(out, /✓ 1 test passed/);
  assert.match(out, /pocp fix: committable now; CI requires human approval of the test change/);
  assert.match(out, /NOT verified yet: waiting for a maintainer's approval: 1 commit/);
  assert.match(out, /rerun passed {3}npm test --silent/);
  assert.match(out, /BAD: the old tests fail on the new code/);
  assert.match(out, /\[maintainer\] next: .*\n\s+and adds the `pocp-approve-tests` label/);
  // The honest fix: the original test back, the code fixed, and the whole range verified.
  assert.match(out, /\+  assert\.equal\(add\(-1, 1\), 0\);/);
  assert.match(out, /\+export const add = \(a, b\) => a \+ b;/);
  assert.match(out, /verified: 2 commit\(s\) in main\.\.HEAD/);
  assert.match(out, /<- the original test, on the fixed code/);
  assert.match(out, /# Exit code 0: verified/);

  const svg = path.join(tmp, 'demo.svg');
  const s = spawnSync(process.execPath, [path.join(ROOT, 'examples/demo/render-svg.mjs'), cast, svg], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  const body = fs.readFileSync(svg, 'utf8');
  assert.match(body, /^<svg [^>]*viewBox=/);
  assert.match(body, /the old tests fail on the new code/);
  assert.doesNotMatch(body, /\x1b/);
  rendered = svgLines(body);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the README shows the demo that is checked in', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\]\(docs\/demo\.svg\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/demo.svg'), 'utf8'), /the old tests fail on the new code/);
});

test('docs/demo.svg shows what the demo prints today', (t) => {
  if (!rendered) return t.skip('the demo test did not record');
  const checkedIn = svgLines(fs.readFileSync(path.join(ROOT, 'docs/demo.svg'), 'utf8'));
  assert.deepEqual(checkedIn, rendered, 're-record it: node examples/demo/demo.mjs --cast /tmp/demo.cast && node examples/demo/render-svg.mjs /tmp/demo.cast docs/demo.svg');
});
