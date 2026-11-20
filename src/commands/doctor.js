// pocp doctor: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { UsageError } from '../cli-args.js';
import { billingOffer } from '../cli/billing-offer.js';
import { out } from '../cli/shared.js';

export async function run({ engine, flags, json }) {
  const disable = Boolean(flags['disable-billing-failed']);
  if (disable && flags.offline) throw new UsageError('--disable-billing-failed asks GitHub, so it cannot be combined with --offline');
  const r = await runDoctor(engine, { base: flags.base, offline: Boolean(flags.offline) });
  // Local mode: workflows (not POCP's) whose jobs GitHub doesn't start for billing. runDoctor only
  // reports them; here, after the report, they are offered for disabling (src/billing-workflows.js).
  const billing = r.checks.find((c) => c.id === 'actions-billing' && c.offer?.length);
  const offer = (quiet) => billingOffer({ repo: billing.repo, found: billing.offer, isPrivate: billing.private, disable, json: quiet, retry: 'pocp doctor --disable-billing-failed' });
  let acted = null;
  // --disable-billing-failed with nothing offered: say whether nothing was found or nothing could be checked.
  const none = disable && !billing ? nothingOffered(r, engine.config().ci?.mode === 'local') : null;
  if (json) {
    if (billing && disable) r.billing_failed = acted = await offer(true);
    if (none) r.billing_failed = none;
    out(json, r, '');
  } else {
    out(json, r, formatDoctor(r));
    if (billing) {
      process.stdout.write('\n');
      acted = await offer(false);
    } else if (none) process.stdout.write(`--disable-billing-failed: ${none.decision === 'unchecked' ? 'nothing disabled, because it could not check' : 'nothing to disable'}: ${none.reason}\n`);
  }
  if (acted?.failed.length) return EXIT.blocked;
  return r.ok ? EXIT.ok : EXIT.blocked;
}

function nothingOffered(r, local) {
  const billing = r.checks.find((c) => c.id === 'actions-billing');
  if (billing?.status === 'skipped') return { decision: 'unchecked', reason: billing.what, disabled: [] };
  const github = r.checks.find((c) => c.id === 'github' && c.status === 'skipped' && !/^local mode/.test(c.what));
  if (github) return { decision: 'unchecked', reason: github.what, disabled: [] };
  if (!local) return { decision: 'none', reason: 'it applies in local mode; with CI, pocp ci off switches to local mode and offers it', disabled: [] };
  return { decision: 'none', reason: 'no active workflow fails because GitHub does not start its jobs for billing', disabled: [] };
}
