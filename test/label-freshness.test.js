// 1.3.1: approval labels are checked against the head without pull_request_target.
//
// GitHub blocks pull_request_target by default in public repositories (from 2026-12-02), so
// pocp-labels.yml can't remove approval labels on push any more. Instead one rule, in
// src/label-freshness.js, decides whether a label counts for a head: it was last applied by a
// writer after the head's first run and after the latest force-push, or it carries over to a
// clean merge of the base ("Update branch"). verify applies it when the workflow asks for it
// (label-freshness: github), and the reporter applies it and removes the labels it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BIN, git, pocp, read, sampleRepo, tmpRepo, write, writeConfig } from './helpers.js';
import { VERIFY_EXIT } from '../src/approvals.js';
import { GITHUB_WORKFLOWS, writeGithubWorkflows } from '../src/init.js';
import { workerEnv } from '../src/isolate.js';
import { labelFreshness } from '../src/label-freshness.js';
import { reportStatus, runMarker, TEXT } from '../src/status-report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TOKEN = 'ghs_label-freshness-SECRET-0123456789';

const RULES = {
  requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 3000 }, source: 'author' }],
};

// --- the workflows ---------------------------------------------------------------------------

test('no shipped workflow uses pull_request_target, and pocp-labels.yml is gone', () => {
  for (const dir of ['.github/workflows', 'examples/github']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => /\.ya?ml$/.test(x))) {
      const code = readRoot(`${dir}/${f}`).split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
      assert.doesNotMatch(code, /pull_request_target/, `${dir}/${f}`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, dir, 'pocp-labels.yml')), false, dir);
  }
  assert.deepEqual([...GITHUB_WORKFLOWS], ['pocp.yml', 'pocp-status.yml']);
});

test('pocp.yml asks verify to check label freshness, with a read-only token for verify alone', () => {
  const wf = readRoot('examples/github/pocp.yml');
  assert.match(wf, /\n {10}label-freshness: github(?: +#[^\n]*)?\n {10}github-token: \$\{\{ github\.token \}\}(?: +#[^\n]*)?\n/);
  assert.match(wf, /\npermissions:\n {2}contents: read\n {2}actions: read(?: +#[^\n]*)?\n {2}pull-requests: read(?: +#[^\n]*)?\n/);
  assert.doesNotMatch(wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /: write\b/);
  // The repo's own copy runs the base's verifier: the flag only when that verifier has it, and
  // the token only in the verify step's environment.
  const own = readRoot('.github/workflows/pocp.yml');
  assert.match(own, /grep -q -- '--label-freshness'/);
  assert.match(own, /\npermissions:\n {2}contents: read\n {2}actions: read(?: +#[^\n]*)?\n {2}pull-requests: read(?: +#[^\n]*)?\n/);
  assert.equal((own.match(/github\.token/g) || []).length, 1);
  assert.match(own, /\n {10}POCP_GITHUB_TOKEN: \$\{\{ github\.token \}\}\n/);
  // The action hands the token to verify's process only.
  const action = readRoot('action.yml');
  assert.match(action, /\n {2}label-freshness:\n/);
  assert.match(action, /\n {2}github-token:\n/);
  assert.match(action, /\n {8}POCP_GITHUB_TOKEN: \$\{\{ inputs\.label-freshness == 'github' && inputs\.github-token \|\| '' \}\}\n/);
});

test('pocp-status.yml runs on workflow_run only and may remove the labels it refuses', () => {
  for (const f of ['.github/workflows/pocp-status.yml', 'examples/github/pocp-status.yml']) {
    const wf = readRoot(f);
    assert.match(wf, /\non:\n {2}workflow_run:\n {4}workflows: \[pocp\]\n {4}types: \[completed\]\npermissions:/, f);
    assert.match(wf, /\n {2}pull-requests: write(?: +#[^\n]*)?\n/, f);
    // github.token removes labels (the App's token is read-only there); GH_TOKEN stays the App's.
    assert.match(wf, /\n {10}(LABELS_TOKEN|labels-token): \$\{\{ github\.token \}\}\n/, f);
  }
});

test('init --github --force writes two workflows and removes an old pocp-labels.yml', () => {
  const dir = tmpRepo();
  write(dir, '.github/workflows/pocp-labels.yml', '# .github/workflows/pocp-labels.yml\nname: pocp-labels\n');
  write(dir, '.github/workflows/other.yml', 'name: other\n');
  const r = writeGithubWorkflows(dir, { force: true });
  assert.deepEqual(r.written.map((f) => path.basename(f)), ['pocp.yml', 'pocp-status.yml']);
  assert.deepEqual(r.removed.map((f) => path.basename(f)), ['pocp-labels.yml']);
  assert.equal(fs.existsSync(path.join(dir, '.github/workflows/pocp-labels.yml')), false);
  assert.equal(fs.existsSync(path.join(dir, '.github/workflows/other.yml')), true);
  // Without --force nothing is removed.
  const again = tmpRepo();
  write(again, '.github/workflows/pocp-labels.yml', 'name: pocp-labels\n');
  assert.deepEqual(writeGithubWorkflows(again).removed, []);
  assert.equal(fs.existsSync(path.join(again, '.github/workflows/pocp-labels.yml')), true);
});

test('doctor flags a pocp.yml without label-freshness and a leftover pocp-labels.yml', () => {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'block' }, ci: { branch: 'main', required_checks: ['verify'] } });
  write(dir, '.github/workflows/pocp.yml', readRoot('examples/github/pocp.yml').replace(/\n {10}label-freshness: github[^\n]*\n {10}github-token: [^\n]*/, ''));
  write(dir, '.github/workflows/pocp-labels.yml', 'name: pocp-labels\non:\n  pull_request_target:\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'old workflows');
  const r = pocp(dir, ['doctor', '--offline', '--json']);
  const c = r.json.checks.filter((x) => x.id === 'workflows-outdated');
  assert.equal(c.length, 1, r.stdout);
  assert.equal(c[0].status, 'problem');
  assert.match(c[0].what, /pocp\.yml doesn't check approval labels against the head/);
  assert.match(c[0].what, /pocp-labels\.yml/);
  assert.match(c[0].fix, /pocp init --github --force/);
  // Regenerated: nothing to flag.
  writeGithubWorkflows(dir, { force: true });
  const ok = pocp(dir, ['doctor', '--offline', '--json']);
  assert.deepEqual(ok.json.checks.filter((x) => x.id === 'workflows-outdated'), []);
});

// --- the rule --------------------------------------------------------------------------------

const H = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BASE = 'e'.repeat(40);
const at = (hm) => `2026-11-16T${hm}:00Z`;
const ev = (label, hm, permission = 'admin') => ({ label, actor: 'harris', permission, created_at: at(hm) });
const ruleFacts = (over = {}) => ({
  pr: { number: 7, head_sha: H, labels: ['pocp-approve-tests'] }, base_sha: BASE,
  runs: [{ head_sha: H, created_at: at('10:00') }], label_events: [], label_events_complete: true, force_pushes: [], ...over,
});

test('the rule: fresh after the head\'s first run; stale before it or before a force-push; unknown without the data', () => {
  assert.deepEqual(labelFreshness(ruleFacts({ label_events: [ev('pocp-approve-tests', '10:05')] }), 'pocp-approve-tests', H), { ok: true, how: 'fresh' });
  const before = labelFreshness(ruleFacts({ label_events: [ev('pocp-approve-tests', '09:00')] }), 'pocp-approve-tests', H);
  assert.equal(before.ok, false);
  assert.equal(before.stale, true);
  assert.match(before.why, /added before this commit/);
  const back = labelFreshness(ruleFacts({ label_events: [ev('pocp-approve-tests', '10:05')], force_pushes: [at('10:10')] }), 'pocp-approve-tests', H);
  assert.equal(back.stale, true);
  assert.match(back.why, /force-push/);
  const triage = labelFreshness(ruleFacts({ label_events: [ev('pocp-approve-tests', '10:05', 'triage')] }), 'pocp-approve-tests', H);
  assert.equal(triage.stale, true);
  assert.match(triage.why, /without write access/);
  // Not enough data to say: refused, but not stale (nothing should remove the label for it).
  for (const f of [ruleFacts({ label_events: [ev('pocp-approve-tests', '10:05')], label_events_complete: false }), ruleFacts({ label_events: [ev('pocp-approve-tests', '10:05', null)] }), ruleFacts({ label_events: [ev('pocp-approve-tests', '10:05')], runs: [] })]) {
    const v = labelFreshness(f, 'pocp-approve-tests', H);
    assert.equal(v.ok, false);
    assert.equal(v.stale, false, v.why);
  }
});

// --- verify ----------------------------------------------------------------------------------

/** A stub GitHub API: answers GETs from `routes` (path with query → body, or { status, body }). */
async function stubApi(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const hit = routes[req.url];
    const reply = hit === undefined ? { status: 404, body: { message: 'Not Found' } } : hit && hit.status ? hit : { status: 200, body: hit };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** verify in a child process, without blocking this one (the stub API answers from here). */
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

function commit(dir, message) {
  git(dir, 'add', '-A');
  const fix = pocp(dir, ['fix', '--intent', message]);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A range whose only problem is a changed test line: it needs pocp-approve-tests. */
function testChangeRange(prepend = '') {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${prepend}${read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math still ok');")}`);
  const head = commit(dir, 'reword a test line');
  return { dir, base, head };
}

/** The API as verify reads it: PR #7 at `head`, its first run at 10:00, and these issue events. */
function routesFor({ head, base, events, labels = ['pocp-approve-tests'], extra = {} }) {
  return {
    '/repos/me/site/pulls/7': { number: 7, state: 'open', head: { sha: head }, base: { sha: base }, labels: labels.map((name) => ({ name })), user: { login: 'bot' } },
    '/repos/me/site/actions/workflows/pocp.yml': { id: 11, path: '.github/workflows/pocp.yml' },
    [`/repos/me/site/actions/workflows/11/runs?head_sha=${head}&per_page=100`]: { total_count: 2, workflow_runs: [
      { id: 1, head_sha: head, event: 'pull_request', path: '.github/workflows/pocp.yml', created_at: at('10:00') },
      { id: 2, head_sha: head, event: 'pull_request', path: '.github/workflows/pocp.yml', created_at: at('10:20') },
    ] },
    '/repos/me/site/issues/7/events?per_page=100': events,
    '/repos/me/site/collaborators/harris/permission': { permission: 'admin' },
    [`/repos/me/site/commits/${head}`]: { parents: [{ sha: base }] },
    ...extra,
  };
}
const labeled = (name, hm) => ({ event: 'labeled', label: { name }, actor: { login: 'harris' }, created_at: at(hm) });
const forcePushed = (hm) => ({ event: 'head_ref_force_pushed', actor: { login: 'bot' }, created_at: at(hm) });

const freshnessArgs = (r) => [`${r.base}..${r.head}`, '--rerun', '--json', '--exit-detail', '--label-freshness=github', '--repo=me/site', '--pull-request=7'];
const freshnessEnv = (api) => ({ POCP_GITHUB_TOKEN: TOKEN, GITHUB_API_URL: api.url });

test('verify refuses a label added before the head (the run a push starts)', async () => {
  const r = testChangeRange();
  const api = await stubApi(routesFor({ ...r, events: [labeled('pocp-approve-tests', '09:00')] }));
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], freshnessEnv(api));
    assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
    assert.match(v.stderr, /pocp-approve-tests was added before this commit: review the new commits and re-apply it/);
    assert.equal(v.json.label_freshness['pocp-approve-tests'].ok, false);
    assert.ok(api.seen.length && api.seen.every((s) => s.auth === `Bearer ${TOKEN}`));
  } finally {
    await api.close();
  }
});

test('verify refuses an old label when another approval label starts the run, and accepts the new one', async () => {
  const r = testChangeRange();
  const api = await stubApi(routesFor({ ...r, labels: ['pocp-approve-tests', 'pocp-approve-policy'], events: [labeled('pocp-approve-tests', '09:00'), labeled('pocp-approve-policy', '10:15')] }));
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`, `--accept-policy-change=${r.head}`], freshnessEnv(api));
    assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
    assert.equal(v.json.label_freshness['pocp-approve-tests'].ok, false);
    assert.deepEqual(v.json.label_freshness['pocp-approve-policy'], { ok: true, how: 'fresh' });
    assert.doesNotMatch(v.stderr, /pocp-approve-policy was/);
  } finally {
    await api.close();
  }
});

test('verify accepts a label added after the head\'s first run', async () => {
  const r = testChangeRange();
  const api = await stubApi(routesFor({ ...r, events: [labeled('pocp-approve-tests', '10:05')] }));
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], freshnessEnv(api));
    assert.equal(v.code, 0, v.stdout + v.stderr);
  } finally {
    await api.close();
  }
});

test('verify refuses a label given before a force-push (forced back to a head that ran before)', async () => {
  const r = testChangeRange();
  const api = await stubApi(routesFor({ ...r, events: [labeled('pocp-approve-tests', '10:05'), forcePushed('10:10')] }));
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], freshnessEnv(api));
    assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
    assert.match(v.stderr, /pocp-approve-tests was applied before a force-push/);
  } finally {
    await api.close();
  }
});

test('"Update branch" keeps its approvals: a clean merge of the base carries the label over', async () => {
  const r = testChangeRange();
  const prFiles = [{ filename: 'test/math.check.mjs' }];
  const files = (list) => ({ files: list });
  const api = await stubApi(routesFor({ ...r, base: BASE, events: [labeled('pocp-approve-tests', '08:30')], extra: {
    [`/repos/me/site/commits/${r.head}`]: { parents: [{ sha: OLD }, { sha: BASE }] },
    [`/repos/me/site/compare/${OLD}...${r.head}`]: files([{ filename: 'docs/base-change.md' }]),
    [`/repos/me/site/compare/${BASE}...${r.head}`]: files(prFiles),
    [`/repos/me/site/compare/${BASE}...${OLD}`]: files(prFiles),
    [`/repos/me/site/compare/${OLD}...${BASE}`]: files([{ filename: 'docs/base-change.md' }]),
    [`/repos/me/site/actions/workflows/11/runs?head_sha=${OLD}&per_page=100`]: { total_count: 1, workflow_runs: [{ id: 5, head_sha: OLD, event: 'pull_request', path: '.github/workflows/pocp.yml', created_at: at('08:00') }] },
    '/repos/me/site/actions/runs/5/jobs?per_page=100': { total_count: 1, jobs: [{ name: 'verify', steps: [{ name: runMarker(7, BASE), conclusion: 'success' }] }] },
  } }));
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], freshnessEnv(api));
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.deepEqual(v.json.label_freshness['pocp-approve-tests'], { ok: true, how: 'carried' });
  } finally {
    await api.close();
  }
});

test('verify refuses approvals it couldn\'t check, and says to re-run, not to re-apply', async () => {
  const r = testChangeRange();
  const routes = routesFor({ ...r, events: [labeled('pocp-approve-tests', '10:05')] });
  routes['/repos/me/site/issues/7/events?per_page=100'] = { status: 502, body: { message: 'Bad Gateway' } };
  const api = await stubApi(routes);
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], freshnessEnv(api));
    assert.equal(v.code, VERIFY_EXIT.waiting, v.stdout + v.stderr);
    assert.match(v.stderr, /couldn't check pocp-approve-tests against GitHub.*re-run/);
    // No token: a usage error, never a silent pass.
    const noToken = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], { POCP_GITHUB_TOKEN: '', GITHUB_API_URL: api.url });
    assert.notEqual(noToken.code, 0);
    assert.notEqual(noToken.code, VERIFY_EXIT.waiting);
    assert.match(noToken.stdout + noToken.stderr, /label-freshness=github needs a token/);
  } finally {
    await api.close();
  }
});

test('the token reaches verify only: never a check\'s environment, the output or the summary', async () => {
  // Isolated checks get an allowlisted environment: the token is never on it, whatever
  // run.env_allow says.
  const env = workerEnv({ PATH: '/bin', POCP_GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN }, ['POCP_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
  assert.deepEqual(Object.keys(env).filter((k) => /TOKEN/.test(k)), []);
  // The cooperative runner, with run.env "inherit" (the default): the check dumps its environment.
  const dump = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-env-'))), 'env.json');
  const r = testChangeRange(`import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env) + '\\n');\n`);
  const summary = path.join(path.dirname(dump), 'summary.md');
  const api = await stubApi(routesFor({ ...r, events: [labeled('pocp-approve-tests', '10:05')] }));
  try {
    const v = await verifyAsync(r.dir, [...freshnessArgs(r), `--accept-test-change=${r.head}`], { ...freshnessEnv(api), GITHUB_STEP_SUMMARY: summary, POCP_TEST_VISIBLE: 'inherited' });
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.ok(fs.existsSync(dump), 'the check ran');
    const seen = fs.readFileSync(dump, 'utf8');
    assert.match(seen, /POCP_TEST_VISIBLE/, 'the check saw the inherited environment');
    assert.ok(!seen.includes(TOKEN), 'the check saw the token');
    assert.ok(!v.stdout.includes(TOKEN) && !v.stderr.includes(TOKEN));
    assert.ok(!fs.existsSync(summary) || !fs.readFileSync(summary, 'utf8').includes(TOKEN));
  } finally {
    await api.close();
  }
});

// --- the reporter ----------------------------------------------------------------------------

const WF = { id: 11, path: '.github/workflows/pocp.yml' };
const verifyJob = (approvals) => ({ name: 'verify', status: 'completed', conclusion: 'success', steps: [
  { name: runMarker(7, BASE), conclusion: 'success' }, { name: 'verify', conclusion: 'success' },
  { name: 'verified', conclusion: approvals.length ? 'success' : 'skipped' },
  { name: 'waiting', conclusion: approvals.length ? 'skipped' : 'success' },
  ...['inconclusive', 'failed'].map((name) => ({ name, conclusion: 'skipped' })),
  ...['approval-tests', 'approval-policy', 'approval-inconclusive', 'approval-coverage'].map((name) => ({ name, conclusion: approvals.includes(name) ? 'success' : 'skipped' })),
] });

/** A fake API client for the reporter, logging writes in order. */
function reporterGh({ labels, events, permission = 'admin', approvals = ['approval-tests'] }) {
  const log = [];
  const pr = { number: 7, state: 'open', head: { sha: H }, base: { sha: BASE }, changed_files: 1, labels: labels.map((name) => ({ name })), user: { login: 'bot' } };
  const gh = {
    get: async (url) => {
      if (url.includes('/actions/workflows/pocp.yml')) return WF;
      if (url.endsWith('/pulls/7')) return pr;
      if (url.includes(`/commits/${H}`)) return { parents: [{ sha: OLD }] };
      if (url.includes('/collaborators/')) {
        if (!permission) throw new Error('GitHub API 502');
        return { permission };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    all: async (url) => {
      if (url.includes('/pulls?state=open')) return [{ number: 7, state: 'open', head: { sha: H } }];
      if (url.includes('/pulls/7/files')) return [{ filename: 'src/a.js' }];
      if (url.includes('/runs?')) return [{ id: 1, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: H, repository: { full_name: 'o/r' }, status: 'completed', conclusion: 'success', created_at: at('10:00'), run_attempt: 1, html_url: 'https://github.com/o/r/actions/runs/1' }];
      if (url.includes('/jobs')) return [verifyJob(approvals)];
      if (url.includes('/issues/7/events')) return events;
      return [];
    },
    post: async (url, body) => log.push(['POST', url, body.state]),
  };
  const labelGh = { delete: async (url) => log.push(['DELETE', url]) };
  return { gh, labelGh, log };
}

test('the reporter removes a stale approval label, after writing the status that refuses it', async () => {
  const { gh, labelGh, log } = reporterGh({ labels: ['pocp-approve-tests', 'bug'], events: [labeled('pocp-approve-tests', '09:00')] });
  const r = await reportStatus(gh, { repository: 'o/r', sha: H, prNumber: 7, baseConfig: null, labelGh });
  assert.equal(r.decision.state, 'pending');
  assert.equal(r.decision.description, TEXT.approvalUnverified);
  assert.deepEqual(log, [['POST', `/repos/o/r/statuses/${H}`, 'pending'], ['DELETE', '/repos/o/r/issues/7/labels/pocp-approve-tests']]);
  assert.deepEqual(r.removed, ['pocp-approve-tests']);
});

test('the reporter removes nothing it can\'t prove stale, nothing fresh, and nothing on a dry run', async () => {
  for (const [why, over] of [
    ['fresh', { events: [labeled('pocp-approve-tests', '10:05')] }],
    ['permission unreadable', { events: [labeled('pocp-approve-tests', '10:05')], permission: null }],
  ]) {
    const { gh, labelGh, log } = reporterGh({ labels: ['pocp-approve-tests'], ...over });
    const r = await reportStatus(gh, { repository: 'o/r', sha: H, prNumber: 7, baseConfig: null, labelGh });
    assert.deepEqual(log.filter((x) => x[0] === 'DELETE'), [], why);
    assert.deepEqual(r.removed, [], why);
  }
  const dry = reporterGh({ labels: ['pocp-approve-tests'], events: [labeled('pocp-approve-tests', '09:00')] });
  await reportStatus(dry.gh, { repository: 'o/r', sha: H, prNumber: 7, baseConfig: null, labelGh: dry.labelGh, dryRun: true });
  assert.deepEqual(dry.log, []);
  // A waiting run (verify itself refused the label) still gets its stale label removed.
  const waiting = reporterGh({ labels: ['pocp-approve-tests'], events: [labeled('pocp-approve-tests', '09:00')], approvals: [] });
  const w = await reportStatus(waiting.gh, { repository: 'o/r', sha: H, prNumber: 7, baseConfig: null, labelGh: waiting.labelGh });
  assert.equal(w.decision.description, TEXT.waiting);
  assert.deepEqual(w.removed, ['pocp-approve-tests']);
});

// --- the action ------------------------------------------------------------------------------

/** Run action.yml's Verify step with a stand-in for pocp that records its arguments. */
function runActionStep(env) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-action-')));
  const argsFile = path.join(dir, 'args.json');
  const fake = path.join(dir, 'fake-pocp.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), token: process.env.POCP_GITHUB_TOKEN || null }))' "${argsFile}" "$@"\n`, { mode: 0o755 });
  const lines = readRoot('action.yml').split('\n');
  const start = lines.findIndex((l) => /run: \|\s*$/.test(l));
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length && (!lines[i].trim() || lines[i].match(/^\s*/)[0].length >= indent); i++) body.push(lines[i].slice(indent));
  const r = spawnSync('bash', ['-e', '-c', body.join('\n')], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: process.env.PATH, RANGE_INPUT: '', PR_BASE: 'b', PR_HEAD: 'h', EVENT_NAME: 'pull_request', RERUN: 'all', CI_RESULTS: '', ACCEPT_POLICY: 'false', ACCEPT_TESTS: 'false', ACCEPT_INCONCLUSIVE: 'false', ACCEPT_UNCOVERED: 'false', EXIT_DETAIL: 'false', COVERAGE: 'true', ISOLATE: 'true', INSTALL: '', POCP_CMD: fake, GITHUB_REPOSITORY: 'me/site', PR_NUMBER: '7', LABEL_FRESHNESS: '', POCP_GITHUB_TOKEN: '', ...env },
  });
  return { code: r.status, out: r.stdout, ...(fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : {}) };
}

test('action.yml: label-freshness passes the pull request to verify; without it, approvals warn; anything else fails', () => {
  const on = runActionStep({ LABEL_FRESHNESS: 'github', POCP_GITHUB_TOKEN: TOKEN, ACCEPT_TESTS: 'h' });
  assert.equal(on.code, 0);
  assert.deepEqual(on.args.filter((a) => /label-freshness|--repo|--pull-request/.test(a)), ['--label-freshness=github', '--repo=me/site', '--pull-request=7']);
  assert.equal(on.token, TOKEN, 'verify gets the token in its environment');
  assert.ok(!on.args.some((a) => a.includes(TOKEN)), 'never on the command line');
  // An old pocp.yml: works as before, with a warning when an approval is passed.
  const old = runActionStep({ ACCEPT_TESTS: 'h' });
  assert.equal(old.code, 0);
  assert.ok(!old.args.some((a) => /label-freshness/.test(a)));
  assert.match(old.out, /::warning title=POCP approvals::.*pocp init --github --force/);
  assert.doesNotMatch(runActionStep({}).out, /::warning title=POCP approvals/);
  const bad = runActionStep({ LABEL_FRESHNESS: 'yes' });
  assert.equal(bad.code, 2);
  assert.equal(bad.args, undefined);
});

test('pocp help lists --label-freshness, so a workflow can tell a verifier that has it', () => {
  const r = pocp(ROOT, ['help']);
  assert.match(r.stdout + r.stderr, /--label-freshness=github/);
});
