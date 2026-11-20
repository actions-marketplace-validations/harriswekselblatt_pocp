// pocp init: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../errors.js';
import { LIVE_VARIABLE, LOCAL_MODE_TRADE, STATUS_CHECK, createApprovalLabels, goLive, localVerifyCommand, requiredChecksPlan } from '../ci-github.js';
import { UsageError } from '../cli-args.js';
import { APPROVAL_LABELS } from '../doctor.js';
import { formatLayout, hooksHealth, initProofDir, installHooks, writeGithubWorkflows } from '../init.js';
import { BADGE_MARKDOWN, badgeInteractive, badgeLines, offerBadge } from '../badge.js';
import { git } from '../git.js';
import { out } from '../cli/shared.js';

export async function run({ flags, json }) {
  if (flags.local && flags.github) throw new UsageError('init: choose --github (CI checks every pull request) or --local (no CI), not both');
  const r = initProofDir(process.cwd(), { deep: Boolean(flags.deep), github: Boolean(flags.github), local: Boolean(flags.local) });
  let hooks = null;
  // Local mode without the hooks would check nothing at all.
  if (flags.hooks || flags.local) hooks = installHooks(process.cwd(), { force: flags.force });
  const github = flags.github ? writeGithubWorkflows(process.cwd(), { ref: flags['pocp-ref'] || undefined, force: flags.force }) : null;
  // Turn the pocp status on now, so the first pull request that waits for an approval is
  // yellow, not a red failure. Only for a repository on GitHub, through the user's gh login;
  // anything that doesn't work is a next step, never an error.
  let live = null;
  let labels = null;
  const onGithub = Boolean(github) && /github\.com[:/]/.test(git(process.cwd(), ['remote', 'get-url', 'origin'], { allowFail: true }) || '');
  // The labels a maintainer approves changes with: without them there is nothing to approve with.
  if (onGithub) labels = createApprovalLabels(APPROVAL_LABELS);
  if (onGithub && !flags['no-live']) {
    live = goLive(process.cwd(), requiredChecksPlan(process.cwd(), JSON.parse(fs.readFileSync(path.join(process.cwd(), '.proof', 'config.json'), 'utf8'))), { protect: false });
  }
  out(json, { created: r.created, hooks, test_layout: r.layout, ...(flags.local ? { mode: 'local' } : {}), ...(github ? { github } : {}), ...(labels ? { labels } : {}), ...(live ? { live } : {}), ...(flags.badge ? { badge: BADGE_MARKDOWN } : {}) }, [
    r.created.length ? `created ${r.created.join(', ')}` : '.proof/ already set up',
    ...(r.config_created ? [flags.deep
      ? 'test guard: deep (guard.mutants 10): test edits are also checked with 10 planted bugs; slower'
      : 'test guard: fast (guard.mutants 0): every test edit, new test files included, goes to a person. "pocp init --deep" or guard.mutants 10 adds planted bugs, which can pass a test edit without one'] : []),
    // The layout on a first init, or when it needs something done; quiet otherwise.
    ...(r.config_created || r.layout.extra.length || r.layout.uncovered.length ? formatLayout(r.layout, { written: r.layout_written }) : []),
    hooks?.refused ? `hooks not installed: ${hooks.refused}` : hooks ? `hooks installed in ${hooks.dir}` : Object.values(hooksHealth(process.cwd()).hooks).some((v) => v === 'ok') ? 'hooks: already installed' : 'hooks not installed (run "pocp hooks install")',
    ...(hooks?.chained || []).map((n) => `${n}: chained (the existing hook is now ${n}.pre-pocp and runs first)`),
    ...(hooks?.warnings || []).map((w) => `warning: ${w}`),
    ...(flags.local ? [
      `local mode (ci.mode "local"): ${LOCAL_MODE_TRADE}`,
      `  before merging: ${localVerifyCommand(process.cwd())}   (pocp init --github adds CI later)`,
    ] : !github && r.config_created ? ['CI: not set up. Choose: pocp init --github (CI re-checks every pull request) or pocp init --local (no CI: the hooks are the gate)'] : []),
    ...(github ? [
      github.written.length ? `wrote ${github.written.join(', ')} (POCP actions pinned to ${github.ref})` : 'GitHub workflows already present',
      ...github.skipped.map((f) => `kept ${f} (exists; --force replaces it)`),
      ...github.removed.map((f) => `removed ${f} (no longer needed: verify checks approval labels against the head)`),
      ...(labels?.ok ? [labels.created.length ? `created the approval labels on ${labels.repo}: ${labels.created.join(', ')}` : `approval labels already on ${labels.repo}`]
        : labels ? [`approval labels not created: ${labels.error} (pocp doctor prints the commands)`] : []),
      ...(live?.ok ? [`${LIVE_VARIABLE} set on ${live.repo}: a pull request waiting for approval shows a yellow "${STATUS_CHECK}" status, not a red failure`, ...live.notes.map((n) => `  ${n}`)]
        : live ? [`${LIVE_VARIABLE} not set: ${live.error}`] : []),
      `next: commit them in a pull request${labels?.ok ? '' : ', create the labels (pocp doctor lists them)'}, and once it merges run "pocp ci required --apply" to require the "${STATUS_CHECK}" status${live?.ok ? '' : ' and turn it on'}`,
    ] : []),
    ...(flags.badge ? badgeLines() : []),
  ].join('\n'));
  // Last, and only on a first setup at a terminal: one yes/no question about the README badge,
  // defaulting to no. A yes prints it to paste; no file is changed.
  if (!hooks?.refused && badgeInteractive({ json, flags, configCreated: r.config_created })) {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    try {
      await offerBadge({ interactive: true, ask: (q) => rl.question(q), say: (text) => process.stdout.write(`${text}\n`) });
    } finally {
      rl.close();
    }
  }
  return hooks?.refused ? EXIT.usage : EXIT.ok;
}
