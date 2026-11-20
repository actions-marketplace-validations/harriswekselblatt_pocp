// CI hardening that has to stay true for every workflow POCP runs or writes for others
// (.github/workflows, examples/github and what `pocp init --github` generates, action.yml):
// jobs can't hang for six hours, third-party actions are pinned by commit, checkouts leave no
// token behind, and green never comes from a step output the checks could write.
import './temp.js'; // this process's temporary folders: one root, removed on exit or interrupt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASED_ACTION_REF, releaseRef, writeGithubWorkflows } from '../src/init.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Files git tracks (or is about to): local leftovers such as Finder's "x 2.yml" copies are
// ignored and never reach GitHub.
const tracked = new Set(spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean));
const ymls = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f)).filter((rel) => tracked.size === 0 || tracked.has(rel));
const REPO_WORKFLOWS = ymls('.github/workflows');
const TEMPLATES = ymls('examples/github');

/** Workflows as `pocp init --github` writes them, by file name. */
function generated() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-harden-')));
  writeGithubWorkflows(dir);
  const out = Object.fromEntries(fs.readdirSync(path.join(dir, '.github/workflows')).map((f) => [`generated/${f}`, fs.readFileSync(path.join(dir, '.github/workflows', f), 'utf8')]));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
const ALL = () => ({ ...Object.fromEntries([...REPO_WORKFLOWS, ...TEMPLATES].map((f) => [f, read(f)])), ...generated() });

const indent = (l) => l.match(/^\s*/)[0].length;
// The condition inside the prediction's skip guard, which every step after approved-without-run
// carries (workflow-status.test.js checks it is there).
const SKIP_GUARD = "steps.predict.outputs.skip != 'true' && (";
const unguard = (c) => (c && c.startsWith(SKIP_GUARD) && c.endsWith(')') ? c.slice(SKIP_GUARD.length, -1) : c);
const code = (l) => l.replace(/\s+#.*$/, '');

/** { name: lines } for each job under the top-level `jobs:` key. */
function jobs(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'no jobs:');
  const out = {};
  let name = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) out[(name = m[1])] = [];
    else if (name) out[name].push(l);
  }
  return out;
}

/** Each step as its lines (a step starts at a `- ` line under `steps:`). */
function steps(yaml) {
  const lines = yaml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*steps:\s*$/.test(lines[i])) continue;
    const ind = indent(lines[i]);
    let cur = null;
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > ind || /^\s*#/.test(lines[j])); j++) {
      if (/^\s*#/.test(lines[j])) continue;
      if (/^\s*- /.test(lines[j]) && indent(lines[j]) === ind + 2) out.push((cur = [lines[j]]));
      else if (cur) cur.push(lines[j]);
    }
  }
  return out;
}
const keyOf = (step, key) => {
  const l = step.find((x) => x.trim().replace(/^- /, '').startsWith(`${key}:`));
  return l ? code(l.trim().replace(/^- /, '').slice(key.length + 1)).trim() : null;
};

test('every job in the workflows, the templates and the generated files has a timeout', () => {
  for (const [file, yaml] of Object.entries(ALL())) {
    const js = jobs(yaml);
    assert.ok(Object.keys(js).length, `${file}: no jobs found`);
    for (const [name, lines] of Object.entries(js)) {
      const t = lines.find((l) => /^ {4}timeout-minutes:/.test(l));
      assert.ok(t, `${file}: job ${name} has no timeout-minutes`);
      const minutes = Number(code(t).split(':')[1]);
      assert.ok(minutes > 0 && minutes <= 120, `${file}: job ${name} timeout ${minutes}`);
    }
  }
});

test('every action is pinned by a full commit sha with its version in a comment (POCP\'s own action by its release)', () => {
  const pins = new Map();
  const files = { ...ALL(), 'action.yml': read('action.yml'), 'status/action.yml': read('status/action.yml') };
  for (const [file, yaml] of Object.entries(files)) {
    for (const l of yaml.split('\n').filter((x) => /^\s*(- )?uses:/.test(x))) {
      const ref = l.trim().replace(/^- /, '').replace(/^uses:\s*/, '');
      if (/^harriswekselblatt\/pocp(\/status)?@/.test(ref)) {
        // POCP's own action: pinned by `pocp init --github` (a release tag or a commit).
        assert.ok(file.startsWith('examples/') ? /@POCP_REF\b/.test(ref) : /@(v\d+\.\d+\.\d+|[0-9a-f]{40})\b/.test(ref), `${file}: ${ref}`);
        continue;
      }
      const m = /^([\w.-]+\/[\w./-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(ref);
      assert.ok(m, `${file}: not pinned by sha with a version comment: ${ref}`);
      const seen = pins.get(m[1]);
      assert.ok(!seen || seen === `${m[2]} ${m[3]}`, `${file}: ${m[1]} pinned differently from another workflow (${seen})`);
      pins.set(m[1], `${m[2]} ${m[3]}`);
    }
  }
  assert.ok(pins.has('actions/checkout') && pins.has('actions/setup-node'));
});

test('every checkout leaves no credentials behind', () => {
  for (const [file, yaml] of Object.entries(ALL())) {
    for (const step of steps(yaml).filter((s) => /actions\/checkout@/.test(s.join('\n')))) {
      assert.match(step.join('\n'), /persist-credentials: false/, `${file}: ${step[0].trim()}`);
    }
  }
});

test('green never depends on the code output: only the verify step\'s own outcome', () => {
  const verifyFiles = Object.entries(ALL()).filter(([f]) => /(^|\/)pocp\.yml$/.test(f));
  assert.equal(verifyFiles.length, 3);
  for (const [file, yaml] of verifyFiles) {
    const all = steps(yaml);
    const named = (n) => all.find((s) => keyOf(s, 'name') === n);
    const verify = named('verify');
    assert.ok(verify, `${file}: no verify step`);
    assert.equal(keyOf(verify, 'continue-on-error'), 'true', `${file}: verify must fail on anything but verified, and the result steps still run`);
    if (keyOf(verify, 'run')) assert.match(verify.join('\n'), /exit "\$code"/, `${file}: the step exits with verify's code`);
    else assert.match(verify.join('\n'), /exit-detail: true/, file);
    // Evaluate the result steps' conditions for each outcome and code, as Actions would.
    const results = ['verified', 'waiting', 'inconclusive', 'failed'];
    let skipValue = '';
    const runs = (outcome, codeValue) => results.filter((n) => {
      const cond = keyOf(named(n), 'if');
      assert.ok(cond, `${file}: ${n} has no if`);
      const expr = cond.replace(/steps\.predict\.outputs\.skip/g, JSON.stringify(skipValue)).replace(/steps\.verify\.outputs\.code/g, JSON.stringify(codeValue)).replace(/steps\.verify\.outcome/g, JSON.stringify(outcome)).replace(/==/g, '===').replace(/!=/g, '!==');
      assert.doesNotMatch(expr, /steps\.|env\.|outputs/, `${file}: ${n} reads something else: ${cond}`);
      return Function(`return (${expr});`)();
    });
    for (const codeValue of ['0', '1', '2', '4', '5', '137', '', 'x', '0\n']) {
      const failedRun = runs('failure', codeValue);
      assert.ok(!failedRun.includes('verified'), `${file}: a failed verify step with code ${JSON.stringify(codeValue)} reads as verified`);
      assert.equal(failedRun.length, 1, `${file}: failure/${JSON.stringify(codeValue)} runs ${failedRun}`);
      assert.equal(runs('success', codeValue).length, 1, `${file}: success/${JSON.stringify(codeValue)}`);
    }
    assert.deepEqual(runs('success', '0'), ['verified']);
    assert.deepEqual(runs('failure', '4'), ['waiting']);
    assert.deepEqual(runs('failure', '5'), ['inconclusive']);
    // When the prediction skipped verify, no result step runs (the run reports nothing).
    skipValue = 'true';
    for (const codeValue of ['0', '1', '4', '5', '']) assert.deepEqual(runs('skipped', codeValue), [], `${file}: skip/${codeValue}`);
    skipValue = '';
    // No other step's condition uses the code output to pass.
    for (const s of all) {
      const cond = keyOf(s, 'if') || '';
      if (/outputs\.code/.test(cond) && !results.includes(keyOf(s, 'name'))) assert.fail(`${file}: ${keyOf(s, 'name')} depends on outputs.code`);
    }
  }
});

test('test.yml: required Linux cells unchanged, one macOS cell per pull request, the full matrix nightly', () => {
  const yaml = read('.github/workflows/test.yml');
  assert.match(yaml, /os: \[ubuntu-latest\]\n\s+node: \[20, 22, 24\]/);
  assert.match(yaml, /'\[\{"os":"macos-latest","node":22\}\]'/);
  assert.match(yaml, /schedule:/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(yaml, /format\('test-run-\{0\}', github\.run_id\)/, 'runs on main never share a group');
  assert.doesNotMatch(yaml, /continue-on-error/, 'no failure is hidden');
});

test('release.yml: runs only for v* tags, checks the tag against package.json, publishes with provenance', () => {
  const yaml = read('.github/workflows/release.yml');
  const on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\npermissions:'));
  assert.match(on, /push:\n\s+tags: \['v\*'\]/);
  assert.doesNotMatch(on, /pull_request|branches|workflow_run/);
  assert.match(yaml, /^permissions:\n {2}contents: read\n/m);
  assert.match(yaml, /environment: release/);
  assert.match(yaml, /id-token: write/);
  assert.doesNotMatch(yaml, /contents: write|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.match(yaml, /"v\$version" != "\$GITHUB_REF_NAME"/);
  assert.match(yaml, /npm test/);
  assert.match(yaml, /npm publish "proof-of-change-\$\{GITHUB_REF_NAME#v\}\.tgz" --provenance --access public/);
});

test('dependabot keeps the action pins current', () => {
  const yaml = read('.github/dependabot.yml');
  assert.match(yaml, /package-ecosystem: github-actions/);
  assert.match(yaml, /interval: weekly/);
});

test('init pins a tag that exists: the version for a release, the last release for a dev build', () => {
  assert.match(RELEASED_ACTION_REF, /^v\d+\.\d+\.\d+$/);
  const { version } = JSON.parse(read('package.json'));
  if (/^\d+\.\d+\.\d+$/.test(version)) assert.equal(releaseRef(), `v${version}`);
  else assert.equal(releaseRef(), RELEASED_ACTION_REF, `${version} has no tag of its own`);
  const num = (v) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [num(RELEASED_ACTION_REF), num(version)];
  assert.ok(a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2]))), `${RELEASED_ACTION_REF} is not older than ${version}`);
  // Where the repository's tags are present (not in a shallow CI checkout), it is a real tag,
  // except on the release commit itself: its tag is made from it once it is merged.
  const preparing = RELEASED_ACTION_REF === `v${version}`;
  const tags = spawnSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' });
  if (!preparing && tags.status === 0 && tags.stdout.trim()) assert.ok(tags.stdout.split('\n').includes(RELEASED_ACTION_REF), `no tag ${RELEASED_ACTION_REF}`);
});

test('package.json: publishable metadata and a runtime-only file list', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.bin, { pocp: 'bin/pocp.js' });
  assert.equal(pkg.repository.url, 'git+https://github.com/harriswekselblatt/pocp.git');
  assert.ok(pkg.bugs.url && pkg.homepage);
  for (const f of ['bin/', 'src/', 'examples/github/']) assert.ok(pkg.files.includes(f), f);
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), `files lists a missing ${f}`);
  assert.ok(!pkg.files.includes('docs/'), 'not every doc');
  for (const f of ['docs/demo.svg', 'docs/EVAL-PLAN.md', 'docs/FRICTION.md']) assert.ok(!pkg.files.includes(f), f);
});

test('verify and the reporter both run when a pull request is retargeted (edited)', () => {
  for (const rel of ['.github/workflows/pocp.yml', 'examples/github/pocp.yml']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /types: \[[^\]]*\bedited\b[^\]]*\]/, rel);
  }
  // The reporter follows every verify run.
  for (const rel of ['.github/workflows/pocp-status.yml', 'examples/github/pocp-status.yml']) {
    assert.match(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /\n {2}workflow_run:\n {4}workflows: \[pocp\]\n {4}types: \[completed\]\n/, rel);
  }
});

test('a wait turns green without a new run only from an isolated run: the approvable step is gated before any pull request code runs', () => {
  const verifyFiles = Object.entries(ALL()).filter(([f]) => /(^|\/)pocp\.yml$/.test(f));
  assert.equal(verifyFiles.length, 3);
  for (const [file, yaml] of verifyFiles) {
    const all = steps(yaml);
    const named = (n) => all.find((s) => keyOf(s, 'name') === n);
    const approvable = named('approvable');
    assert.ok(approvable, `${file}: no approvable step`);
    const cond = unguard(keyOf(approvable, 'if'));
    assert.doesNotMatch(cond, /outputs\.code|outcome/, `${file}: approvable must not depend on the code output`);
    const verify = named('verify');
    if (keyOf(verify, 'run')) {
      // The repo's own workflow: `plan`, from the base's verifier alone, decides isolation
      // before the verify step runs any of the pull request's code, and verify follows it. The
      // approval comes from verify's file, read by `mark` (after verify, only when isolated),
      // never from an output of the verify step, which a printed line could set.
      assert.equal(cond, "steps.mark.outputs.approvable == 'true'", file);
      const mark = all.find((s) => keyOf(s, 'id') === 'mark');
      assert.ok(mark && all.indexOf(mark) > all.indexOf(verify), `${file}: mark runs after verify`);
      assert.equal(keyOf(mark, 'if'), "steps.predict.outputs.skip != 'true' && (steps.plan.outputs.isolate == 'true')", file);
      assert.doesNotMatch(mark.join('\n'), /steps\.verify|cat |echo "\$labels"$/m, `${file}: mark reads only the file, and prints nothing`);
      assert.match(verify.join('\n'), /rm -f "\$APPROVAL_FILE"/, `${file}: no file left from before verify`);
      assert.match(verify.join('\n'), /APPROVAL_FILE: \$\{\{ runner\.temp \}\}\/pocp-approvable/, file);
      const planAt = all.findIndex((s) => keyOf(s, 'id') === 'plan');
      assert.ok(planAt >= 0 && planAt < all.indexOf(verify), `${file}: plan runs before verify`);
      assert.equal(keyOf(all[planAt], 'working-directory'), 'verifier', `${file}: plan runs the base's verifier, not the pull request's code`);
      assert.match(verify.join('\n'), /PLAN_ISOLATE: \$\{\{ steps\.plan\.outputs\.isolate \}\}/, file);
      assert.match(verify.join('\n'), /if \[ "\$PLAN_ISOLATE" = "true" \]; then\n\s+set -- "\$@" --isolate/, file);
    } else {
      // The action: its approvable output comes from its own file-reading step, which runs only
      // with isolate 'true' (an input the workflow sets).
      assert.match(cond, /^steps\.verify\.outputs\.approvable == 'true'$/, file);
      assert.match(verify.join('\n'), /isolate: true/, `${file}: the example isolates`);
    }
  }
  const action = read('action.yml');
  assert.match(action, /\n {2}approvable:\n(?: {4}.*\n)*? {4}value: \$\{\{ steps\.mark\.outputs\.approvable \}\}\n/);
  assert.match(action, /\n {2}approvable_needs:\n(?: {4}.*\n)*? {4}value: \$\{\{ steps\.mark\.outputs\.needs \}\}\n/);
  assert.match(action, /\n {6}id: mark\n {6}if: always\(\) && inputs\.isolate == 'true'\n/);
  // Removed first thing (before any exit), and passed only isolated with the bundled pocp.
  assert.match(action, /\n {6}run: \|\n {8}rm -f "\$APPROVAL_FILE"\n/);
  assert.match(action, /if \[ "\$ISOLATE" = "true" \] && \[ "\$\{#cmd\[@\]\}" -eq 0 \]; then args\+=\("--approval-file=\$APPROVAL_FILE"\); fi/);
  assert.equal((action.match(/--approval-file/g) || []).length, 1, 'passed in one place only');
  // Every needs-* step reads the file's list when there is one: those are the labels that decide.
  for (const [file, yaml] of verifyFiles) {
    for (const n of ['needs-tests', 'needs-policy', 'needs-inconclusive']) {
      const s = steps(yaml).find((x) => keyOf(x, 'name') === n);
      assert.match(unguard(keyOf(s, 'if')), /^contains\(steps\.(mark\.outputs\.approvable == 'true' && steps\.mark\.outputs\.needs|verify\.outputs\.approvable == 'true' && steps\.verify\.outputs\.approvable_needs) \|\| steps\.verify\.outputs\.needs, 'pocp-approve-/, `${file}: ${n}`);
    }
  }
});

test("on an approval label, verify is skipped only on the prediction, a step of the verify job that runs before the pull request's code", () => {
  const LABEL = "vars.POCP_STATUS_LIVE == 'true' && github.event.action == 'labeled' && startsWith(github.event.label.name, 'pocp-approve-')";
  const verifyFiles = Object.entries(ALL()).filter(([f]) => /(^|\/)pocp\.yml$/.test(f));
  for (const [file, yaml] of verifyFiles) {
    // One job: every run joins the per-pull-request concurrency group when its event arrives.
    assert.deepEqual(Object.keys(jobs(yaml)), ['verify'], file);
    const all = steps(yaml);
    const at = (pred) => all.findIndex(pred);
    const predict = at((s) => keyOf(s, 'id') === 'predict');
    const skipStep = at((s) => keyOf(s, 'name') === 'approved-without-run');
    const prCheckout = at((s) => /actions\/checkout@/.test(s.join('\n')) && /pull_request\.head\.sha/.test(s.join('\n')));
    assert.ok(predict > 0 && predict < skipStep && skipStep < prCheckout, `${file}: prediction, then approved-without-run, then the pull request's checkout`);
    assert.equal(keyOf(all[predict], 'if'), LABEL, file);
    assert.equal(keyOf(all[predict], 'continue-on-error'), 'true', `${file}: a failed prediction means verify runs`);
    assert.match(all[predict].join('\n'), /predict-approval/, file);
    // Before the pull request's checkout, only the default branch is checked out.
    for (const s of all.slice(0, prCheckout).filter((x) => /actions\/checkout@/.test(x.join('\n')))) {
      assert.match(s.join('\n'), /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, file);
      assert.equal(keyOf(s, 'if'), LABEL, file);
    }
    assert.doesNotMatch(yaml, /statuses: write|: write\b/, file);
  }
});
