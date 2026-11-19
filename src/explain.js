// Every hold, said in plain words for a maintainer who doesn't read code: what changed, in
// terms of behaviour, what the approval label means, and the one command that adds every
// label a pull request waits for. Built from typed facts only (finding.js), never from a
// finding's detail text, and never used to decide anything: decision.js decides.
import { factsOf } from './finding.js';
import { DEFAULT_CI_FILES } from './store.js';
import { matchGlob } from './glob.js';

export const APPROVE_WORKFLOW_LABEL = 'pocp-approve-workflow';

/** What adding each label says, in the maintainer's words. None of them says "I reviewed the code". */
export const LABEL_MEANS = Object.freeze({
  'pocp-approve-tests': 'I accept this change in what the code does, or in what its tests check',
  'pocp-approve-policy': 'I accept this change to the rules or protected files',
  'pocp-approve-inconclusive': "I accept merging without that check's result",
  'pocp-approve-coverage': 'I accept these files going in without proof',
  [APPROVE_WORKFLOW_LABEL]: 'I accept this change to the CI workflow',
});

// The order labels are listed in, so the same pull request always gets the same command.
const ORDER = ['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-inconclusive', 'pocp-approve-coverage', APPROVE_WORKFLOW_LABEL];
const rank = (label) => (ORDER.includes(label) ? ORDER.indexOf(label) : ORDER.length);
export const sortLabels = (labels) => [...new Set(labels)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

const quoteList = (xs, n = 3) => {
  const shown = xs.slice(0, n).map((x) => `"${x}"`);
  const more = xs.length > n ? ` and ${xs.length - n} more` : '';
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}${more}` : `${shown[0]}${more}`;
};
const fileList = (xs, n = 4) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));
const plural = (n, one, many) => (n === 1 ? one : many);

/** The failing test names a guard result recorded for the old tests on the new code. */
function failingOldTests(guard) {
  const names = guard?.adjudication?.failing_on_new_code || (guard?.old_tests?.runs || []).filter((r) => !r.passed).flatMap((r) => r.failed_tests || []);
  return [...new Set(names)];
}

/** One plain sentence for what the test guard found, from its result (guard-check.js), or null. */
export function explainGuard(guard, files = []) {
  if (!guard) return null;
  const where = files.length ? ` (${fileList(files)})` : '';
  switch (guard.verdict) {
    case 'behavior-changed': {
      const names = failingOldTests(guard);
      const who = names.length ? `The old ${plural(names.length, 'test', 'tests')} ${quoteList(names)} now ${plural(names.length, 'fails', 'fail')}` : 'Old tests that passed before now fail';
      return `${who} on the new code: the change makes the code do something different from what ${plural(names.length, 'that test', 'those tests')} checked, and the edited tests accept the new behaviour. Approve only if that change in behaviour is intended.`;
    }
    case 'detection-dropped': {
      const lost = guard.detection?.lost || [];
      const ex = lost[0];
      const example = ex ? ` (for example in ${ex.file} line ${ex.line}, changing \`${ex.before}\` to \`${ex.after}\`)` : '';
      const n = lost.length || 1;
      return `POCP planted ${plural(n, 'a small bug', `${n} small bugs`)} in the code that the old tests caught and the edited tests${where} miss${example}: the tests now check less than before. Approve only if checking less there is intended.`;
    }
    case 'baseline-red':
      return `Existing tests were edited${where}, and the old tests were already failing before this change, so POCP can't tell whether the change altered what the code does. Approve only if you accept the edited tests as they are.`;
    case 'needs-review': {
      const why = (guard.structural?.reasons || []).slice(0, 2).map((r) => `${r.file}: ${r.why}`).join('; ');
      return `Tests or test setup changed${where}. The old tests still pass on the new code, but fast mode plants no bugs, so POCP can't show the edited tests still catch what they caught${why ? ` (${why})` : ''}. Approve only if you accept the test edits.`;
    }
    default:
      return null;
  }
}

/** Plain words for one blocking finding a label resolves (decision.js resolutionOf), or null. */
export function explainFinding(finding) {
  const facts = factsOf(finding);
  const files = facts.files || [];
  switch (finding.code) {
    case 'test_change':
      return explainGuard(facts.guard, files)
        || `Existing tests or test setup were edited (${fileList(files)}) and POCP couldn't check on its own that they still catch what they caught. Approve only if you accept the test edits.`;
    case 'test_inconclusive':
      return `A check on the edited tests (${fileList(files)}) didn't finish (it timed out or was stopped), so nothing is known about them yet. Re-run the job first; approve only if it keeps happening and you accept not knowing.`;
    case 'ci_config_changed': {
      const ci = files.filter((f) => DEFAULT_CI_FILES.some((gl) => matchGlob(f, gl)));
      return ci.length
        ? `The CI setup that checks pull requests changed (${fileList(ci)}). Approve only if you meant to change how CI checks code.`
        : `Files this repository protects changed (${fileList(files)}): they can change its results, for example its evaluation. Approve only if that change is intended.`;
    }
    case 'policy_loosened': {
      const what = String(finding.detail || '').replace(/^policy loosened without approval: /, '').replace(/\s*[(;]\s*re-run with [^)]*\)?\s*$/, '').split('; ').filter(Boolean);
      return `This change loosens POCP's own rules (${what.length > 3 ? `${what.slice(0, 3).join('; ')}; and ${what.length - 3} more` : what.join('; ')}), so later changes are checked less strictly. Approve only if you want that.`;
    }
    default:
      return null;
  }
}

/** The plain line for the CI workflow label (status-report.js decides when it is needed). */
export const explainWorkflow = (files) => `This pull request changes CI files that produce POCP's own result (${fileList(files)}), so that result can't be trusted until you accept the new workflow. Approve only if you meant to change CI.`;

/**
 * The one command that adds every label in `labels` to a pull request. `number` and
 * `repository` ("owner/name") may be unknown: the command then says where they go.
 */
export function addLabelsCommand(labels, { number = null, repository = null } = {}) {
  if (!labels.length) return null;
  return `gh pr edit ${number || '<number>'}${repository ? ` -R ${repository}` : ''} --add-label ${sortLabels(labels).join(',')}`;
}

/**
 * What a maintainer is asked, for a verify that waits for labels: per label, what changed and
 * what the label means, then the one command. `needs` is decision.js's list (label, plain);
 * `extra` adds labels verify can't see itself (the reporter's pocp-approve-workflow).
 * Returns { items: [{ label, plain, means }], command } or null when nothing is asked.
 */
export function approvalPlan(needs = [], { extra = [], number = null, repository = null } = {}) {
  const all = [...needs, ...extra].sort((a, b) => rank(a.label) - rank(b.label));
  if (!all.length) return null;
  return {
    items: all.map((n) => ({ label: n.label, plain: n.plain || [], means: LABEL_MEANS[n.label] || null })),
    command: addLabelsCommand(all.map((n) => n.label), { number, repository }),
  };
}

const meansLine = (means) => `Adding it means: "${means}". It does not mean "I reviewed the code".`;
const commandIntro = (n) => `Add ${plural(n, 'it', `all ${n}`)} with one command:`;

/** approvalPlan as text lines for verify's output. */
export function approvalLines(plan, indent = '  ') {
  if (!plan) return [];
  const lines = [];
  for (const it of plan.items) {
    lines.push(`${indent}${it.label}:`);
    for (const p of it.plain) lines.push(`${indent}  ${p}`);
    if (it.means) lines.push(`${indent}  ${meansLine(it.means)}`);
  }
  lines.push(`${indent}${commandIntro(plan.items.length)} ${plan.command}`);
  return lines;
}

/** approvalPlan as Markdown for the job summary (`esc` escapes table-unsafe text). */
export function approvalMarkdown(plan, esc = (x) => x) {
  if (!plan) return [];
  const lines = [];
  for (const it of plan.items) {
    lines.push(`- \`${it.label}\`${it.plain.length ? `: ${esc(it.plain.join(' '))}` : ''}${it.means ? ` ${esc(meansLine(it.means))}` : ''}`);
  }
  lines.push('', commandIntro(plan.items.length), '', '```', plan.command, '```');
  return lines;
}
