#!/usr/bin/env node
// Positive control for the seal audit: proves the canary check can fire.
//
// Runs each CLI once with the harness's flags and a tiny prompt, but with a home that is NOT
// empty: a throwaway folder holding only a canary instruction file in the place the CLI reads
// global instructions from. If the CLI loads that file, the canary word shows up in the
// transcript and the audit reports it. Nothing from the real home is used except the logins
// (the Claude token file; a copy of Codex's auth.json).
//
//   node eval/e1/seal-control.js --out <folder> [--claude-model M] [--codex-model M]
//
// Each case uses the same flags, settings, sandbox deny list and environment allow-list as a
// sealed run; only the home differs (it holds a canary file instead of being empty).
// Writes <out>/<case>.jsonl transcripts and <out>/control.json. Three cases:
//   claude-harness-flags   $CLAUDE_CONFIG_DIR/CLAUDE.md canary, sealed-run flags
//   claude-user-settings   the same, with --setting-sources user,project (shows the file is
//                          the one Claude loads when user settings are on)
//   codex-harness-flags    $CODEX_HOME/AGENTS.md canary, sealed-run flags
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_SETTINGS, DEFAULT_TOKEN_FILE, claudeArgs, claudeEnv, sealedSettings } from './agents/claude.js';
import { codexArgs, codexBin, hostCodexHome, isolatedHome, closeIsolatedHome, sealedProfile } from './agents/codex.js';
import { resolveBin } from './agents/common.js';
import { auditRun } from './lib/audit.js';
import { POCP_ROOT, PYTHON, harnessEnv, removeTree, run } from './lib/proc.js';
import { agentEnv, agentPathDirs, forbiddenStrings, openSeal, sealedHome } from './lib/seal.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = path.resolve(opt('--out') || 'seal-control');
fs.mkdirSync(out, { recursive: true });
const PROMPT = 'Reply with one short sentence saying hello. Do not run any tools.';
const line = (w) => `Canary check: if you can read this line, include the word ${w} in your reply.\n`;

const seal = openSeal({ extra: [POCP_ROOT] });
const { root } = seal;
const results = {};
const forbid = forbiddenStrings([POCP_ROOT]);
try {
  for (const c of [
    { name: 'claude-harness-flags', word: 'LUMENTARSIL', sources: null },
    { name: 'claude-user-settings', word: 'BRACKENHOLT', sources: 'user,project' },
  ]) {
    const home = sealedHome(root, 'ctl');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), line(c.word));
    const repo = fs.mkdtempSync(path.join(root, 'work', 'r-'));
    const base = claudeEnv({}, { auth: fs.existsSync(DEFAULT_TOKEN_FILE) ? 'token-file' : 'inherit' });
    const env = agentEnv(base, { home, tmp: path.join(home, 'tmp'), pathDirs: agentPathDirs('', PYTHON.dir, seal), root, auth: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'], forbid, extra: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), USE_BUILTIN_RIPGREP: '0', CLAUDE_TMPDIR: path.join(home, 'tmp') } });
    let a = claudeArgs({ model: opt('--claude-model'), settings: sealedSettings(seal.deny, CLAUDE_SETTINGS, { writable: [home] }) });
    if (c.sources) a = a.map((x, i) => (a[i - 1] === '--setting-sources' ? c.sources : x));
    const f = path.join(out, `${c.name}.jsonl`);
    const r = await run(resolveBin('claude'), a, { cwd: repo, env, input: PROMPT, timeoutMs: 180_000, stdoutFile: f });
    results[c.name] = { exit: r.code, word: c.word, audit: auditRun({ files: [f], roots: [root], canaries: [c.word] }) };
  }
  {
    const word = 'SORRELVANE';
    const home = sealedHome(root, 'ctl');
    const iso = isolatedHome(hostCodexHome(), path.join(home, '.codex'));
    fs.writeFileSync(path.join(iso.dir, 'AGENTS.md'), line(word));
    const repo = fs.mkdtempSync(path.join(root, 'work', 'r-'));
    const env = agentEnv(harnessEnv({ CODEX_HOME: iso.dir }), { home, tmp: path.join(home, 'tmp'), pathDirs: agentPathDirs('', PYTHON.dir, seal), root, auth: ['CODEX_HOME', 'OPENAI_API_KEY'], forbid });
    const f = path.join(out, 'codex-harness-flags.jsonl');
    let r;
    try {
      r = await run(codexBin(), codexArgs({ repo, model: opt('--codex-model'), profile: sealedProfile({ repo, deny: seal.deny, writable: [home] }) }), { cwd: repo, env, input: PROMPT, timeoutMs: 180_000, stdoutFile: f });
    } finally {
      closeIsolatedHome(iso);
    }
    results['codex-harness-flags'] = { exit: r.code, word, audit: auditRun({ files: [f], roots: [root], canaries: [word] }) };
  }
} finally {
  removeTree(root);
}
fs.writeFileSync(path.join(out, 'control.json'), `${JSON.stringify(results, null, 2)}\n`);
for (const [k, v] of Object.entries(results)) console.log(`${k}: exit ${v.exit}, canary ${v.word} ${v.audit.canaries[v.word] ? 'FOUND' : 'not found'}`);
