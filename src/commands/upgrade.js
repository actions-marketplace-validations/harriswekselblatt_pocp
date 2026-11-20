// pocp upgrade: move this repository to a newer POCP release (src/upgrade.js).
import { EXIT } from '../errors.js';
import { applyUpgrade, formatUpgrade, planUpgrade, upgradeJson } from '../upgrade.js';
import { out } from '../cli/shared.js';

export async function run({ flags, json }) {
  const dryRun = Boolean(flags['dry-run']);
  const plan = planUpgrade(process.cwd(), { to: flags.to ?? null, ref: flags['pocp-ref'] ?? null });
  const r = dryRun ? plan : applyUpgrade(plan);
  out(json, upgradeJson(r, { dryRun }), formatUpgrade(r, { dryRun }));
  if (r.refused) return r.refused.reason === 'self' ? EXIT.ok : EXIT.blocked;
  return r.error ? EXIT.blocked : EXIT.ok;
}
