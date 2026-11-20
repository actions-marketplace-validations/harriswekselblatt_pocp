// Sticky approvals, end to end through verify (--label-freshness=github, against a stub GitHub
// API): after "Update branch", verify finds the head is exactly the approved head plus base
// content and says so; after an edit of the pull request's own, it names what changed. A test
// label is left to the trusted reporter (what this head holds is known only after its checks);
// the record file is written only from isolated checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, git, pocp, read, sampleRepo, TEST_TMP, write } from './helpers.js';
import { heldFingerprint, heldTestFiles } from '../src/sticky-approval.js';
import { VERIFY_EXIT } from '../src/approvals.js';
import { runMarker } from '../src/status-report.js';

const TOKEN = 'ghs_sticky-SECRET-0123456789';
const RULES = {
  requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 3000 }, source: 'author' }],
};
const at = (hm) => `2026-11-16T${hm}:00Z`;
const WF = '.github/workflows/pocp.yml';

async function stubApi(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const hit = routes[req.url];
    const reply = hit === undefined ? { status: 404, body: { message: 'Not Found' } } : { status: 200, body: hit };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
function verifyAsync(dir, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'verify', ...args], { cwd: dir, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}
const plain = (dir, msg) => {
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

/** A approved (a test line reworded), the base moved on with a docs change, H = "Update branch". */
function updatedRange() {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  const base0 = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math still ok');"));
  git(dir, 'add', '-A');
  const fix = pocp(dir, ['fix', '--intent', 'reword a test line']);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  git(dir, 'commit', '-q', '-m', 'reword a test line');
  const A = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'upstream', base0);
  write(dir, 'docs/notes.md', 'base moved on\n');
  const base = plain(dir, 'docs');
  git(dir, 'checkout', '-q', '-');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-edit', 'upstream');
  return { dir, base0, A, base, H: git(dir, 'rev-parse', 'HEAD') };
}

/** GitHub as verify reads it: label added at 09:00 on A (run 08:00); H's first run at 10:00. */
function routes({ base0, A, base, H }) {
  const runs = (list) => ({ total_count: list.length, workflow_runs: list });
  const run = (id, sha, hm) => ({ id, head_sha: sha, event: 'pull_request', path: WF, status: 'completed', created_at: at(hm), head_branch: 'topic', head_repository: { full_name: 'me/site' } });
  const files = (list) => ({ files: list.map((filename) => ({ filename })) });
  return {
    '/repos/me/site/pulls/7': { number: 7, state: 'open', head: { sha: H, ref: 'topic', repo: { full_name: 'me/site' } }, base: { sha: base }, labels: [{ name: 'pocp-approve-tests' }], user: { login: 'bot' } },
    '/repos/me/site/actions/workflows/pocp.yml': { id: 11, path: WF },
    [`/repos/me/site/actions/workflows/11/runs?head_sha=${H}&per_page=100`]: runs([run(4, H, '10:00')]),
    '/repos/me/site/issues/7/events?per_page=100': [{ event: 'labeled', label: { name: 'pocp-approve-tests' }, actor: { login: 'harris' }, created_at: at('09:00') }],
    '/repos/me/site/collaborators/harris/permission': { permission: 'admin' },
    // The one-merge carry-over refuses: the merge's file list is the base's, but the base also
    // touched... nothing here, so make the compare say the merge changed the pull request's file.
    [`/repos/me/site/commits/${H}`]: { parents: [{ sha: A }, { sha: base }] },
    [`/repos/me/site/compare/${A}...${H}`]: files(['test/math.check.mjs']),
    [`/repos/me/site/compare/${base}...${H}`]: files(['test/math.check.mjs']),
    [`/repos/me/site/compare/${base}...${A}`]: files(['test/math.check.mjs']),
    [`/repos/me/site/compare/${A}...${base}`]: files(['docs/notes.md']),
    [`/repos/me/site/actions/workflows/11/runs?head_sha=${A}&per_page=100`]: runs([]),
    '/repos/me/site/actions/workflows/11/runs?event=pull_request&branch=topic&per_page=100': runs([run(4, H, '10:00'), run(5, A, '09:01'), run(3, A, '08:00')]),
    '/repos/me/site/actions/runs/3/jobs?per_page=100': { total_count: 1, jobs: [{ name: 'verify', steps: [{ name: runMarker(7, base0), conclusion: 'success' }, { name: 'verify', conclusion: 'failure' }, { name: `pocp-held tests ${'0'.repeat(64)}`, conclusion: 'success' }] }] },
  };
}
const args = (r) => [`${r.base}..${r.H}`, '--rerun', '--json', '--exit-detail', '--label-freshness=github', '--repo=me/site', '--pull-request=7', `--accept-test-change=${r.H}`];

test('after "Update branch", verify finds the head is the approved head plus base content, and leaves the test label to the reporter', async () => {
  const r = updatedRange();
  const api = await stubApi(routes(r));
  const recordFile = path.join(TEST_TMP, 'records-1');
  fs.writeFileSync(recordFile, 'stale\n');
  try {
    const v = await verifyAsync(r.dir, [...args(r), `--record-file=${recordFile}`], { POCP_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: api.url });
    assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
    assert.match(v.stderr, new RegExp(`pocp-approve-tests was given for ${r.A.slice(0, 12)}; this head is that head plus base content only`));
    assert.match(v.stderr, /the trusted reporter decides from this run's record/);
    assert.equal(v.json.label_freshness['pocp-approve-tests'].stale, false);
    // Not isolated (no --isolate here): no record file, and an old one is removed.
    assert.equal(fs.existsSync(recordFile), false);
  } finally {
    await api.close();
  }
});

test("a commit of the pull request's own after the approval: verify names what changed, and the label is stale", async () => {
  const r = updatedRange();
  write(r.dir, 'test/math.check.mjs', `${read(r.dir, 'test/math.check.mjs')}// more\n`);
  r.H = plain(r.dir, 'sneak a test edit in after the approval');
  const api = await stubApi(routes(r));
  try {
    const v = await verifyAsync(r.dir, args(r), { POCP_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: api.url });
    assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
    assert.match(v.stderr, /the pull request changed since then: the head is not the approved head plus base content \(test\/math\.check\.mjs\)/);
    assert.equal(v.json.label_freshness['pocp-approve-tests'].stale, true);
  } finally {
    await api.close();
  }
});

test("the held set verify records is the same at the approved head and after Update branch (one commit or several)", () => {
  for (const commits of [1, 2]) {
    const r = updatedRange();
    let A = r.A;
    let H = r.H;
    if (commits === 2) {
      // A second commit of the pull request's own, before the approval; then update again.
      git(r.dir, 'checkout', '-q', '-B', 'pr', r.A);
      write(r.dir, 'src/extra.md', 'x\n');
      A = plain(r.dir, 'a second commit');
      git(r.dir, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-edit', 'upstream');
      H = git(r.dir, 'rev-parse', 'HEAD');
    }
    const at = pocp(r.dir, ['verify', `${r.base0}..${A}`, '--rerun', '--json']);
    const after = pocp(r.dir, ['verify', `${r.base}..${H}`, '--rerun', '--json']);
    const held = heldTestFiles(at.json);
    assert.deepEqual(held, ['test/math.check.mjs'], `${commits}: ${at.stdout}`);
    assert.equal(heldFingerprint(heldTestFiles(after.json)), heldFingerprint(held), `${commits} commit(s)`);
  }
});
