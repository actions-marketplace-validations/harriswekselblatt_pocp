// The hold explanation (src/hold.js): one plain reason for every approval hold, the same in the
// pocp status, the reporter's one pull request comment (src/hold-comment.js), the terminal and
// agents' --json. The comment is posted only by the trusted reporter, sanitized, kept as one
// comment across runs, and can be turned off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdExplanation, holdReason, holdStatus, HOLD_LABELS, HOLD_VERDICTS, STATUS_MAX, terminalSafe } from '../src/hold.js';
import { summarizeFindings } from '../src/decision.js';
import { withFacts } from '../src/finding.js';
import { approvalFileBody } from '../src/commands/verify.js';
import { codeSpan, COMMENT_MARKER, COMMENT_MAX, diffLink, filesForLabel, holdComment, hunkRanges, upsertHoldComment } from '../src/hold-comment.js';
import { decideStatus, isWaitingText, reportStatus, runMarker, runVerdict, stillWaiting, TEXT, waitingText, workflowFiles } from '../src/status-report.js';
import { pendingApprovals, pendingHold } from '../src/remedies.js';
import { validateConfig, withDefaults } from '../src/store.js';
import { git, pocp, sampleRepo, writeRules } from './helpers.js';

const SHA = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };

// ---- the shared explanation ----------------------------------------------------------------

test('one sentence per hold, sharpened by the guard verdict, and one command for every label', () => {
  const h = holdExplanation([{ label: 'pocp-approve-tests', verdicts: ['needs-review'], files: ['test/x.test.js'] }, 'pocp-approve-policy', 'not-a-label'], { number: 7, repository: 'o/r' });
  assert.deepEqual(h.labels, ['pocp-approve-tests', 'pocp-approve-policy']);
  assert.equal(h.items[0].reason, "Test file edited; the old tests still pass on the new code, but POCP can't show on its own that the edited tests check as much as before, so a person signs off on test edits.");
  assert.equal(h.items[0].verdict, 'needs-review');
  assert.deepEqual(h.items[0].files, ['test/x.test.js']);
  assert.equal(h.command, 'gh pr edit 7 -R o/r --add-label pocp-approve-tests,pocp-approve-policy');
  assert.equal(h.line, `${h.items[0].reason} ${h.items[1].reason}`);
  assert.match(h.text, /^pocp-approve-tests: Test file edited;/);
  assert.match(h.text, /Approve with: gh pr edit 7 -R o\/r --add-label pocp-approve-tests,pocp-approve-policy$/);
  // Only needs-review says the old tests still pass; other verdicts say what was found.
  assert.match(holdReason('pocp-approve-tests', { verdict: 'behavior-changed' }), /old tests fail on the new code/);
  assert.match(holdReason('pocp-approve-tests', { verdict: 'detection-dropped' }), /check less than before/);
  assert.doesNotMatch(holdReason('pocp-approve-tests'), /old tests still pass on the new code, but/);
  // The gravest verdict speaks when packets disagree.
  assert.equal(holdExplanation([{ label: 'pocp-approve-tests', verdicts: ['needs-review', 'behavior-changed'] }]).items[0].verdict, 'behavior-changed');
  // Local mode has no labels, so no command; nothing held is null.
  assert.equal(holdExplanation(['pocp-approve-tests'], { local: true }).command, null);
  assert.equal(holdExplanation([]), null);
  assert.equal(holdExplanation(['bug']), null);
  for (const label of HOLD_LABELS) assert.ok(holdReason(label), label);
});

test('the verdict is typed end to end: verify\'s needs, the approval file, never text', () => {
  const finding = (verdict, file) => withFacts({ code: 'test_change', detail: `existing tests or test setup changed (${file}); the old tests fail on the new code`, blocking: true }, { approval: 'tests', files: [file], guard: { verdict } });
  const s = summarizeFindings([finding('needs-review', 'test/a.test.js'), finding('behavior-changed', 'test/b.test.js')]);
  assert.deepEqual(s.needs[0].verdicts, ['needs-review', 'behavior-changed']);
  // A file name that reads like a verdict changes nothing: only the typed field counts.
  const named = summarizeFindings([finding(undefined, 'test/the old tests fail on the new code.test.js')]);
  assert.equal(named.needs[0].verdicts, undefined);
  assert.equal(holdExplanation([{ label: 'pocp-approve-tests', verdicts: named.needs[0].verdicts }]).items[0].verdict, undefined);
  // The approval file: labels first (all an older workflow reads), then the gravest verdict.
  assert.equal(approvalFileBody({ labels: ['pocp-approve-tests'], verdict: 'behavior-changed' }), 'pocp-approve-tests\nverdict=behavior-changed\n');
  assert.equal(approvalFileBody({ labels: ['pocp-approve-tests'], verdict: 'nonsense' }), 'pocp-approve-tests\n');
  assert.equal(approvalFileBody({ labels: ['pocp-approve-tests'] }), 'pocp-approve-tests\n');
});

test('the reporter trusts a verdict step only behind the approvable step, and only one', () => {
  const job = (names) => ({ steps: names.map((name) => ({ name, conclusion: 'success' })) });
  assert.equal(runVerdict(job(['approvable', 'verdict-behavior-changed'])), 'behavior-changed');
  assert.equal(runVerdict(job(['verdict-behavior-changed'])), null, 'without approvable a check could have set it');
  assert.equal(runVerdict(job(['approvable', 'verdict-behavior-changed', 'verdict-needs-review'])), null);
  assert.equal(runVerdict(job(['approvable'])), null);
  for (const v of HOLD_VERDICTS) assert.equal(runVerdict(job(['approvable', `verdict-${v}`])), v);
});

test('the status says whether the old tests FAIL or still pass, never the same words for both', () => {
  const at = { number: 7, repository: 'o/r' };
  const fail = holdStatus(['pocp-approve-tests'], { ...at, verdict: 'behavior-changed' });
  const pass = holdStatus(['pocp-approve-tests'], { ...at, verdict: 'needs-review' });
  const unknown = holdStatus(['pocp-approve-tests'], at);
  assert.equal(fail, 'Waiting for approval (old tests FAIL on new code). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests');
  assert.equal(pass, 'Waiting for approval (tests edited, old tests pass). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests');
  assert.equal(new Set([fail, pass, unknown, holdStatus(['pocp-approve-tests'], { ...at, verdict: 'detection-dropped' }), holdStatus(['pocp-approve-tests'], { ...at, verdict: 'baseline-red' })]).size, 5);
  // Squeezed by a long repository, the serious case still says FAIL.
  const long = holdStatus(['pocp-approve-tests', 'pocp-approve-workflow'], { number: 104, repository: 'harriswekselblatt/pocp', verdict: 'behavior-changed' });
  assert.ok(long.length <= STATUS_MAX && /FAIL/.test(long), long);
  // Without a verdict the comment's sentence says it isn't known, rather than implying a pass.
  assert.match(holdReason('pocp-approve-tests'), /isn't known here/);
});

test('the gate, pocp fix and the hooks give the same sentence as the status and the comment', () => {
  const r = { warnings: [
    { code: 'awaiting_test_approval', detail: 'p1: the test-change check did not pass', verdict: 'needs-review' },
    { code: 'awaiting_policy_approval', detail: 'this loosens POCP policy' },
  ] };
  const pending = pendingApprovals(r);
  const hold = pendingHold(r);
  assert.deepEqual(pending.map((p) => p.why), hold.items.map((it) => it.reason));
  assert.equal(pending[0].why, holdReason('pocp-approve-tests', { verdict: 'needs-review' }));
  assert.equal(hold.command, 'gh pr edit <number> --add-label pocp-approve-tests,pocp-approve-policy');
  assert.equal(pendingHold({ ...r, local_mode: true }).command, null);
  assert.equal(pendingHold({ warnings: [] }), null);
});

// ---- the pocp status: 140 characters --------------------------------------------------------

test('the status names why and the command within 140 characters, degrading a step at a time', () => {
  assert.equal(holdStatus(['pocp-approve-tests'], { number: 7, repository: 'o/r' }), 'Waiting for approval (tests edited, verdict unknown). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests');
  // Too long with the few words: one word each. POCP's own two-label wait fits that way.
  assert.equal(holdStatus(['pocp-approve-tests', 'pocp-approve-workflow'], { number: 104, repository: 'harriswekselblatt/pocp' }), 'Waiting for approval (tests, CI). Run: gh pr edit 104 -R harriswekselblatt/pocp --add-label pocp-approve-tests,pocp-approve-workflow');
  // Too long even so: the command alone (the text before 1.5).
  const mid = holdStatus(['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-workflow'], { number: 1234, repository: 'some-org/some-repo' });
  assert.equal(mid, 'Waiting for approval. Run: gh pr edit 1234 -R some-org/some-repo --add-label pocp-approve-tests,pocp-approve-policy,pocp-approve-workflow');
  // Too long with the command: the reasons and the labels.
  const long = 'an-organisation-with-a-very-long-name/a-repository-with-an-even-longer-name';
  assert.equal(holdStatus(['pocp-approve-tests'], { number: 12345, repository: long }), 'Waiting for approval (tests edited, verdict unknown): add pocp-approve-tests');
  // Everything at once with a long repository: still within the limit.
  const all = holdStatus(HOLD_LABELS, { number: 99999, repository: long });
  assert.ok(all.length <= STATUS_MAX, all);
  assert.match(all, /^Waiting for approval/);
  for (const labels of [['pocp-approve-tests'], HOLD_LABELS, ['pocp-approve-workflow', 'pocp-approve-inconclusive']]) {
    for (const repository of ['o/r', long, `${'x'.repeat(100)}/${'y'.repeat(100)}`]) {
      const d = waitingText(labels, { number: 7, repository });
      assert.ok(d.length <= STATUS_MAX, `${d.length}: ${d}`);
      assert.ok(isWaitingText(d), d);
    }
  }
  assert.equal(waitingText([], { number: 7, repository: 'o/r' }), TEXT.waiting);
});

// ---- sanitizing what the pull request controls -----------------------------------------------

// Right-to-left override and zero-width space, built here so no invisible character sits in this file.
const RLO = String.fromCodePoint(0x202e);
const ZW = String.fromCodePoint(0x200b);
const EVIL = [
  'test/a\nb.test.js',
  'test/**bold**[link](https://evil.example)![img](https://evil.example/x.png).test.js',
  'test/@octocat #12 <!-- pocp-hold --> <script>.test.js',
  'test/`tick``s`.test.js',
  `test/${RLO}gnp.js${ZW}\u001b[31m.test.js`,
];

test('a file name is shown only as a code span: no newline, markdown, link, image, mention or comment gets out', () => {
  for (const name of EVIL) {
    const span = codeSpan(name);
    assert.ok(![...span].some((ch) => ['\n', '\r', '\u001b', RLO, ZW].includes(ch)), JSON.stringify(span));
    // The fence is longer than any backtick run inside, so the span can't be closed early.
    const fence = /^`+/.exec(span)[0];
    assert.ok(span.endsWith(` ${fence}`));
    assert.ok(!span.slice(fence.length, -fence.length).includes(fence), span);
  }
  assert.equal(codeSpan('x'.repeat(500)).length < 210, true);
  assert.equal(terminalSafe(`a\nb\u001b[2J${RLO}c`), 'a?b?[2J?c');
});

/**
 * The text of a comment body outside code (what GitHub renders as markdown): fenced blocks
 * dropped, then code spans by CommonMark's rule (a run of n backticks closes at the next run of
 * exactly n).
 */
function outsideCode(body) {
  const text = body.replace(/^```\n[\s\S]*?\n```$/gm, '');
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i++];
      continue;
    }
    const run = /^`+/.exec(text.slice(i))[0];
    let j = i + run.length;
    let close = -1;
    while (j < text.length) {
      const m = /`+/.exec(text.slice(j));
      if (!m) break;
      if (m[0].length === run.length) {
        close = j + m.index;
        break;
      }
      j += m.index + m[0].length;
    }
    if (close < 0) {
      out += run;
      i += run.length;
    } else i = close + run.length;
  }
  return out;
}

const waitingSteps = (needs = ['needs-tests']) => [
  { name: runMarker(7, BASE), conclusion: 'success' },
  { name: 'verify', conclusion: 'failure' },
  { name: 'verified', conclusion: 'skipped' },
  { name: 'waiting', conclusion: 'success' },
  { name: 'inconclusive', conclusion: 'skipped' },
  { name: 'failed', conclusion: 'skipped' },
  ...needs.map((name) => ({ name, conclusion: 'success' })),
];
const waitingRun = (needs) => ({ id: 100, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: 'o/r', status: 'completed', conclusion: 'success', created_at: '2026-11-19T10:00:00Z', run_attempt: 1, html_url: 'https://github.com/o/r/actions/runs/100', job: { status: 'completed', conclusion: 'success', steps: waitingSteps(needs) } });
const PATCH = '@@ -10,4 +10,5 @@ describe\n-  assert.equal(a, 1);\n+  assert.ok(a);\n@@ -40,2 +41,0 @@\n-x\n-y\n@@ -60 +60 @@\n+z';
const factsFor = (files, over = {}) => ({
  event_sha: SHA, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null), base_sha: BASE, changed_files: files.length, head_prs: [7], incomplete: [], label_events: [], label_events_complete: true,
  pr: { number: 7, state: 'open', head_sha: SHA, labels: [], author: 'author' }, files, runs: [waitingRun()], ...over,
});

test('the hold comment: the reason, the files and lines to look at, what the label means, and the command', () => {
  const files = [{ filename: 'test/x.test.js', status: 'modified', additions: 1, deletions: 3, patch: PATCH }, { filename: 'src/a.js', status: 'modified', additions: 2, deletions: 0, patch: '@@ -1 +1,2 @@' }];
  const f = factsFor(files);
  const d = decideStatus(f);
  assert.equal(d.state, 'pending');
  assert.deepEqual(d.hold, { labels: ['pocp-approve-tests'], workflow_files: [], verdict: null });
  const c = holdComment(d, f, { baseConfig: null });
  assert.equal(c.kind, 'hold');
  assert.ok(c.body.startsWith(`${COMMENT_MARKER}\n`));
  assert.ok(c.body.includes(holdReason('pocp-approve-tests')));
  assert.match(c.body, /Adding it means: "I accept this change in what the code does, or in what its tests check"/);
  assert.ok(c.body.includes('```\ngh pr edit 7 -R o/r --add-label pocp-approve-tests\n```'));
  // The test file, with links to its diff and to the lines changed; not the code file.
  assert.ok(c.body.includes(`${codeSpan('test/x.test.js')} +1 −3 · [diff](${diffLink('o/r', 7, 'test/x.test.js')})`));
  assert.ok(c.body.includes(`[lines 10–14](${diffLink('o/r', 7, 'test/x.test.js', 10)})`));
  assert.ok(c.body.includes(`[line 60](${diffLink('o/r', 7, 'test/x.test.js', 60)})`));
  assert.ok(!c.body.includes('src/a.js'));
  assert.match(c.body, /"pr_comment": false/);
  assert.match(diffLink('o/r', 7, 'test/x.test.js', 10), /^https:\/\/github\.com\/o\/r\/pull\/7\/files#diff-[0-9a-f]{64}R10$/);
  assert.deepEqual(hunkRanges(PATCH), [{ start: 10, end: 14 }, { start: 41, end: 40 }, { start: 60, end: 60 }]);
});

test('the hold comment renders hostile file names as code only', () => {
  const files = EVIL.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n+@@ -1 +999 @@' }));
  const f = factsFor(files);
  const c = holdComment(decideStatus(f), f, { baseConfig: null });
  const md = outsideCode(c.body);
  assert.doesNotMatch(md, /@octocat|evil\.example|<script|#12\b|\*\*bold/, md);
  // The marker is live only at the top: a file name carrying it is inside a code span.
  assert.ok(c.body.startsWith(COMMENT_MARKER));
  assert.equal(md.split(COMMENT_MARKER).length, 2, md);
  // One line per file: no file name added a line.
  assert.equal(c.body.split('\n').filter((l) => l.startsWith('- ')).length, EVIL.length);
  // A hunk header inside the patch's content is never read as one.
  assert.ok(!c.body.includes('R999'));
});

test('a CI change names the workflow files; a cleared hold says approved', () => {
  const files = [{ filename: '.github/workflows/pocp.yml', status: 'modified', additions: 1, deletions: 1, patch: '@@ -3,2 +3,2 @@' }];
  const f = factsFor(files);
  const d = decideStatus(f);
  assert.deepEqual(d.hold.labels, ['pocp-approve-tests', 'pocp-approve-workflow']);
  assert.deepEqual(d.hold.workflow_files, ['.github/workflows/pocp.yml']);
  assert.deepEqual(filesForLabel('pocp-approve-workflow', files, { workflowFiles: d.hold.workflow_files }).map((x) => x.filename), ['.github/workflows/pocp.yml']);
  const c = holdComment(d, f);
  assert.ok(c.body.includes(holdReason('pocp-approve-workflow')));
  const clear = holdComment({ write: true, sha: SHA, state: 'success', description: TEXT.approved, target_url: null }, f);
  assert.equal(clear.kind, 'status');
  assert.match(clear.body, /approved, nothing waiting/);
  assert.equal(holdComment({ write: false }, f), null);
});

test('only success says nothing is waiting: a status still waiting for a person says so', () => {
  const f = factsFor([{ filename: 'test/x.test.js' }]);
  const at = (state, description) => ({ write: true, sha: SHA, state, description, target_url: null });
  for (const description of [TEXT.waiting, TEXT.approvalUnverified, TEXT.approvalGone, TEXT.inconclusive]) {
    const d = at('pending', description);
    assert.equal(stillWaiting(d), true, description);
    const c = holdComment(d, f, { stillWaiting: stillWaiting(d) });
    assert.match(c.body, /still waiting for a maintainer/, description);
    assert.doesNotMatch(c.body, /nothing waiting/, description);
  }
  const pending = at('pending', TEXT.pending);
  assert.equal(stillWaiting(pending), false);
  assert.match(holdComment(pending, f, { stillWaiting: false }).body, /checking the newest commit/);
  assert.match(holdComment(at('failure', TEXT.failed), f).body, /not verified/);
  assert.doesNotMatch(holdComment(at('failure', TEXT.failed), f).body, /nothing waiting/);
});

test('a comment for a huge pull request stays under GitHub\'s limit, dropping detail first', () => {
  const name = (i) => `test/${'deep/'.repeat(30)}file-${i}.test.js`;
  const files = Array.from({ length: 3000 }, (_, i) => ({ filename: name(i), status: 'modified', additions: 1, deletions: 1, patch: Array.from({ length: 10 }, (_, k) => `@@ -${k * 10 + 1},2 +${k * 10 + 1},3 @@`).join('\n') }));
  const f = factsFor(files, { runs: [waitingRun(['needs-tests', 'needs-inconclusive', 'needs-policy'])] });
  const d = { write: true, sha: SHA, state: 'pending', description: 'x', target_url: null, hold: { labels: HOLD_LABELS, workflow_files: files.map((x) => x.filename) } };
  const c = holdComment(d, f);
  assert.ok(c.body.length <= COMMENT_MAX, String(c.body.length));
  assert.ok(c.body.includes('gh pr edit 7 -R o/r --add-label'));
  assert.ok(c.body.endsWith('</sub>'));
});

// ---- one comment, updated in place ----------------------------------------------------------

/** A fake comments API: every comment, and each write in order. */
function commentsApi(seed = []) {
  const comments = [...seed];
  const log = [];
  let id = 1000;
  const gh = {
    all: async (url) => {
      assert.match(url, /^\/repos\/o\/r\/issues\/7\/comments/);
      return comments.map((c) => ({ ...c }));
    },
    post: async (url, body) => {
      log.push(['POST', url]);
      const c = { id: id++, body: body.body, user: { login: 'github-actions[bot]', type: 'Bot' } };
      comments.push(c);
      return c;
    },
    patch: async (url, body) => {
      log.push(['PATCH', url]);
      const c = comments.find((x) => url.endsWith(`/comments/${x.id}`));
      if (!c || c.user.login !== 'github-actions[bot]') throw new Error('GitHub API 403');
      c.body = body.body;
      return c;
    },
    delete: async (url) => {
      log.push(['DELETE', url]);
      comments.splice(comments.findIndex((x) => url.endsWith(`/comments/${x.id}`)), 1);
    },
  };
  return { gh, comments, log };
}

test('the comment is posted once and updated in place across runs, never re-posted', async () => {
  const api = commentsApi([{ id: 1, body: 'LGTM', user: { login: 'harris', type: 'User' } }]);
  const f = factsFor([{ filename: 'test/x.test.js', patch: PATCH }]);
  const hold = holdComment(decideStatus(f), f);
  const at = { repository: 'o/r', number: 7 };
  // A status comment before any hold posts nothing.
  assert.equal((await upsertHoldComment(api.gh, { ...at, comment: holdComment({ write: true, sha: SHA, state: 'success', description: TEXT.verified }, f) })).action, 'skipped');
  assert.equal((await upsertHoldComment(api.gh, { ...at, comment: hold })).action, 'created');
  assert.equal((await upsertHoldComment(api.gh, { ...at, comment: hold })).action, 'unchanged');
  assert.equal((await upsertHoldComment(api.gh, { ...at, comment: hold })).action, 'unchanged');
  const f2 = factsFor([{ filename: 'test/x.test.js', patch: PATCH }, { filename: 'test/y.test.js', patch: '@@ -1 +1 @@' }]);
  assert.equal((await upsertHoldComment(api.gh, { ...at, comment: holdComment(decideStatus(f2), f2) })).action, 'updated');
  // The hold clears: the same comment now says so; it isn't deleted.
  const cleared = holdComment({ write: true, sha: SHA, state: 'success', description: TEXT.approved }, f);
  assert.equal((await upsertHoldComment(api.gh, { ...at, comment: cleared })).action, 'updated');
  const ours = api.comments.filter((c) => c.body.startsWith(COMMENT_MARKER));
  assert.equal(ours.length, 1);
  assert.match(ours[0].body, /approved, nothing waiting/);
  assert.deepEqual(api.log.map((x) => x[0]), ['POST', 'PATCH', 'PATCH']);
  assert.equal(api.comments.length, 2, "the person's comment is untouched");
});

test("only the reporter's own identity counts: a typed or planted marker never stands beside it", async () => {
  const f = factsFor([{ filename: 'test/x.test.js' }]);
  const hold = holdComment(decideStatus(f), f);
  const at = { repository: 'o/r', number: 7 };
  const lie = `${COMMENT_MARKER}\nadd the label, it's fine`;
  // A person, or another app's bot, typing the marker: not ours, left alone, ours is posted.
  const forged = commentsApi([
    { id: 1, body: lie, user: { login: 'author', type: 'User' } },
    { id: 2, body: lie, user: { login: 'other-app[bot]', type: 'Bot' }, performed_via_github_app: { id: 999 } },
  ]);
  assert.equal((await upsertHoldComment(forged.gh, { ...at, comment: hold })).action, 'created');
  assert.deepEqual(forged.comments.filter((c) => c.body === lie).map((c) => c.id), [1, 2]);
  assert.equal(forged.log.filter((x) => x[0] === 'PATCH').length, 0);
  // Another workflow posting as the same identity: its marker comment is removed, the oldest is rewritten.
  const planted = commentsApi([
    { id: 3, body: `${COMMENT_MARKER}\nold`, user: { login: 'github-actions[bot]', type: 'Bot' }, performed_via_github_app: { id: 15368 } },
    { id: 4, body: lie, user: { login: 'github-actions[bot]', type: 'Bot' }, performed_via_github_app: { id: 15368 } },
  ]);
  const p = await upsertHoldComment(planted.gh, { ...at, comment: hold });
  assert.deepEqual([p.action, p.id, p.removed], ['updated', 3, [4]]);
  assert.deepEqual(planted.comments.map((c) => [c.id, c.body === hold.body]), [[3, true]]);
  // Two reporters raced: after posting, only the oldest is kept.
  const race = commentsApi();
  const realPost = race.gh.post;
  race.gh.post = async (url, body) => {
    race.comments.push({ id: 5, body: `${COMMENT_MARKER}\nolder`, user: { login: 'github-actions[bot]', type: 'Bot' } });
    return realPost(url, body);
  };
  const r = await upsertHoldComment(race.gh, { ...at, comment: hold });
  assert.deepEqual([r.action, r.id], ['created', 5]);
  assert.deepEqual(race.comments.map((c) => [c.id, c.body === hold.body]), [[5, true]]);
  // An error editing our own comment never posts a second.
  const down = commentsApi([{ id: 1, body: `${COMMENT_MARKER}\nold`, user: { login: 'github-actions[bot]', type: 'Bot' } }]);
  down.gh.patch = async () => { throw new Error('GitHub API PATCH /repos/o/r/issues/comments/1: 502 bad gateway'); };
  const r502 = await upsertHoldComment(down.gh, { ...at, comment: hold });
  assert.equal(r502.action, 'skipped');
  assert.match(r502.reason, /502/);
  assert.equal(down.comments.length, 1);
  // A failure is reported, never thrown.
  const broken = { all: async () => { throw new Error('GitHub API 502'); } };
  assert.match((await upsertHoldComment(broken, { ...at, comment: hold })).reason, /502/);
  assert.equal((await upsertHoldComment(null, { ...at, comment: hold })).action, 'skipped');
});

// ---- through the reporter, and the opt-out ----------------------------------------------------

function reporter(needs) {
  const writes = [];
  const pr = { number: 7, state: 'open', head: { sha: SHA }, base: { sha: BASE }, changed_files: 1, labels: [], user: { login: 'author' } };
  const gh = {
    get: async (url) => {
      if (url.endsWith('/pulls/7')) return pr;
      if (url.includes('/actions/workflows/pocp.yml')) return WF;
      throw new Error(`unexpected GET ${url}`);
    },
    all: async (url) => {
      if (url.includes('/pulls?state=open')) return [{ number: 7, state: 'open', head: { sha: SHA } }];
      if (url.includes('/pulls/7/files')) return [{ filename: 'test/x.test.js', status: 'modified', additions: 1, deletions: 3, patch: PATCH }];
      if (url.includes('/runs?')) return [{ ...waitingRun(needs), job: undefined, repository: { full_name: 'o/r' } }];
      if (url.includes('/jobs')) return [{ name: 'verify', ...waitingRun(needs).job }];
      return [];
    },
    post: async (url, body) => writes.push(['status', body.state, body.description]),
  };
  const comments = commentsApi();
  return { gh, writes, comments };
}

test('the reporter writes the status, then the comment, with the labels token; ci.pr_comment false turns it off', async () => {
  const on = reporter();
  const r = await reportStatus(on.gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, labelGh: on.comments.gh });
  assert.deepEqual(on.writes, [['status', 'pending', 'Waiting for approval (tests edited, verdict unknown). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests']]);
  assert.equal(r.comment.action, 'created');
  assert.equal(on.comments.comments.length, 1);
  assert.ok(on.comments.comments[0].body.includes(holdReason('pocp-approve-tests')));
  const again = await reportStatus(on.gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, labelGh: on.comments.gh });
  assert.equal(again.comment.action, 'unchanged');

  // An isolated run that says what the guard found: the status and the comment say it too.
  const failing = reporter(['needs-tests', 'approvable', 'verdict-behavior-changed']);
  const fr = await reportStatus(failing.gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, labelGh: failing.comments.gh });
  assert.equal(fr.decision.description, 'Waiting for approval (old tests FAIL on new code). Run: gh pr edit 7 -R o/r --add-label pocp-approve-tests');
  assert.ok(failing.comments.comments[0].body.includes(holdReason('pocp-approve-tests', { verdict: 'behavior-changed' })));

  const off = reporter();
  const baseConfig = withDefaults({ pocp: 1, ci: { pr_comment: false } });
  const o = await reportStatus(off.gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig, labelGh: off.comments.gh });
  assert.equal(off.writes.length, 1, 'the status is still written');
  assert.equal(o.comment.action, 'skipped');
  assert.deepEqual(off.comments.log, []);
  assert.equal(off.comments.comments.length, 0);
  // A dry run previews the comment and writes nothing.
  const dry = reporter();
  const p = await reportStatus(dry.gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, labelGh: dry.comments.gh, dryRun: true });
  assert.equal(p.comment.action, 'dry-run');
  assert.ok(p.comment.body.startsWith(COMMENT_MARKER));
  assert.deepEqual([dry.writes, dry.comments.log], [[], []]);
});

test('ci.pr_comment must be true or false', () => {
  assert.deepEqual(validateConfig(withDefaults({ pocp: 1, ci: { pr_comment: false } })).filter((p) => /pr_comment/.test(p)), []);
  assert.ok(validateConfig(withDefaults({ pocp: 1, ci: { pr_comment: 'no' } })).includes('ci.pr_comment must be true or false'));
});

test('pocp gate, the hook and pocp fix print the hold sentence and command, and carry it in --json', () => {
  const dir = sampleRepo({ hooks: true });
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  const reason = holdReason('pocp-approve-policy');
  // pocp fix: even with nothing to prove, it says a maintainer must approve, and why.
  const fh = pocp(dir, ['fix', '--intent', 'loosen the rules', '--test', 'node -e 0']);
  assert.equal(fh.code, 0, fh.stderr);
  assert.ok(fh.stdout.includes(`why: ${reason}`), fh.stdout);
  assert.ok(fh.stdout.includes('the maintainer approves with: gh pr edit <number> --add-label pocp-approve-policy'), fh.stdout);
  const g = pocp(dir, ['gate', '--json']);
  assert.deepEqual(g.json.hold.labels, ['pocp-approve-policy']);
  assert.equal(g.json.hold.line, reason);
  assert.equal(g.json.hold.command, 'gh pr edit <number> --add-label pocp-approve-policy');
  assert.equal(g.json.pending_approvals[0].why, reason);
  const human = pocp(dir, ['gate']);
  assert.ok(human.stdout.includes(`why: ${reason}`), human.stdout);
  assert.ok(human.stdout.includes('the maintainer approves with: gh pr edit <number> --add-label pocp-approve-policy'), human.stdout);
  const f = pocp(dir, ['fix', '--json']);
  assert.equal(f.json.hold.line, reason);
  // The pre-commit hook runs the same gate, so a commit prints the same words.
  const c = spawnSync('git', ['commit', '-qm', 'loosen'], { cwd: dir, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  assert.ok(`${c.stdout}${c.stderr}`.includes(`why: ${reason}`), `${c.stdout}${c.stderr}`);
});

test('a comment posted as another identity is taken back, so it is never posted on every run', async () => {
  const f = factsFor([{ filename: 'test/x.test.js' }]);
  const hold = holdComment(decideStatus(f), f);
  const api = commentsApi();
  const realPost = api.gh.post;
  // labels-token set to a personal token: the comment comes back as that person.
  api.gh.post = async (url, body) => {
    const c = await realPost(url, body);
    c.user = { login: 'someone', type: 'User' };
    return c;
  };
  const r = await upsertHoldComment(api.gh, { repository: 'o/r', number: 7, comment: hold });
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /labels-token must be github\.token/);
  assert.equal(api.comments.length, 0);
});

// ---- the CI files carry the verdict exactly as the reporter reads it ---------------------------

// The verdict-* steps (null: none), and which files hold a mark step (the example uses the action's).
const CI_FILES = { '.github/workflows/pocp.yml': 'steps.mark.outputs', 'examples/github/pocp.yml': 'steps.verify.outputs', 'action.yml': null };
const MARK_FILES = ['.github/workflows/pocp.yml', 'action.yml'];
const readRepo = (p) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8');

/** The `run:` script of the step with `id: mark` in a workflow or action file. */
function markScript(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*(- )?id: mark\s*$/.test(l));
  assert.ok(at >= 0, 'no mark step');
  const run = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  const indent = /^\s*/.exec(lines[run + 1])[0].length;
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && /^\s*/.exec(l)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

test('the four verdict words agree in hold.js, the mark steps and the verdict-* steps of every CI file', () => {
  for (const [file, outputs] of Object.entries(CI_FILES)) {
    const text = readRepo(file);
    if (MARK_FILES.includes(file)) assert.ok(text.includes(`verdict=(${HOLD_VERDICTS.join('|')})`), `${file}: mark accepts exactly ${HOLD_VERDICTS.join(', ')}`);
    if (!outputs) continue;
    for (const v of HOLD_VERDICTS) {
      assert.ok(text.includes(`- name: verdict-${v}\n`), `${file}: verdict-${v}`);
      assert.ok(text.includes(`${outputs}.approvable == 'true' && ${outputs === 'steps.mark.outputs' ? 'steps.mark.outputs.verdict' : 'steps.verify.outputs.approvable_verdict'} == '${v}'`), `${file}: verdict-${v} needs approvable`);
    }
  }
  assert.ok(readRepo('action.yml').includes('value: ${{ steps.mark.outputs.verdict }}'));
});

test('every mark step passes only the four verdict words, and never fails the job', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-mark-'));
  const cases = [
    ['pocp-approve-tests\n', 'approvable=true\nneeds=pocp-approve-tests\n'],
    ['pocp-approve-tests\nverdict=behavior-changed\n', 'approvable=true\nneeds=pocp-approve-tests\nverdict=behavior-changed\n'],
    ['pocp-approve-tests\nverdict=behavior-changed; touch pwned\nverdict=evil\nverdict=needs-review\n', 'approvable=true\nneeds=pocp-approve-tests\nverdict=needs-review\n'],
    ['pocp-approve-tests\n verdict=needs-review\n', 'approvable=true\nneeds=pocp-approve-tests\n'],
    ['not a label\nverdict=needs-review\n', ''],
  ];
  for (const file of MARK_FILES) {
    const script = path.join(dir, 'mark.sh');
    fs.writeFileSync(script, markScript(readRepo(file)));
    for (const [content, want] of cases) {
      fs.writeFileSync(path.join(dir, 'approvable'), content);
      fs.writeFileSync(path.join(dir, 'out'), '');
      // GitHub runs `shell: bash` steps with -e and pipefail.
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, APPROVAL_FILE: path.join(dir, 'approvable'), GITHUB_OUTPUT: path.join(dir, 'out') } });
      assert.equal(r.status, 0, `${file}: ${r.stderr}`);
      assert.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), want, `${file}: ${JSON.stringify(content)}`);
      assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
    }
  }
});
