// The one pull request comment the trusted reporter keeps (docs/STATUS.md): why POCP holds the
// pull request for a maintainer, which files and lines to look at, what each label approves,
// and the one command. Posted and updated only by `pocp status-report` (the default branch's
// code, in the privileged workflow), never by code the pull request controls.
//
// What it says comes from the reporter's own facts only: the labels decideStatus waits for,
// GitHub's list of the pull request's files, and the default branch's config. No text a run
// printed is relayed. File names are the pull request's own, so each is shown only inside a
// code span, after its control, bidi and zero-width characters are replaced: no newline,
// markdown, link, image, @mention, #reference or HTML comment can come through.
import crypto from 'node:crypto';
import { APPROVE_WORKFLOW_LABEL } from './explain.js';
import { effectiveGuardGlobs } from './guard.js';
import { matchGlob } from './glob.js';
import { holdExplanation, UNSAFE_CHARS } from './hold.js';
import { listAll } from './label-freshness.js';
import { POLICY_FILES } from './policy.js';
import { ciProtects } from './store.js';

/** The first line of the comment: how the reporter finds it again. */
export const COMMENT_MARKER = '<!-- pocp-hold -->';
const FILES_SHOWN = 20;
const RANGES_SHOWN = 6;
const NAME_MAX = 200;
// U+FFFD, the replacement character, in place of each character a name may not show.
const REPLACEMENT = String.fromCodePoint(0xfffd);

/** A string the pull request controls, as an inline code span that renders nothing but its text. */
export function codeSpan(text, max = NAME_MAX) {
  let s = String(text ?? '').replace(UNSAFE_CHARS, REPLACEMENT);
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  if (!s.length) s = REPLACEMENT;
  // A fence one backtick longer than any run inside, padded so a leading or trailing backtick
  // can't join it (CommonMark code spans). Nothing inside a code span is markdown or a mention.
  const longest = Math.max(0, ...(s.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${s} ${fence}`;
}

/** GitHub's anchor for a file (and a right-side line) on the pull request's Files tab. */
export function diffLink(repository, number, filename, line = null) {
  const hash = crypto.createHash('sha256').update(String(filename)).digest('hex');
  return `https://github.com/${repository}/pull/${number}/files#diff-${hash}${line ? `R${line}` : ''}`;
}

/**
 * The new-side line ranges a file's patch touches, from its hunk headers only (numbers, read
 * with a strict pattern): [{ start, end }]. A hunk that only removes lines has end < start.
 */
export function hunkRanges(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(count)) out.push({ start, end: start + count - 1 });
  }
  return out;
}

/** The pull request's files each label covers, by the default branch's config. */
export function filesForLabel(label, files, { baseConfig = null, workflowFiles = [] } = {}) {
  const names = (f) => [f.filename, f.previous_filename].filter(Boolean);
  if (label === APPROVE_WORKFLOW_LABEL) return files.filter((f) => names(f).some((n) => workflowFiles.includes(n)));
  if (label === 'pocp-approve-tests' || label === 'pocp-approve-inconclusive') {
    const g = effectiveGuardGlobs(baseConfig || {});
    const globs = [...g.test, ...g.runner];
    return files.filter((f) => names(f).some((n) => globs.some((gl) => matchGlob(n, gl))));
  }
  if (label === 'pocp-approve-policy') {
    return files.filter((f) => names(f).some((n) => POLICY_FILES.includes(n) || ciProtects(n, baseConfig?.ci || {}, { withDefaults: true })));
  }
  return [];
}

function fileLine(f, repository, number, { lines = true } = {}) {
  const ranges = lines ? hunkRanges(f.patch) : [];
  const where = ranges.filter((r) => r.end >= r.start).slice(0, RANGES_SHOWN)
    .map((r) => `[${r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`}](${diffLink(repository, number, f.filename, r.start)})`);
  const more = ranges.filter((r) => r.end >= r.start).length > RANGES_SHOWN ? ', …' : '';
  const status = f.status === 'removed' ? ' (deleted)' : f.status === 'renamed' && f.previous_filename ? ` (renamed from ${codeSpan(f.previous_filename)})` : '';
  const counts = Number.isInteger(f.additions) && Number.isInteger(f.deletions) ? ` +${f.additions} −${f.deletions}` : '';
  return `- ${codeSpan(f.filename)}${status}${counts} · [diff](${diffLink(repository, number, f.filename)})${where.length ? ` · ${where.join(', ')}${more}` : ''}`;
}

const footer = (disable) => `<sub>Kept up to date by POCP's reporter, from the default branch's code. ${disable}</sub>`;
const DISABLE = 'To turn this comment off, set `"ci": { "pr_comment": false }` in `.proof/config.json`.';

/** GitHub refuses a comment longer than this; the body stays well under it. */
export const COMMENT_MAX = 60_000;

// What a status that isn't a wait on known labels says, honestly: only success is "nothing
// waiting". A wait whose labels the run didn't name, an approval to re-apply, an inconclusive
// run: still waiting, said with the status's own (fixed) text.
function statusHeading(decision, isWaiting) {
  if (decision.state === 'success') return '### ✅ POCP: approved, nothing waiting';
  if (decision.state === 'failure') return "### ❌ POCP: not verified (a label won't fix this)";
  if (isWaiting) return "### 🟡 POCP is still waiting for a maintainer";
  return '### POCP: checking the newest commit';
}

/**
 * The comment for a reporter decision (status-report.js decideStatus), or null for none.
 * { kind: 'hold'|'status', body }: 'hold' when the status waits for labels it can name;
 * 'status' otherwise, which is only ever written over an existing comment. `stillWaiting`
 * (status-report.js) says whether a status without named labels still waits for a person.
 */
export function holdComment(decision, facts, { baseConfig = null, stillWaiting = false } = {}) {
  if (!decision?.write || !facts?.pr) return null;
  const { repository } = facts;
  const number = facts.pr.number;
  // The verdict is the run's typed one (status-report.js runVerdict), or none.
  const hold = decision.hold?.labels?.length ? holdExplanation(decision.hold.labels.map((label) => ({ label, verdicts: label === 'pocp-approve-tests' && decision.hold.verdict ? [decision.hold.verdict] : [] })), { number, repository }) : null;
  if (!hold) {
    return {
      kind: 'status',
      body: [
        COMMENT_MARKER,
        statusHeading(decision, stillWaiting),
        '',
        `The \`pocp\` status on ${codeSpan(String(decision.sha).slice(0, 12))} says: ${codeSpan(decision.description, 160)}`,
        ...(decision.target_url ? ['', `[The run it is based on](${decision.target_url})`] : []),
        '',
        footer(DISABLE),
      ].join('\n'),
    };
  }
  const files = (facts.files || []).filter((f) => typeof f?.filename === 'string');
  const allFiles = `https://github.com/${repository}/pull/${number}/files`;
  // Three levels of detail, the first that fits GitHub's limit: files with line links; files
  // alone; a link to the pull request's files.
  const render = (detail) => {
    const lines = [
      COMMENT_MARKER,
      "### 🟡 POCP is waiting for a maintainer's approval",
      '',
      `The \`pocp\` status on ${codeSpan(String(decision.sha).slice(0, 12))} stays pending until a maintainer adds ${hold.labels.length === 1 ? 'this label' : `these ${hold.labels.length} labels`}. An agent must never add them.`,
    ];
    for (const it of hold.items) {
      lines.push('', `**\`${it.label}\`**: ${it.reason}`, '', `Adding it means: "${it.means}". It does not mean "I reviewed the code".`);
      const mine = detail < 2 ? filesForLabel(it.label, files, { baseConfig, workflowFiles: decision.hold.workflow_files || [] }) : [];
      if (mine.length) {
        lines.push('', 'Look at:', ...mine.slice(0, FILES_SHOWN).map((f) => fileLine(f, repository, number, { lines: detail === 0 })));
        if (mine.length > FILES_SHOWN) lines.push(`- and ${mine.length - FILES_SHOWN} more: [all files](${allFiles})`);
      } else {
        lines.push('', `Look at: [the pull request's changes](${allFiles})${decision.target_url ? ` and [the verify run](${decision.target_url}), which names the files` : ''}.`);
      }
    }
    lines.push('', hold.labels.length === 1 ? 'Add it with one command:' : `Add all ${hold.labels.length} with one command:`, '', '```', hold.command, '```');
    if (decision.target_url) lines.push('', `What POCP found, in full: [the verify run](${decision.target_url}).`);
    lines.push('', footer(DISABLE));
    return lines.join('\n');
  };
  const body = [0, 1, 2].map(render).find((b) => b.length <= COMMENT_MAX) ?? render(2).slice(0, COMMENT_MAX);
  return { kind: 'hold', body };
}

/** Whether the default branch's config leaves the comment on (`ci.pr_comment`, default true). */
export const commentEnabled = (baseConfig) => baseConfig?.ci?.pr_comment !== false;

// Who the reporter posts as: github.token (labels-token) posts as the GitHub Actions app
// (ci-github.js GITHUB_ACTIONS_APP_ID).
export const REPORTER_COMMENT_IDENTITY = Object.freeze({ appId: 15368, login: 'github-actions[bot]' });

/**
 * Create or update the one comment. Never posts a second: the reporter's own marker comment is
 * edited in place (only when its text changed), and a 'status' comment is only ever written over
 * an existing one. Only comments by the reporter's own identity count (`performed_via_github_app`,
 * else the login): anyone can type the marker. Any extra marker comment by that identity (two
 * reporters racing, or one planted by another workflow posting as the same identity) is deleted,
 * keeping the oldest, which is rewritten. Returns { action: created|updated|unchanged|skipped,
 * id?, reason?, removed? }. Never throws.
 */
export async function upsertHoldComment(gh, { repository, number, comment, identity = REPORTER_COMMENT_IDENTITY }) {
  if (!gh) return { action: 'skipped', reason: 'no token to post comments with (labels-token)' };
  if (!comment) return { action: 'skipped', reason: 'nothing to say' };
  const url = `/repos/${repository}/issues/${number}/comments`;
  const byUs = (c) => (c?.performed_via_github_app ? c.performed_via_github_app.id === identity.appId : c?.user?.login === identity.login);
  try {
    const mine = async () => {
      const r = await listAll(gh, `${url}?per_page=100`, null, 10);
      if (!r.complete) throw new Error(`couldn't read every comment (${r.reason})`);
      return r.items.filter((c) => byUs(c) && String(c.body || '').startsWith(COMMENT_MARKER)).sort((a, b) => a.id - b.id);
    };
    const removeExtra = async (list) => {
      const removed = [];
      for (const c of list.slice(1)) {
        try {
          await gh.delete(`/repos/${repository}/issues/comments/${c.id}`);
          removed.push(c.id);
        } catch { /* left for the next run */ }
      }
      return removed;
    };
    const found = await mine();
    if (found.length) {
      const [keep] = found;
      const removed = await removeExtra(found);
      if (keep.body === comment.body) return { action: 'unchanged', id: keep.id, ...(removed.length ? { removed } : {}) };
      // An error here is never followed by a new post: the comment may be ours, and a rate limit
      // or an outage would otherwise leave two.
      await gh.patch(`/repos/${repository}/issues/comments/${keep.id}`, { body: comment.body });
      return { action: 'updated', id: keep.id, ...(removed.length ? { removed } : {}) };
    }
    if (comment.kind !== 'hold') return { action: 'skipped', reason: 'no hold comment to update' };
    const made = await gh.post(url, { body: comment.body });
    // Two reporters (two heads of the same pull request) may have both just posted: keep the oldest.
    const ours = await mine();
    if (ours.length > 1) {
      await removeExtra(ours);
      if (ours[0].body !== comment.body) await gh.patch(`/repos/${repository}/issues/comments/${ours[0].id}`, { body: comment.body });
    }
    return { action: 'created', id: ours[0]?.id ?? made?.id };
  } catch (e) {
    return { action: 'skipped', reason: `couldn't write the comment: ${e.message}` };
  }
}
