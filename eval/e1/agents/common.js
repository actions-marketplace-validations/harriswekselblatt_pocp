// Shared by the adapters.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** A CLI name resolved to an absolute path on the harness's PATH (unchanged if not found). */
export function resolveBin(bin, env = process.env) {
  if (path.isAbsolute(bin)) return bin;
  const r = spawnSync('sh', ['-c', `command -v "$1"`, 'sh', bin], { encoding: 'utf8', env });
  const found = r.stdout.trim();
  return found && path.isAbsolute(found) ? found : bin;
}

/** Map a finished CLI process to a run status. */
export function statusOf(r, reportedError) {
  if (r.timedOut) return 'timeout';
  if (r.code !== 0 || reportedError) return 'agent-error';
  return 'completed';
}
