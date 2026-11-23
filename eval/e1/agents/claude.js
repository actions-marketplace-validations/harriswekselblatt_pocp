// Claude Code, headless (`claude -p`), in the task repo.
//
// Isolation, in layers (what each one does and doesn't do is in eval/e1/README.md):
//   - --setting-sources project: the user's ~/.claude settings and hooks don't load (the task
//     repo has no .claude/ folder, so nothing loads). --strict-mcp-config with no config: no
//     MCP servers. --disable-slash-commands: no skills.
//   - --tools: only Bash, Read, Edit, Write, Glob, Grep. Headless runs otherwise also get
//     AskUserQuestion (answered by nobody), PushNotification (reaches the user's devices),
//     EnterWorktree (moves work out of the repo), cron/wakeup, Workflow and subagent tools.
//   - --settings: Claude Code's sandbox on for Bash (macOS seatbelt), no unsandboxed escape,
//     no network allow-list (so commands get no network), file edits auto-accepted only inside
//     the working directory, web tools denied, Claude Code hooks off, auto-memory off.
//   - the environment: nesting markers stripped (else the child refuses to start), the OAuth
//     token kept (else "Not logged in"); git identity and config fixed by the harness.
// The model API traffic comes from the claude process itself, which isn't sandboxed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessEnv, run, PYTHON } from '../lib/proc.js';
import { agentEnv, agentPathDirs, aliases, forbiddenStrings, removeHome, sealedHome } from '../lib/seal.js';
import { POCP_ROOT } from '../lib/proc.js';
import { resolveBin, statusOf } from './common.js';
import { PROXY_ENV, boxRun } from '../lib/box.js';

export const CLAUDE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];

export const CLAUDE_SETTINGS = {
  permissions: {
    defaultMode: 'acceptEdits',
    allow: CLAUDE_TOOLS,
    deny: ['WebFetch', 'WebSearch', 'Monitor', 'PushNotification', 'RemoteTrigger'],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [] },
  },
  disableAllHooks: true,
  autoMemoryEnabled: false,
  includeCoAuthoredBy: false,
};

const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * The settings for a sealed run: CLAUDE_SETTINGS plus the seal's deny list, both as the Bash
 * sandbox's denyRead and as permission deny rules for the file tools (Read, Edit, Glob, Grep
 * and Write go through permissions, not the sandbox).
 */
export function sealedSettings(deny, settings = CLAUDE_SETTINGS, { writable = [] } = {}) {
  const paths = [...new Set(deny.flatMap(aliases))];
  const rules = paths.flatMap((p) => ['Read', 'Edit', 'Write'].map((t) => `${t}(/${p}/**)`).concat([`Read(/${p})`]));
  return {
    ...settings,
    permissions: { ...settings.permissions, deny: [...settings.permissions.deny, ...rules] },
    sandbox: { ...settings.sandbox, filesystem: { ...(settings.sandbox.filesystem || {}), denyRead: paths, ...(writable.length ? { allowWrite: writable } : {}) } },
  };
}

export function claudeArgs({ model, settings = CLAUDE_SETTINGS, maxBudgetUsd } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--permission-mode', 'acceptEdits', '--tools', CLAUDE_TOOLS.join(','), '--settings', JSON.stringify(settings),
    '--disallowedTools', 'WebFetch', 'WebSearch', 'Monitor', 'PushNotification', 'RemoteTrigger'];
  if (model) args.push('--model', model);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

/**
 * The child's environment. `auth: "inherit"` keeps ANTHROPIC_* as the harness has them;
 * `auth: "login"` drops them so the CLI uses the stored login. Only variable names are
 * recorded, never values.
 */
// The owner's long-lived login token (from `claude setup-token`), kept in a private file the
// owner writes; the harness reads it so the value never passes through anything else.
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.config', 'pocp-eval', 'claude-oauth-token');

/** 'auto' means token-file when the file exists, else inherit. */
export function resolveAuth(auth, tokenFile = DEFAULT_TOKEN_FILE) {
  if (auth !== 'auto') return auth;
  return fs.existsSync(tokenFile) ? 'token-file' : 'inherit';
}

/**
 * Child env for Claude Code. auth: 'inherit' (keep the caller's login variables), 'login'
 * (drop ANTHROPIC_*, use the CLI's own stored login), 'token-file' (drop ANTHROPIC_* and set
 * CLAUDE_CODE_OAUTH_TOKEN from the owner's token file, which must not be readable by others).
 */
export function claudeEnv(extra = {}, { auth = 'inherit', tokenFile = DEFAULT_TOKEN_FILE, base = process.env } = {}) {
  const env = harnessEnv(extra, base);
  if (auth === 'login' || auth === 'token-file') for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
  if (auth === 'token-file') {
    if (!fs.existsSync(tokenFile)) throw new Error(`claude auth token-file: no token file at ${tokenFile} (run \`claude setup-token\` and save the token there)`);
    if (fs.statSync(tokenFile).mode & 0o077) throw new Error(`claude auth token-file: ${tokenFile} is readable by others; chmod 600 it`);
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!token) throw new Error(`claude auth token-file: ${tokenFile} is empty`);
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return env;
}

/** Read the stream-json transcript: init (model, tools), final result (usage, cost). */
export function parseClaudeStream(text = '') {
  let init = null;
  let result = null;
  const models = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'init') init = o;
    else if (o.type === 'result') result = o;
    else if (o.type === 'assistant' && o.message?.model) models.add(o.message.model);
  }
  const modelUsage = result?.modelUsage || null;
  return {
    model_used: init?.model || [...models][0] || (modelUsage ? Object.keys(modelUsage)[0] : null),
    models_seen: [...new Set([...(init?.model ? [init.model] : []), ...models, ...Object.keys(modelUsage || {})])],
    tools: init?.tools || null,
    permission_mode: init?.permissionMode || null,
    cli_version: init?.claude_code_version || null,
    api_key_source: init?.apiKeySource || null,
    usage: result?.usage || null,
    model_usage: modelUsage,
    cost_usd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    is_error: Boolean(result?.is_error),
    result_subtype: result?.subtype || null,
    final_text: typeof result?.result === 'string' ? result.result.slice(0, 4000) : null,
  };
}

/** The host's global Claude instruction files that are not empty. */
export function hostClaudeInstructions(home = os.homedir()) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return ['CLAUDE.md'].filter((f) => {
    const p = path.join(dir, f);
    return fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim() !== '';
  });
}

export function redact(text, env) {
  let out = String(text || '');
  for (const k of AUTH_VARS) if (env?.[k] && env[k].length > 8) out = out.split(env[k]).join('[redacted]');
  return out;
}

export function claudeAgent({ bin: binIn = process.env.E1_CLAUDE_BIN || 'claude', auth: authIn = process.env.E1_CLAUDE_AUTH || 'auto', tokenFile = process.env.E1_CLAUDE_TOKEN_FILE || DEFAULT_TOKEN_FILE, maxBudgetUsd = null, seal: sealMode = process.env.E1_SEAL || 'on', box = null } = {}) {
  const auth = resolveAuth(authIn, tokenFile);
  // In the box (lib/box.js) the container is the seal; the macOS seal settings don't apply.
  const sealed = Boolean(box) || sealMode !== 'off';
  // The sealed env's PATH holds no user folders, so the CLI is named by its absolute path.
  const bin = resolveBin(binIn);
  return {
    name: 'claude',
    async describe() {
      const v = box
        ? await boxRun({ image: box.image, cmd: ['claude', '--version'], timeoutMs: 60_000, prefix: 'ver' })
        : await run(bin, ['--version'], { env: claudeEnv({}, { auth, tokenFile }), timeoutMs: 30_000 });
      if (box) {
        return { agent: 'claude', cli: 'claude', bin: `box:${box.image}:claude`, version: v.code === 0 ? v.out.trim() : null, image_id: box.imageId, home: 'box (fresh container per run)', sealed: true, instructions: [] };
      }
      return {
        agent: 'claude', cli: 'claude', bin, version: v.code === 0 ? v.out.trim() : null,
        home: sealed ? 'sealed (empty HOME and CLAUDE_CONFIG_DIR per run)' : 'inherited',
        sealed,
        instructions: sealed ? [] : hostClaudeInstructions(),
      };
    },
    async run({ repo, prompt, runDir, timeoutMs, model, extraEnv = {}, seal = null, boxMounts = [], boxEnv = {} }) {
      if (box) return runInBox({ box, auth, tokenFile, maxBudgetUsd, repo, prompt, runDir, timeoutMs, model, boxMounts, boxEnv });
      if (sealed && !seal) throw new Error('claude: sealed mode needs the batch seal (harness bug)');
      let env = claudeEnv(extraEnv, { auth, tokenFile });
      let settings = CLAUDE_SETTINGS;
      let home = null;
      if (sealed) {
        home = sealedHome(seal.root, 'claude');
        settings = sealedSettings(seal.deny, CLAUDE_SETTINGS, { writable: [home] });
        // USE_BUILTIN_RIPGREP=0: Claude Code's own rg sits inside its install under /Users;
        // the seal puts a system rg on PATH instead.
        env = agentEnv(env, { home, tmp: path.join(home, 'tmp'), pathDirs: agentPathDirs(env.PATH, PYTHON.dir, seal), root: seal.root, auth: AUTH_VARS, forbid: forbiddenStrings([POCP_ROOT]), extra: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), USE_BUILTIN_RIPGREP: '0', CLAUDE_TMPDIR: path.join(home, 'tmp') } });
        fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
      }
      const args = claudeArgs({ model, maxBudgetUsd, settings });
      const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
      let r;
      try {
        r = await run(bin, args, { cwd: repo, env, input: prompt, timeoutMs, stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr) });
      } finally {
        removeHome(home);
      }
      // The token could only reach the files through an error message; scrub them anyway.
      for (const f of Object.values(files)) {
        const p = path.join(runDir, f);
        if (fs.existsSync(p)) {
          const t = fs.readFileSync(p, 'utf8');
          const s = redact(t, env);
          if (s !== t) fs.writeFileSync(p, s);
        }
      }
      const parsed = parseClaudeStream(fs.existsSync(path.join(runDir, files.transcript)) ? fs.readFileSync(path.join(runDir, files.transcript), 'utf8') : '');
      return {
        status: statusOf(r, parsed.is_error),
        exit: r.code,
        signal: r.signal,
        duration_s: r.ms / 1000,
        model_requested: model || null,
        model_used: parsed.model_used,
        models_seen: parsed.models_seen,
        cli_version: parsed.cli_version,
        // Tools the CLI offered beyond the six: a harness error (run.js stops the batch).
        tools_extra: (parsed.tools || []).filter((t) => !CLAUDE_TOOLS.includes(t)),
        usage: parsed.usage,
        model_usage: parsed.model_usage,
        cost_usd: parsed.cost_usd,
        turns: parsed.turns,
        settings: {
          argv: args.map((a) => (a.startsWith('{') ? '<settings json>' : a)),
          settings: CLAUDE_SETTINGS,
          sealed,
          seal_deny_paths: sealed ? seal.deny.length : 0,
          env_names: Object.keys(env).sort(),
          auth,
          auth_env_present: AUTH_VARS.filter((k) => env[k]),
          api_key_source: parsed.api_key_source,
          tools: parsed.tools,
          permission_mode: parsed.permission_mode,
          network: 'Bash sandboxed with an empty network allow-list; WebFetch/WebSearch denied; the CLI itself reaches the model API',
        },
        error: parsed.is_error ? redact(parsed.final_text || parsed.result_subtype, env) : r.code !== 0 ? redact((r.err || '').slice(-1000), env) : null,
        final_text: parsed.final_text,
        files,
      };
    },
  };
}

/**
 * One Claude Code run in the box: a fresh container (fresh $HOME), the repo's project folder
 * mounted at its own path, the model API reachable only through the proxy. Claude Code's own
 * Bash sandbox can't start in a container (no bubblewrap namespaces), so it is off and the
 * container is the boundary; the tools, permissions and web-tool denials are unchanged.
 */
export const BOX_SETTINGS = { ...CLAUDE_SETTINGS, sandbox: { enabled: false } };

async function runInBox({ box, auth, tokenFile, maxBudgetUsd, repo, prompt, runDir, timeoutMs, model, boxMounts, boxEnv }) {
  // The login comes only from the chosen source (the token file, or with auth "inherit" the
  // harness's own variables), never from stray variables, so a run can't switch billing.
  const login = claudeEnv({}, { auth, tokenFile, base: auth === 'inherit' ? process.env : {} });
  const secretEnv = Object.fromEntries(AUTH_VARS.filter((k) => login[k]).map((k) => [k, login[k]]));
  const args = claudeArgs({ model, maxBudgetUsd, settings: BOX_SETTINGS });
  const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
  const r = await boxRun({
    image: box.image, network: box.net, mounts: boxMounts, env: { ...PROXY_ENV, ...boxEnv }, secretEnv, workdir: repo,
    cmd: ['claude', ...args], input: prompt, timeoutMs,
    stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr), prefix: 'run',
  });
  for (const f of Object.values(files)) {
    const p = path.join(runDir, f);
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8');
      const s = redact(t, secretEnv);
      if (s !== t) fs.writeFileSync(p, s);
    }
  }
  const parsed = parseClaudeStream(fs.existsSync(path.join(runDir, files.transcript)) ? fs.readFileSync(path.join(runDir, files.transcript), 'utf8') : '');
  return {
    status: r.boxFailure ? 'harness-error' : statusOf(r, parsed.is_error),
    box_failure: r.boxFailure || null,
    exit: r.code,
    signal: r.signal,
    duration_s: r.ms / 1000,
    model_requested: model || null,
    model_used: parsed.model_used,
    models_seen: parsed.models_seen,
    cli_version: parsed.cli_version,
    tools_extra: (parsed.tools || []).filter((t) => !CLAUDE_TOOLS.includes(t)),
    usage: parsed.usage,
    model_usage: parsed.model_usage,
    cost_usd: parsed.cost_usd,
    turns: parsed.turns,
    settings: {
      argv: args.map((a) => (a.startsWith('{') ? '<settings json>' : a)),
      settings: BOX_SETTINGS,
      sealed: true,
      box: { image: box.image, image_id: box.imageId, network: box.net },
      env_names: [...Object.keys(PROXY_ENV), ...Object.keys(boxEnv), ...Object.keys(secretEnv)].sort(),
      auth,
      auth_env_present: Object.keys(secretEnv),
      api_key_source: parsed.api_key_source,
      tools: parsed.tools,
      permission_mode: parsed.permission_mode,
      network: 'box: internal network; only the model APIs via the allow-list proxy; WebFetch/WebSearch denied',
    },
    error: r.boxFailure || (parsed.is_error ? redact(parsed.final_text || parsed.result_subtype, secretEnv) : r.code !== 0 ? redact((r.err || '').slice(-1000), secretEnv) : null),
    final_text: parsed.final_text,
    files,
  };
}
