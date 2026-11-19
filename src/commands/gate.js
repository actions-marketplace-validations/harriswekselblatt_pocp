// pocp gate: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { formatGate, localizeCommands, out } from '../cli/shared.js';

export async function run({ engine, flags, json }) {
  // pocp's pre-commit hook sets POCP_GATE_SOURCE=hook, and the pre-commit framework sets
  // PRE_COMMIT=1 for the hooks it runs (.pre-commit-hooks.yaml). Drop pocp's own variable so
  // checks don't inherit it.
  const source = process.env.POCP_GATE_SOURCE === 'hook' || process.env.PRE_COMMIT === '1' ? 'hook' : 'gate';
  delete process.env.POCP_GATE_SOURCE;
  const r = await engine.gate({ prove: Boolean(flags.prove), mode: flags.mode, source });
  if (json) out(true, r);
  else process[r.decision === 'pass' ? 'stdout' : 'stderr'].write(`${localizeCommands(formatGate(r))}\n`);
  return r.decision === 'pass' ? EXIT.ok : r.decision === 'error' ? EXIT.usage : EXIT.blocked;
}
