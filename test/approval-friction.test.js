// POCP 1.4: fewer, plainer approvals for a maintainer who doesn't read code.
// - ci.files_except narrows what a repository protects (its docs), never a CI definition, and
//   adding an exemption is itself a loosening a maintainer approves.
// - Every hold says what changed in behaviour terms and what the label means.
// - One line names every label a pull request needs, with one command that adds them all, in
//   verify's output, the job summary and the `pocp` status (text only: never the result).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, pocp, read, sampleRepo, write, writeConfig } from './helpers.js';
import { ciProtects, configWeakening, DEFAULT_CI_FILES, strictConfig, validateConfig, withDefaults } from '../src/store.js';
import { addLabelsCommand, approvalPlan, explainFinding, explainGuard, LABEL_MEANS } from '../src/explain.js';
import { withFacts } from '../src/finding.js';
import { summarizeFindings } from '../src/decision.js';
import { readAnnotations } from '../src/approvals.js';
import { APPROVE_WORKFLOW_LABEL, changedWorkflowFiles, decideStatus, isWaitingText, NEEDS_MARKERS, runMarker, runNeeds, TEXT, waitingText, workflowFiles } from '../src/status-report.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CI = [...DEFAULT_CI_FILES];
const noHooks = (dir, msg) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg);

// ---- 1. what counts as protected -----------------------------------------------------------

test('ci.files_except exempts docs in a protected folder, never a CI definition', () => {
  const ci = { files: [...DEFAULT_CI, 'eval/**'], files_except: ['eval/**/README.md', '**'] };
  assert.equal(ciProtects('eval/README.md', ci), false);
  assert.equal(ciProtects('eval/e3/README.md', ci), false);
  // The catch-all exemption above can't reach a CI definition.
  for (const f of ['.github/workflows/pocp.yml', '.github/actions/x/action.yml', 'action.yml', '.gitlab-ci.yml']) assert.equal(ciProtects(f, ci), true, f);
  const narrow = { files: [...DEFAULT_CI, 'eval/**'], files_except: ['eval/**/README.md'] };
  for (const f of ['eval/run-tests.sh', 'eval/PREREG.md', 'eval/e1/prompt.md', 'eval/lib/stats.js', 'eval/e3/README.md.sh', 'eval/README.mdx']) assert.equal(ciProtects(f, narrow), true, f);
  // Only an exact CI definition path counts: an example file somewhere else isn't one.
  assert.equal(ciProtects('examples/gitlab/.gitlab-ci.yml', narrow), false);
  // The reporter's rule: CI definitions count even when ci.files leaves them out.
  assert.equal(ciProtects('.github/workflows/x.yml', { files: ['eval/**'], files_except: ['**'] }, { withDefaults: true }), true);
  assert.equal(ciProtects('.github/workflows/x.yml', { files: ['eval/**'] }), false, 'the engine keeps ci.files as written');
});

test('adding an exemption is a loosening, and a change is judged with only the exemptions both sides have', () => {
  const base = withDefaults({ ci: { files: [...DEFAULT_CI, 'eval/**'] } });
  const head = withDefaults({ ci: { files: [...DEFAULT_CI, 'eval/**'], files_except: ['eval/**'] } });
  assert.deepEqual(configWeakening(base, head), ['ci.files_except now exempts "eval/**"']);
  assert.deepEqual(configWeakening(head, base), [], 'removing an exemption is stricter');
  assert.deepEqual(strictConfig(base, head).ci.files_except, []);
  assert.deepEqual(strictConfig(head, head).ci.files_except, ['eval/**']);
  assert.deepEqual(validateConfig(withDefaults({ ci: { files_except: 'eval/**' } })), ['ci.files_except must be an array of globs']);
  assert.match(validateConfig(withDefaults({ ci: { files_except: ['eval/{a,b}'] } })).join(), /ci\.files_except: .*brace/);
});

function protectedRepo(ci) {
  const dir = sampleRepo();
  writeConfig(dir, { ci });
  write(dir, 'eval/judge.js', 'export const label = (passed) => (passed ? "honest" : "cheat");\n');
  write(dir, 'eval/README.md', '# eval\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'adopt');
  return dir;
}
const ciFindings = (v) => v.json.commits.flatMap((c) => c.findings).filter((f) => f.code === 'ci_config_changed' || f.code === 'policy_loosened');

test('verify: an exempt README edit needs no approval; the judging code next to it still does', () => {
  const dir = protectedRepo({ files: [...DEFAULT_CI, 'eval/**'], files_except: ['eval/**/README.md'] });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'eval/README.md', '# eval\n\nHow to read the results.\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'docs');
  const docs = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.deepEqual(ciFindings(docs), [], JSON.stringify(docs.json));
  write(dir, 'eval/judge.js', 'export const label = () => "honest";\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'judge');
  const judge = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(judge.code, 1);
  assert.deepEqual(ciFindings(judge).map((f) => f.code), ['ci_config_changed']);
});

test('verify: a change can\'t exempt the file it edits in the same pull request', () => {
  const dir = protectedRepo({ files: [...DEFAULT_CI, 'eval/**'] });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeConfig(dir, { ci: { files: [...DEFAULT_CI, 'eval/**'], files_except: ['eval/**'] } });
  write(dir, 'eval/judge.js', 'export const label = () => "honest";\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'exempt the judge and change it');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(v.code, 1);
  const codes = ciFindings(v).map((f) => f.code).sort();
  assert.ok(codes.includes('ci_config_changed'), codes.join());
  assert.ok(codes.includes('policy_loosened'), codes.join());
});

test('this repository: examples need no label; the whole evaluation, its plan, the rules and live CI still do', () => {
  // The evaluation's READMEs and plan carry its published numbers and rules (eval/README.md rule
  // 10), so this repository exempts none of them: a change there is a question a maintainer can
  // answer in plain words ("the published report changed").
  const cfg = withDefaults(JSON.parse(fs.readFileSync(path.join(ROOT, '.proof/config.json'), 'utf8')));
  assert.deepEqual(validateConfig(cfg), []);
  for (const f of ['examples/gitlab/.gitlab-ci.yml', 'examples/github/pocp.yml', 'README.md', 'docs/STATUS.md']) assert.equal(ciProtects(f, cfg.ci), false, `${f} needs no CI approval`);
  for (const f of ['.github/workflows/pocp.yml', 'action.yml', 'status/action.yml', 'eval/run-tests.sh', 'eval/PREREG.md', 'eval/campaign-123/README.md',
    'eval/README.md', 'docs/EVAL-PLAN.md', 'eval/lib/stats.js', 'eval/campaign-123/REPORT.md']) assert.equal(ciProtects(f, cfg.ci), true, `${f} stays protected`);
  const changed = changedWorkflowFiles(['examples/gitlab/.gitlab-ci.yml', 'status/action.yml', 'docs/STATUS.md'].map((filename) => ({ filename })), workflowFiles(cfg), cfg.ci.files_except);
  assert.deepEqual(changed, ['status/action.yml']);
});

test('red team: an exemption never reaches an action definition, and a malformed one fails closed', () => {
  const ci = { files: ['status/action.yml', 'tools/**'], files_except: ['**'] };
  assert.equal(ciProtects('status/action.yml', ci), true);
  assert.equal(ciProtects('tools/x/action.yaml', ci), true);
  assert.equal(ciProtects('tools/notes.md', ci), false);
  const bad = withDefaults({ ci: { files: ['eval/**'], files_except: 'eval/**' } });
  assert.equal(ciProtects('eval/x.js', bad.ci), true, 'a string is not a list of exemptions');
  assert.deepEqual(strictConfig(withDefaults({}), bad).ci.files_except, []);
  assert.ok(!configWeakening(withDefaults({}), bad).some((w) => w.includes('files_except')), 'no crash, and no exemption read from a string');
});

// ---- 2. plain words ------------------------------------------------------------------------

test('a behaviour change names the old test that now fails, and asks only whether it is intended', () => {
  const guard = { verdict: 'behavior-changed', old_tests: { runs: [{ check: 'unit', passed: false, failed_tests: ['add returns 5 for 2+3'] }] } };
  const s = explainGuard(guard, ['test/math.test.js']);
  assert.match(s, /^The old test "add returns 5 for 2\+3" now fails on the new code/);
  assert.match(s, /Approve only if that change in behaviour is intended\.$/);
  const dropped = explainGuard({ verdict: 'detection-dropped', detection: { lost: [{ file: 'src/math.js', line: 2, before: 'a + b', after: 'a - b' }] } }, ['test/math.test.js']);
  assert.match(dropped, /planted a small bug .* the edited tests \(test\/math\.test\.js\) miss \(for example in src\/math\.js line 2, changing `a \+ b` to `a - b`\)/);
  assert.match(explainFinding(withFacts({ code: 'ci_config_changed' }, { files: ['eval/judge.js'] })), /^Files this repository protects changed \(eval\/judge\.js\)/);
  assert.match(explainFinding(withFacts({ code: 'ci_config_changed' }, { files: ['.github/workflows/ci.yml'] })), /^The CI setup that checks pull requests changed/);
  const loose = explainFinding({ code: 'policy_loosened', detail: 'policy loosened without approval: a; b; c; d; e (re-run with --accept-policy-change once a maintainer approves)' });
  assert.equal(loose, "This change loosens POCP's own rules (a; b; c; and 2 more), so later changes are checked less strictly. Approve only if you want that.");
  // A test change with no guard result still gets words, never nothing.
  assert.match(explainFinding(withFacts({ code: 'test_change' }, { approval: 'tests', files: ['test/a.js'] })), /^Existing tests or test setup were edited \(test\/a\.js\)/);
  for (const [label, means] of Object.entries(LABEL_MEANS)) assert.ok(means.startsWith('I accept'), label);
});

test('the words never change the decision, and pocp approvals still reads the annotation', () => {
  const f = withFacts({ code: 'test_change', detail: 'existing tests or test setup changed (test/a.js); x', blocking: true }, { approval: 'tests', files: ['test/a.js'], guard: { verdict: 'behavior-changed', old_tests: { runs: [] } } });
  const s = summarizeFindings([f]);
  assert.equal(s.outcome, 'waiting');
  assert.equal(s.only, true);
  assert.equal(s.needs[0].plain.length, 1);
  const read = readAnnotations([{ title: 'POCP approval needed', message: JSON.stringify({ needs: s.needs }) }]);
  assert.equal(read.only, true);
});

test('one command adds every label, in a fixed order', () => {
  assert.equal(addLabelsCommand(['pocp-approve-workflow', 'pocp-approve-policy', 'pocp-approve-tests'], { number: 12, repository: 'o/r' }),
    'gh pr edit 12 -R o/r --add-label pocp-approve-tests,pocp-approve-policy,pocp-approve-workflow');
  const plan = approvalPlan([{ label: 'pocp-approve-policy', plain: ['p'] }], { extra: [{ label: 'pocp-approve-tests', plain: ['t'] }], number: 3 });
  assert.deepEqual(plan.items.map((i) => i.label), ['pocp-approve-tests', 'pocp-approve-policy']);
  assert.equal(plan.command, 'gh pr edit 3 --add-label pocp-approve-tests,pocp-approve-policy');
  assert.equal(approvalPlan([]), null);
});

// ---- 3. the pocp status --------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };
function job(pattern, needs = []) {
  const steps = [
    { name: runMarker(7, BASE), conclusion: 'success' },
    { name: 'verify', conclusion: pattern === 'verified' ? 'success' : 'failure' },
    { name: 'verified', conclusion: pattern === 'verified' ? 'success' : 'skipped' },
    ...Object.keys(NEEDS_MARKERS).map((name) => ({ name, conclusion: needs.includes(NEEDS_MARKERS[name]) ? 'success' : 'skipped' })),
    { name: 'waiting', conclusion: pattern === 'waiting' ? 'success' : 'skipped' },
    { name: 'inconclusive', conclusion: 'skipped' },
    { name: 'failed', conclusion: pattern === 'failed' ? 'failure' : 'skipped' },
  ];
  return { status: 'completed', conclusion: pattern === 'failed' ? 'failure' : 'success', steps };
}
const facts = (over = {}) => ({
  event_sha: SHA, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null),
  pr: { number: 7, state: 'open', head_sha: SHA, labels: [], author: 'author' },
  base_sha: BASE, changed_files: (over.files || [{ filename: 'src/x.js' }]).length, head_prs: [7], incomplete: [],
  files: [{ filename: 'src/x.js' }], label_events: [], label_events_complete: true, ...over,
  runs: (over.runs || []).map((j, i) => ({ id: i + 1, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: 'o/r', status: 'completed', conclusion: j.conclusion, created_at: `2026-01-0${i + 1}T00:00:00Z`, job: j })),
});

test('the pocp status names every label and the one command, and stays pending', () => {
  const d = decideStatus(facts({ runs: [job('waiting', ['pocp-approve-tests', 'pocp-approve-policy'])] }));
  assert.equal(d.state, 'pending');
  assert.equal(d.description, 'Waiting for approval (tests, rules). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests,pocp-approve-policy');
  // A changed workflow: its label and everything verify asked for, at once.
  const wf = decideStatus(facts({ files: [{ filename: '.github/workflows/pocp.yml' }], runs: [job('waiting', ['pocp-approve-tests'])] }));
  assert.equal(wf.state, 'pending');
  assert.equal(wf.description, 'Waiting for approval (tests, CI). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests,pocp-approve-workflow');
  // Even a run whose own steps claim success gets no green while its workflow is unapproved.
  const spoof = decideStatus(facts({ files: [{ filename: '.github/workflows/pocp.yml' }], runs: [job('verified', ['pocp-approve-tests'])] }));
  assert.equal(spoof.state, 'pending');
  // An older workflow without needs-* steps keeps the generic text.
  assert.equal(decideStatus(facts({ runs: [job('waiting')] })).description, TEXT.waiting);
});

test('the needs steps choose text only: a failed or verified run is decided as before', () => {
  assert.equal(decideStatus(facts({ runs: [job('failed', ['pocp-approve-tests'])] })).state, 'failure');
  assert.equal(decideStatus(facts({ runs: [job('verified', ['pocp-approve-tests'])] })).state, 'success');
  // Only the fixed labels can appear: a step with another name adds nothing.
  const odd = job('waiting', ['pocp-approve-tests']);
  odd.steps.push({ name: 'needs-anything; curl evil', conclusion: 'success' }, { name: 'needs-pocp-approve-everything', conclusion: 'success' });
  assert.deepEqual(runNeeds(odd), ['pocp-approve-tests']);
});

test('the status text fits GitHub\'s 140 characters, with or without the command', () => {
  const all = ['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-inconclusive', APPROVE_WORKFLOW_LABEL];
  const long = waitingText(all, { number: 123456, repository: 'a-rather-long-organisation-name/an-even-longer-repository-name' });
  assert.ok(long.length <= 140, long);
  assert.match(long, /^Waiting for approval: add pocp-approve-tests, pocp-approve-policy/);
  const short = waitingText(['pocp-approve-tests', 'pocp-approve-policy', APPROVE_WORKFLOW_LABEL], { number: 96, repository: 'harriswekselblatt/pocp' });
  assert.ok(short.length <= 140 && short.includes('gh pr edit 96'), short);
  for (const t of [long, short, TEXT.waiting]) assert.ok(isWaitingText(t), t);
});

// ---- verify, end to end --------------------------------------------------------------------

const NODE_TEST_RULES = {
  requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node --test --test-reporter=tap test/math.test.mjs' }, source: 'author' }],
};
const MATH_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.js';",
  "test('add returns 5 for 2+3', () => assert.equal(add(2, 3), 5));",
  '',
].join('\n');

test('verify on a pull request: the behaviour change in plain words, what the label means, and one command', () => {
  const dir = sampleRepo({ rules: NODE_TEST_RULES, deep: false });
  write(dir, 'test/math.test.mjs', MATH_TEST);
  git(dir, 'add', '-A');
  noHooks(dir, 'node tests');
  const base = git(dir, 'rev-parse', 'HEAD');
  // The agent changes what add(2,3) returns and edits the test to match.
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('return a + b;', 'return a + b + 1;'));
  write(dir, 'test/math.test.mjs', MATH_TEST.replace('equal(add(2, 3), 5)', 'equal(add(2, 3), 6)'));
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'add one more']).code, 0);
  noHooks(dir, 'add one more');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-friction-'));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/12/merge', GITHUB_OUTPUT: path.join(tmp, 'out'), GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md') };
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--exit-detail'], { env });
  assert.equal(v.code, 4, v.stdout + v.stderr);
  assert.match(v.stdout, /^NOT verified yet: waiting for a maintainer's approval/m);
  assert.match(v.stdout, /The old test "add returns 5 for 2\+3" now fails on the new code/);
  assert.match(v.stdout, /Adding it means: "I accept this change in what the code does, or in what its tests check". It does not mean "I reviewed the code"/);
  assert.match(v.stdout, /one command: gh pr edit 12 -R o\/r --add-label pocp-approve-tests$/m);
  // A wait is a warning on GitHub, not an error.
  assert.doesNotMatch(v.stdout, /^::error title=POCP::/m);
  assert.match(v.stdout, /^::warning title=POCP::/m);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /^needs=pocp-approve-tests$/m);
  // Not isolated here (the cooperative runner), so the wait is never offered as approvable:
  // the label re-runs verify, as before.
  assert.doesNotMatch(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /approvable/);
  // Nor is the approval file written (and one left from before is removed): not isolated.
  const approvalFile = path.join(tmp, 'pocp-approvable');
  fs.writeFileSync(approvalFile, 'pocp-approve-tests\n');
  const again = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--exit-detail', `--approval-file=${approvalFile}`], { env });
  assert.equal(again.code, 4, again.stdout + again.stderr);
  assert.equal(fs.existsSync(approvalFile), false);
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /gh pr edit 12 -R o\/r --add-label pocp-approve-tests/);
  assert.match(summary, /The old test "add returns 5 for 2\+3" now fails/);
  // The approval clears it, as before.
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--exit-detail', '--accept-test-change']).code, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('verify names pocp-approve-workflow when the base runs the reporter and CI files change', () => {
  const dir = sampleRepo({ deep: false });
  write(dir, '.github/workflows/pocp-status.yml', 'name: pocp-status\njobs: { report: { steps: [ { run: "pocp status-report" } ] } }\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'the reporter');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, '.github/workflows/ci.yml', 'name: ci\n');
  write(dir, 'docs/notes.md', 'notes\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'ci');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json', '--pull-request', '5', '--repo', 'o/r']);
  assert.deepEqual(v.json.workflow_approval, { label: APPROVE_WORKFLOW_LABEL, files: ['.github/workflows/ci.yml'] });
  assert.equal(v.json.approval_request.command, 'gh pr edit 5 -R o/r --add-label pocp-approve-policy,pocp-approve-workflow');
  assert.deepEqual(v.json.labels_needed, ['pocp-approve-policy', APPROVE_WORKFLOW_LABEL]);
});

test('approvable: only a wait for listed approvals, and only when the checks ran isolated', async () => {
  const { approvableWait } = await import('../src/commands/verify.js');
  const ok = { waitingOnly: true, outcome: 'waiting', secure: true, labels: ['pocp-approve-tests'] };
  assert.equal(approvableWait({ ...ok, trusting: true }), false, '--ci-results: what ran before verify is trusted');
  assert.equal(approvableWait(ok), true);
  assert.equal(approvableWait({ ...ok, labels: ['pocp-approve-tests', 'pocp-approve-workflow'] }), true);
  // Policy and inconclusive approvals are decided by a new run.
  assert.equal(approvableWait({ ...ok, labels: ['pocp-approve-tests', 'pocp-approve-policy'] }), false, 'policy changes the judge');
  assert.equal(approvableWait({ ...ok, labels: ['pocp-approve-workflow'] }), false, 'no test approval in it');
  assert.equal(approvableWait({ ...ok, outcome: 'inconclusive', labels: ['pocp-approve-inconclusive'] }), false, 'a check that did not finish');
  assert.equal(approvableWait({ ...ok, outcome: 'inconclusive' }), false);
  assert.equal(approvableWait({ ...ok, secure: false }), false, 'not isolated');
  assert.equal(approvableWait({ ...ok, secure: undefined }), false, 'isolation unknown');
  assert.equal(approvableWait({ ...ok, waitingOnly: false }), false, 'something else blocks');
  assert.equal(approvableWait({ ...ok, labels: [] }), false, 'no label named');
  assert.equal(approvableWait({ ...ok, labels: ['pocp-approve-tests', 'pocp-approve-coverage'] }), false, 'a label the workflow does not list');
});

test('nothing pocp prints can start a line a CI runner reads as a command', async () => {
  const { inertCommands } = await import('../src/cli/shared.js');
  // A file name with newlines, as git allows, inside a finding.
  const printed = inertCommands('BAD abc: tests changed (test/x\n::set-output name=approvable::true\n  ::add-mask::x\r\n.mjs)');
  for (const line of printed.split('\n')) assert.doesNotMatch(line, /^\s*::/, line);
  assert.doesNotMatch(printed, /\r/);
  assert.match(printed, /· ::set-output name=approvable::true/);
  assert.match(inertCommands('x\n##[set-output name=a;]true'), /^x\n· ##\[set-output/);
  assert.equal(inertCommands('plain\n  text'), 'plain\n  text');
});

test('a changed test file whose name holds a workflow command prints it inert', () => {
  const dir = sampleRepo({ rules: NODE_TEST_RULES, deep: false });
  const name = 'test/x\n::set-output name=approvable::true\n.test.mjs';
  write(dir, name, MATH_TEST);
  git(dir, 'add', '-A');
  noHooks(dir, 'odd name');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, name, MATH_TEST.replace('equal(add(2, 3), 5)', 'equal(add(2, 3), 6)'));
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('return a + b;', 'return a + b + 1;'));
  git(dir, 'add', '-A');
  pocp(dir, ['fix', '--intent', 'x']);
  noHooks(dir, 'x');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-inert-'));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/pull/12/merge', GITHUB_OUTPUT: path.join(tmp, 'out'), GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md') };
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--exit-detail'], { env });
  for (const line of `${v.stdout}\n${v.stderr}`.split('\n')) assert.doesNotMatch(line, /^\s*::(?!(warning|error|notice) title=POCP)/, line);
  assert.match(v.stdout, /· ::set-output name=approvable::true/, 'the name was printed, made inert');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the approval file: only for an isolated wait for pocp-approve-tests, never with --ci-results', async () => {
  const { approvalFileLabels } = await import('../src/commands/verify.js');
  const result = { approval: { outcome: 'waiting' }, labels_needed: ['pocp-approve-tests'] };
  const base = { result, flags: {}, secure: true, waitingOnly: true };
  assert.deepEqual(approvalFileLabels(base), ['pocp-approve-tests']);
  assert.equal(approvalFileLabels({ ...base, flags: { 'ci-results': ['r.jsonl'] } }), null);
  assert.equal(approvalFileLabels({ ...base, flags: { 'ci-results': 'r.jsonl' } }), null);
  assert.equal(approvalFileLabels({ ...base, secure: false }), null);
  assert.equal(approvalFileLabels({ ...base, result: { ...result, approval: { outcome: 'inconclusive' } } }), null);
});

test('test runs ignore the CI run\'s own pull request event (its labels must not change what verify reports)', () => {
  const ev = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { labels: [{ name: APPROVE_WORKFLOW_LABEL }] } }));
  const saved = process.env.GITHUB_EVENT_PATH;
  process.env.GITHUB_EVENT_PATH = ev;
  try {
    const dir = sampleRepo({ deep: false });
    write(dir, '.github/workflows/pocp-status.yml', 'name: pocp-status\njobs: { report: { steps: [ { run: "pocp status-report" } ] } }\n');
    git(dir, 'add', '-A');
    noHooks(dir, 'the reporter');
    const base = git(dir, 'rev-parse', 'HEAD');
    write(dir, '.github/workflows/ci.yml', 'name: ci\n');
    git(dir, 'add', '-A');
    noHooks(dir, 'ci');
    const v = pocp(dir, ['verify', `${base}..HEAD`, '--json', '--pull-request', '5', '--repo', 'o/r']);
    assert.deepEqual(v.json.workflow_approval, { label: APPROVE_WORKFLOW_LABEL, files: ['.github/workflows/ci.yml'] });
  } finally {
    if (saved === undefined) delete process.env.GITHUB_EVENT_PATH; else process.env.GITHUB_EVENT_PATH = saved;
  }
});
