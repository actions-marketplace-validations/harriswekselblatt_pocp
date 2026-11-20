// The terminal side of the offer to disable workflows failing for billing (src/billing-workflows.js),
// shared by `pocp doctor` and `pocp ci off`. It asks only on a terminal, outside CI and without
// --json; otherwise it reports, and acts only on --disable-billing-failed.
import { offerDisable } from '../billing-workflows.js';
import { inertCommands, localizeCommands } from './shared.js';

export async function billingOffer({ repo, found, isPrivate, disable, json, retry }) {
  if (json) return offerDisable({ repo, found, isPrivate, disable, retry });
  const say = (line) => process.stdout.write(`${inertCommands(localizeCommands(line))}\n`);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
  const rl = interactive && !disable ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    return await offerDisable({ repo, found, isPrivate, disable, interactive, ask: (q) => rl.question(q), say, retry });
  } finally {
    rl?.close();
  }
}
