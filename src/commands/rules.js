// pocp rules: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';
import { policyKeyWarnings } from '../schema.js';
import { ruleWarnings, validateRules } from '../rules.js';
import { createFsStore, validateConfig } from '../store.js';

export async function run({ engine, json, rest }) {
  if (rest[0] !== 'check') throw new UsageError('usage: pocp rules check');
  const rawRules = engine.store.readRawRules();
  const problems = [
    ...validateRules(rawRules || {}),
    ...validateConfig(engine.config()).map((p) => `config: ${p}`),
  ];
  const warnings = [...policyKeyWarnings({ rules: rawRules, config: engine.store.readRawConfig?.() }), ...ruleWarnings(engine.rules(), engine.root)];
  // Without git, say which .proof/ was checked: there is no repository to name it.
  const checked = engine.checked ? { checked: engine.checked } : {};
  out(json, { ok: problems.length === 0, problems, warnings, ...checked }, [
    ...(engine.checked ? [`rules: checked ${engine.checked} (no git repository here)`] : []),
    ...(problems.length ? problems.map((p) => `rules: ${p}`) : ['rules: ok']),
    ...warnings.map((w) => `warning: ${w}`),
  ].join('\n'));
  return problems.length ? EXIT.usage : EXIT.ok;
}

/**
 * `rules check` reads only .proof/, so it also works without git: in a copy of the repository
 * with no .git, which is how CI re-runs a packet's checks (always from the copy's root). Without
 * git there is no repository root to find, so nothing is searched for: the folder it runs in must
 * hold .proof/ as a real folder with rules.json as a real file (no symlinks), or it fails as
 * before. Searching upward or into another folder could validate a .proof/ other than the one
 * the check is about, and pass where the real rules are broken.
 */
export function proofFolderEngine(cwd) {
  const dir = path.resolve(cwd);
  const kind = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const proof = kind(path.join(dir, '.proof'));
  const rules = kind(path.join(dir, '.proof', 'rules.json'));
  const config = kind(path.join(dir, '.proof', 'config.json'));
  if (!proof?.isDirectory() || !rules?.isFile() || (config && !config.isFile())) {
    throw new UsageError(`not inside a git repository: ${dir} (without git, run pocp rules check in the folder that holds .proof/rules.json)`);
  }
  const store = createFsStore(dir);
  return { root: dir, store, config: () => store.readConfig(), rules: () => store.readRules(), checked: path.join(dir, '.proof') };
}
