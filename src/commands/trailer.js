// pocp trailer: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  if (rest[0]) {
    if (!fs.existsSync(rest[0])) throw new UsageError(`no such message file: ${rest[0]}`);
    // The commit's source: git's second argument to prepare-commit-msg, or, from the pre-commit
    // framework, which passes only the message file, its PRE_COMMIT_COMMIT_MSG_SOURCE. Merges and
    // squashes get no trailers, as pocp's own hook skips them.
    const source = rest[1] ?? process.env.PRE_COMMIT_COMMIT_MSG_SOURCE ?? undefined;
    if (source === 'merge' || source === 'squash') {
      out(json, { trailers: [] }, null);
      return EXIT.ok;
    }
    const lines = await engine.addTrailersToFile(rest[0], { source });
    out(json, { trailers: lines }, null);
  } else {
    const lines = await engine.trailers();
    out(json, { trailers: lines }, lines.map((l) => `Proof-Of-Change: ${l}`).join('\n'));
  }
  return EXIT.ok;
}
