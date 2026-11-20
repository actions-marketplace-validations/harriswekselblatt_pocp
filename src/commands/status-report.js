// pocp status-report: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../errors.js';
import { STATUS_CONTEXT, githubClient, predictApproval, reportStatus } from '../status-report.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';
import { withDefaults } from '../store.js';

export async function run({ flags, json }) {
  // The trusted reporter (docs/STATUS.md): run from the default branch in a privileged
  // workflow, never on a pull request's code. Reads .proof/config.json here for ci.files.
  const repository = flags.repo || process.env.GITHUB_REPOSITORY;
  const sha = flags.sha || process.env.HEAD_SHA || null;
  const prNumber = Number(flags.pr || process.env.PR_NUMBER) || null;
  if (!repository || (!sha && !prNumber)) throw new UsageError('usage: pocp status-report --repo <owner/name> (--sha <head> | --pr <n>) [--workflow <path>] [--dry-run] [--json]');
  const cfgFile = path.join(process.cwd(), '.proof', 'config.json');
  const baseConfig = fs.existsSync(cfgFile) ? withDefaults(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))) : null;
  const gh = githubClient({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
  if (flags['predict-approval']) {
    // A prediction for pocp.yml (skip re-running verify?), never a status: the reporter decides.
    const p = await predictApproval(gh, { repository, sha, prNumber, baseConfig, workflowPath: flags.workflow || undefined, runId: process.env.GITHUB_RUN_ID, asAction: process.env.POCP_AS_ACTION === 'true', actionRef: process.env.POCP_ACTION_REF || null });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=${p.skip}\n`);
    out(json, p, `${p.skip ? 'verify needn\'t run' : 'verify runs'} (${p.reason})`);
    return EXIT.ok;
  }
  // LABELS_TOKEN (github.token with pull-requests: write): removes the approval labels found
  // stale. GH_TOKEN may be the reporter App's, which only reads pull requests.
  const labelGh = process.env.LABELS_TOKEN ? githubClient({ token: process.env.LABELS_TOKEN }) : null;
  const r = await reportStatus(gh, { repository, sha, prNumber, baseConfig, workflowPath: flags.workflow || undefined, dryRun: Boolean(flags['dry-run']), labelGh });
  const d = r.decision;
  out(json, r, `${d.write ? `${r.written ? 'set' : 'would set'} ${STATUS_CONTEXT} on ${d.sha.slice(0, 12)}: ${d.state} (${d.description}); ${d.reason}` : `nothing written: ${d.reason}`}${r.removed?.length ? `\nremoved stale approval label(s): ${r.removed.join(', ')}` : ''}`);
  return EXIT.ok;
}
