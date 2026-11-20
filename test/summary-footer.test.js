// verify's GitHub job summary, which the `pocp` status links to, ends with one quiet line
// pointing at how POCP works. Nothing else gets it.
import './temp.js'; // this process's temporary folders: one root, removed on exit or interrupt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUMMARY_FOOTER } from '../src/badge.js';
import { writeGithubSummary } from '../src/cli/shared.js';
import './helpers.js';

function summaryOf(result) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-footer-')), 'summary.md');
  const saved = { GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  process.env.GITHUB_STEP_SUMMARY = file;
  delete process.env.GITHUB_ACTIONS;
  try {
    writeGithubSummary(result, [], () => [], 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return fs.readFileSync(file, 'utf8');
}

test('the footer is one line: "Checked by POCP · how this works", linking to HOW-IT-WORKS on GitHub', () => {
  assert.equal(SUMMARY_FOOTER, 'Checked by POCP · [how this works](https://github.com/harriswekselblatt/pocp/blob/main/docs/HOW-IT-WORKS.md)');
  assert.doesNotMatch(SUMMARY_FOOTER, /\n|powered|<img|!\[/i);
});

test('the job summary ends with the footer, once, whatever the result', () => {
  for (const result of [
    { ok: true },
    { ok: false },
    { ok: false, approval: { only: true, needs: [{ label: 'pocp-approve-tests' }] }, next_steps: [{ code: 'x', next: 'y', by: 'person' }] },
  ]) {
    const lines = summaryOf(result).trimEnd().split('\n');
    assert.equal(lines.at(-1), SUMMARY_FOOTER, JSON.stringify(result));
    assert.equal(lines.at(-2), '', 'set apart by a blank line');
    assert.equal(lines.filter((l) => l.includes('Checked by POCP')).length, 1);
  }
});
