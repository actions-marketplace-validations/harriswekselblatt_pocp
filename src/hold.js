// Why POCP holds a change for a person, said the same way everywhere a maintainer works: the
// `pocp` status on GitHub, the one pull request comment the trusted reporter keeps, the
// terminal (`pocp fix`, the git hooks, `pocp gate`, `pocp approvals`) and an agent's session
// (their --json). Words only: decision.js and status-report.js decide; nothing here does.
//
// Every sentence is a fixed phrase chosen by typed facts: the label, and the test guard's
// verdict when the caller knows it. File and test names a pull request controls never go into
// a sentence; callers list them separately, sanitized for where they are shown.
import { addLabelsCommand, APPROVE_WORKFLOW_LABEL, LABEL_MEANS, sortLabels } from './explain.js';

/** GitHub's limit for a commit status description. */
export const STATUS_MAX = 140;

/** A few words per label, for the status line (it has room for little else). */
export const HOLD_SHORT = Object.freeze({
  'pocp-approve-tests': 'tests edited, verdict unknown',
  'pocp-approve-policy': 'POCP rules changed',
  'pocp-approve-inconclusive': "a test check didn't finish",
  'pocp-approve-coverage': 'files without proof',
  [APPROVE_WORKFLOW_LABEL]: 'CI changed',
});

// One word each, for when the few words don't fit beside the command.
const HOLD_TINY = Object.freeze({
  'pocp-approve-tests': 'tests',
  'pocp-approve-policy': 'rules',
  'pocp-approve-inconclusive': 'unfinished check',
  'pocp-approve-coverage': 'no proof',
  [APPROVE_WORKFLOW_LABEL]: 'CI',
});

// One sentence per test-guard verdict (guard-check.js): what POCP found, and why a person
// decides. Only `needs-review` may say the old tests still pass.
const TESTS_BY_VERDICT = Object.freeze({
  'needs-review': "Test file edited; the old tests still pass on the new code, but POCP can't show on its own that the edited tests check as much as before, so a person signs off on test edits.",
  'behavior-changed': 'Test file edited; the old tests fail on the new code, so the code now behaves differently and the edited tests accept that. A person decides whether the new behaviour is intended.',
  'detection-dropped': 'Test file edited; the edited tests miss a planted bug the old tests caught, so they now check less than before. A person decides whether checking less is intended.',
  'baseline-red': "Test file edited; the old tests were already failing before this change, so POCP can't compare old and new. A person signs off on the edited tests.",
});
// The gravest first: when several packets disagree, it speaks for the label.
const VERDICT_ORDER = ['behavior-changed', 'detection-dropped', 'baseline-red', 'needs-review'];
/** The test-guard verdicts a hold can name (guard-check.js), gravest first. */
export const HOLD_VERDICTS = Object.freeze([...VERDICT_ORDER]);
const SERIOUS = ['behavior-changed', 'detection-dropped'];
// The status line's few words for a test hold, by verdict: the serious case must not read like
// the review-only one. Without a verdict it says so.
const TESTS_SHORT = Object.freeze({
  'behavior-changed': 'old tests FAIL on new code',
  'detection-dropped': 'edited tests catch less',
  'baseline-red': 'old tests already failing',
  'needs-review': 'tests edited, old tests pass',
});
const TESTS_TINY = Object.freeze({
  'behavior-changed': 'tests FAIL',
  'detection-dropped': 'tests weaker',
  'baseline-red': 'tests already failing',
  'needs-review': 'tests edited',
});
/** The gravest of several guard verdicts, or null. */
export const gravestVerdict = (verdicts = []) => VERDICT_ORDER.find((v) => verdicts.includes(v)) || null;

const REASON = Object.freeze({
  'pocp-approve-tests': "Existing tests or test setup were edited, and POCP's mechanical check couldn't clear the edit on its own. Whether the old tests still pass on the new code isn't known here: read the verify run before approving.",
  'pocp-approve-policy': "POCP's own rules or protected files changed. A change can't approve the rules that judge it, so a person signs off.",
  'pocp-approve-inconclusive': "A check on the edited tests didn't finish (it timed out or was stopped), so nothing is known about them yet. Re-run it first; a person can accept merging without it.",
  'pocp-approve-coverage': 'Commits are going in without proof. A person accepts that.',
  [APPROVE_WORKFLOW_LABEL]: "CI files changed, so this pull request's own CI result can't be trusted until a person accepts the new workflow.",
});

/** Labels a hold can name. */
export const HOLD_LABELS = Object.freeze(Object.keys(REASON));
const KNOWN = new Set(HOLD_LABELS);

/** The plain sentence for one label, sharpened by the guard's verdict when it is known. */
export function holdReason(label, { verdict = null } = {}) {
  if (label === 'pocp-approve-tests' && TESTS_BY_VERDICT[verdict]) return TESTS_BY_VERDICT[verdict];
  return REASON[label] || null;
}

/**
 * The hold explanation: every label a change waits for, one sentence each, what the label
 * means, and the one command that adds them all. `needs`: label names, or
 * [{ label, verdicts?, files? }] (decision.js). Unknown labels are dropped. `local`: local mode
 * has no labels, so no command. Returns null when nothing is held, else
 * { labels, items: [{ label, reason, means, files, verdict? }], command, line, text }
 *   line: every reason on one line; text: the full explanation, several lines.
 */
export function holdExplanation(needs = [], { number = null, repository = null, local = false } = {}) {
  const byLabel = new Map();
  for (const n of needs || []) {
    const label = typeof n === 'string' ? n : n?.label;
    if (!KNOWN.has(label)) continue;
    const it = byLabel.get(label) || { verdicts: [], files: [] };
    for (const v of [].concat(n?.verdicts || [], n?.verdict || [])) if (VERDICT_ORDER.includes(v) && !it.verdicts.includes(v)) it.verdicts.push(v);
    for (const f of n?.files || []) if (typeof f === 'string' && !it.files.includes(f)) it.files.push(f);
    byLabel.set(label, it);
  }
  if (!byLabel.size) return null;
  const labels = sortLabels([...byLabel.keys()]);
  const items = labels.map((label) => {
    const it = byLabel.get(label);
    const verdict = label === 'pocp-approve-tests' ? gravestVerdict(it.verdicts) : null;
    return { label, reason: holdReason(label, { verdict }), means: LABEL_MEANS[label] || null, files: it.files, ...(verdict ? { verdict } : {}) };
  });
  const command = local ? null : addLabelsCommand(labels, { number, repository });
  const line = items.map((it) => it.reason).join(' ');
  const text = [
    ...items.flatMap((it) => [`${it.label}: ${it.reason}`, ...(it.means ? [`  Adding it means: "${it.means}". It does not mean "I reviewed the code".`] : [])]),
    ...(command ? [`Approve with: ${command}`] : []),
  ].join('\n');
  return { labels, items, command, line, text };
}

/**
 * The `pocp` status description for a wait on labels, within GitHub's 140 characters, from fixed
 * phrases, the labels, the test guard's typed verdict and the pull request's number and repository
 * only. The verdict decides the words for a test hold: "old tests FAIL on new code" must never
 * read like "old tests pass". It degrades a step at a
 * time: reasons and the command; one word per reason and the command; the command alone; reasons
 * and the labels; the labels alone; cut. For old tests failing or catching less, the reasons and
 * labels come before the command alone. Always starts "Waiting for approval" (status-report.js isWaitingText). null for no label.
 */
export function holdStatus(labels, { number = null, repository = null, verdict = null } = {}) {
  const sorted = sortLabels((labels || []).filter((l) => KNOWN.has(l)));
  if (!sorted.length) return null;
  const short = (l) => (l === 'pocp-approve-tests' && TESTS_SHORT[verdict]) || HOLD_SHORT[l];
  const tinyOf = (l) => (l === 'pocp-approve-tests' && TESTS_TINY[verdict]) || HOLD_TINY[l];
  const why = sorted.map(short).join(', ');
  const command = addLabelsCommand(sorted, { number, repository });
  const tiny = sorted.map(tinyOf).join(', ');
  const withCommand = [`Waiting for approval (${why}). Run: ${command}`, `Waiting for approval (${tiny}). Run: ${command}`];
  const commandOnly = `Waiting for approval. Run: ${command}`;
  const withLabels = [`Waiting for approval (${why}): add ${sorted.join(', ')}`, `Waiting for approval (${tiny}): add ${sorted.join(', ')}`];
  // Old tests failing, or tests that catch less: the words outrank the command, so the serious
  // case never reads like any other wait.
  const serious = sorted.includes('pocp-approve-tests') && SERIOUS.includes(verdict);
  const tries = [...withCommand, ...(serious ? [...withLabels, commandOnly] : [commandOnly, ...withLabels]), `Waiting for approval: add ${sorted.join(', ')}`];
  return tries.find((t) => t.length <= STATUS_MAX) || `${tries.at(-1).slice(0, STATUS_MAX - 1)}…`;
}

// C0 and C1 controls (newline and ESC included), DEL, zero-width and bidi controls, line and
// paragraph separators, the byte-order mark.
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
export const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'g');

/**
 * Text a pull request (or a check it ran) controls, made safe to print in a terminal: no
 * escape sequences, control, bidi or zero-width characters, one line, at most `max` characters.
 */
export function terminalSafe(text, max = 300) {
  const s = String(text ?? '').replace(UNSAFE_CHARS, '?');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
