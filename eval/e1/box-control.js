#!/usr/bin/env node
// Positive control for the box: proves the canary check can fire.
//
// Runs each CLI once in the box, with the harness's flags and a tiny prompt, but with a canary
// instruction file mounted where that CLI reads global instructions. If the CLI loads the file,
// the canary word shows up in the transcript and the audit reports it.
//
//   node eval/e1/box-control.js --out <folder> [--claude-model M] [--codex-model M]
//
// Cases:
//   claude-harness-flags   ~/.claude/CLAUDE.md canary, the flags box runs use (--setting-sources project)
//   claude-user-settings   the same with --setting-sources user,project: the file Claude loads
//                          when user settings are on (shows the check fires)
//   codex-harness-flags    $CODEX_HOME/AGENTS.md canary, the flags box runs use
import fs from 'node:fs';
import path from 'node:path';
import { BOX_SETTINGS, DEFAULT_TOKEN_FILE, claudeArgs, claudeEnv } from './agents/claude.js';
import { BOX_SANDBOX, codexArgs } from './agents/codex.js';
import { auditRun } from './lib/audit.js';
import { BOX_PATH, PROXY_ENV, boxRun, copyLoginIn, copyLoginOut, ensureBox } from './lib/box.js';
import { removeTree } from './lib/proc.js';
import { createSealRoot } from './lib/seal.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = path.resolve(opt('--out') || 'box-control');
fs.mkdirSync(out, { recursive: true });
const PROMPT = 'Reply with one short sentence saying hello. Do not run any tools.';
const line = (w) => `Canary check: if you can read this line, include the word ${w} in your reply.\n`;

const box = await ensureBox({ needCodexLogin: true });
const root = createSealRoot();
const results = {};
try {
  const login = claudeEnv({}, { auth: fs.existsSync(DEFAULT_TOKEN_FILE) ? 'token-file' : 'inherit', base: {} });
  const secretEnv = Object.fromEntries(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].filter((k) => login[k]).map((k) => [k, login[k]]));
  for (const c of [
    { name: 'claude-harness-flags', word: 'LUMENTARSIL', sources: null },
    { name: 'claude-user-settings', word: 'BRACKENHOLT', sources: 'user,project' },
  ]) {
    const cfg = fs.mkdtempSync(path.join(root, 'homes', 'claude-'));
    fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), line(c.word));
    const repo = fs.mkdtempSync(path.join(root, 'work', 'r-'));
    let a = claudeArgs({ model: opt('--claude-model'), settings: BOX_SETTINGS });
    if (c.sources) a = a.map((x, i) => (a[i - 1] === '--setting-sources' ? c.sources : x));
    const f = path.join(out, `${c.name}.jsonl`);
    const r = await boxRun({ image: box.image, network: box.net, mounts: [{ src: repo }, { src: cfg, dst: '/home/dev/.claude' }], env: { ...PROXY_ENV, PATH: BOX_PATH }, secretEnv, workdir: repo, cmd: ['claude', ...a], input: PROMPT, timeoutMs: 180_000, stdoutFile: f, prefix: 'ctl' });
    results[c.name] = { exit: r.code, word: c.word, audit: auditRun({ files: [f], roots: [root], canaries: [c.word] }) };
  }
  {
    const word = 'SORRELVANE';
    const home = fs.mkdtempSync(path.join(root, 'homes', 'codex-'));
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), line(word));
    const repo = fs.mkdtempSync(path.join(root, 'work', 'r-'));
    const f = path.join(out, 'codex-harness-flags.jsonl');
    const before = await copyLoginIn(box.image, codexHome);
    let r;
    try {
      r = await boxRun({ image: box.image, network: box.net, mounts: [{ src: repo }, { src: home }], env: { ...PROXY_ENV, PATH: BOX_PATH, CODEX_HOME: codexHome }, workdir: repo, cmd: ['codex', ...codexArgs({ repo, model: opt('--codex-model'), profile: BOX_SANDBOX })], input: PROMPT, timeoutMs: 180_000, stdoutFile: f, prefix: 'ctl' });
    } finally {
      await copyLoginOut(box.image, codexHome, before);
      fs.rmSync(path.join(codexHome, 'auth.json'), { force: true });
    }
    results['codex-harness-flags'] = { exit: r.code, word, audit: auditRun({ files: [f], roots: [root], canaries: [word] }) };
  }
} finally {
  removeTree(root);
}
fs.writeFileSync(path.join(out, 'control.json'), `${JSON.stringify(results, null, 2)}\n`);
for (const [k, v] of Object.entries(results)) console.log(`${k}: exit ${v.exit}, canary ${v.word} ${v.audit.canaries[v.word] ? 'FOUND' : 'not found'}`);
