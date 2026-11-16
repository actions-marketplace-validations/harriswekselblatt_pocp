// The repository's own workflows: approval labels reach verify only for the head they were
// given on, the coverage approval is never passed to a verifier that can't apply it (the job
// fails and says so), and every approval label is removed on each push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The `run: |` block that contains `marker`, unindented. */
function runBlock(yaml, marker) {
  const lines = yaml.split('\n');
  const hit = lines.findIndex((l) => l.includes(marker));
  let start = hit;
  while (start >= 0 && !/run: \|\s*$/.test(lines[start])) start--;
  assert.ok(hit >= 0 && start >= 0, `no run block with ${marker}`);
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n');
}

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-wf-')));
}

/** A stand-in verifier: `help` lists --accept-uncovered or not; `verify` records its arguments. */
function fakeVerifier(dir, { supportsCoverage }) {
  fs.mkdirSync(path.join(dir, 'verifier', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'verifier', 'bin', 'pocp.js'), [
    "const fs = require('fs');",
    "const [cmd, ...rest] = process.argv.slice(2);",
    `if (cmd === 'help') { console.log('verify ... --accept-test-change=<sha>${supportsCoverage ? ' --accept-uncovered=<sha>' : ''}'); process.exit(0); }`,
    "fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify([cmd, ...rest]));",
    '',
  ].join('\n'));
}

function runVerifyStep(env, { supportsCoverage }) {
  const dir = tmp();
  fakeVerifier(dir, { supportsCoverage });
  const script = runBlock(read('.github/workflows/pocp.yml'), '../verifier/bin/pocp.js verify');
  const argsFile = path.join(dir, 'args.json');
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: path.join(dir, 'pr'), encoding: 'utf8',
    env: { PATH: process.env.PATH, RANGE: 'b..h', APPROVE_POLICY: 'false', APPROVE_TESTS: 'false', APPROVE_COVERAGE: 'false', ARGS_FILE: argsFile, ...env },
  });
  const args = fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr, args };
}

test('verify step: approvals are passed as given, coverage only when the label is on', () => {
  const plain = runVerifyStep({}, { supportsCoverage: false });
  assert.equal(plain.code, 0, plain.out);
  assert.deepEqual(plain.args, ['verify', 'b..h', '--rerun', '--require-coverage', '--accept-policy-change=false', '--accept-test-change=false']);
  const withCov = runVerifyStep({ APPROVE_COVERAGE: 'abc123', APPROVE_TESTS: 'abc123' }, { supportsCoverage: true });
  assert.equal(withCov.code, 0, withCov.out);
  assert.deepEqual(withCov.args.slice(-3), ['--accept-policy-change=false', '--accept-test-change=abc123', '--accept-uncovered=abc123']);
});

test("verify step: the coverage label with a verifier that can't apply it fails the job and says so", () => {
  const r = runVerifyStep({ APPROVE_COVERAGE: 'abc123' }, { supportsCoverage: false });
  assert.equal(r.code, 1);
  assert.equal(r.args, null, 'verify is not run without the approval');
  assert.match(r.out, /::error title=POCP approval::pocp-approve-coverage is set, but the base branch's verifier does not support --accept-uncovered/);
});

test("this repository's verifier supports the coverage approval it is wired for", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pocp.js'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout + r.stderr, /--accept-uncovered=<sha>/);
});

test('each approval label is passed with the head at that moment, and verify checks it still counts', () => {
  const wf = read('.github/workflows/pocp.yml');
  for (const [env, label] of [['APPROVE_POLICY', 'pocp-approve-policy'], ['APPROVE_TESTS', 'pocp-approve-tests'], ['APPROVE_COVERAGE', 'pocp-approve-coverage'], ['APPROVE_INCONCLUSIVE', 'pocp-approve-inconclusive']]) {
    const line = wf.split('\n').find((l) => l.trim().startsWith(`${env}:`));
    assert.ok(line, env);
    assert.equal(line.trim(), `${env}: \${{ contains(github.event.pull_request.labels.*.name, '${label}') && github.event.pull_request.head.sha || 'false' }}`);
  }
  assert.match(wf, /--label-freshness=github --repo="\$GITHUB_REPOSITORY" --pull-request="\$PR_NUMBER"/);
});

test('events that cannot change the result are skipped, so they use no Actions minutes', () => {
  for (const dir of ['.github/workflows', 'examples/github']) {
    const verify = read(`${dir}/pocp.yml`);
    // Live: an edit that doesn't change the base is ignored like a non-approval label.
    assert.match(verify, /\n {4}if: vars\.POCP_STATUS_LIVE != 'true' \|\| .*\(github\.event\.action != 'edited' \|\| github\.event\.changes\.base\)\n/, dir);
    // The reporter runs only when a verify run finishes, so a skipped verify costs nothing more.
    const status = read(`${dir}/pocp-status.yml`);
    assert.doesNotMatch(status, /\n {4}if: /, dir);
  }
});
