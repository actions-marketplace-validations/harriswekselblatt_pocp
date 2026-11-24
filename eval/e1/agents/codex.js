// Codex CLI, headless (`codex exec`), in the task repo.
//
//   - --sandbox workspace-write: an OS sandbox (macOS seatbelt). Commands write only inside the
//     repo (and temp folders) and get no network. Codex keeps .git read-only by default, which
//     would stop the agent committing at all, so the repo's .git is added as a writable root.
//   - --ignore-user-config, --ignore-rules: the user's config.toml and execpolicy rules don't
//     apply (auth still comes from CODEX_HOME). approval_policy "never": nothing waits on a person.
//   - CODEX_HOME is a fresh folder per run holding only auth.json : Codex reads
//     ~/.codex/AGENTS.md even with --ignore-user-config, and the host's file must not reach the
//     agent. If Codex refreshes its login in the copy, the new auth.json is carried back (unless
//     the real one changed meanwhile). E1_CODEX_HOME=inherit uses the real home (never counted).
//   - Not --ephemeral: the session file is the only place Codex records the model it used, so
//     the harness finds it by thread id and copies it into the run folder.
// Codex reports token usage but no dollar cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PYTHON, harnessEnv, run } from '../lib/proc.js';
import { agentEnv, agentPathDirs, forbiddenStrings, removeHome, sealedHome } from '../lib/seal.js';
import { POCP_ROOT } from '../lib/proc.js';
import { statusOf } from './common.js';
import { PROXY_ENV, boxRun, copyLoginIn, copyLoginOut } from '../lib/box.js';

export const APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export function codexBin(env = process.env) {
  if (env.E1_CODEX_BIN) return env.E1_CODEX_BIN;
  return fs.existsSync(APP_BIN) ? APP_BIN : 'codex';
}

export const INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md'];

export function hostCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** The global instruction files in a Codex home that are not empty (Codex would read them). */
export function codexInstructions(home) {
  return INSTRUCTION_FILES.filter((f) => {
    const p = path.join(home, f);
    return fs.existsSync(p) && fs.readFileSync(p, 'utf8').trim() !== '';
  });
}

/** A fresh CODEX_HOME holding only a copy of the host's auth.json (in `dir` when given). */
export function isolatedHome(src = hostCodexHome(), dir0 = null) {
  const dir = dir0 || fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-e1-codex-home-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const auth = path.join(src, 'auth.json');
  const before = fs.existsSync(auth) ? fs.readFileSync(auth) : null;
  if (before) fs.writeFileSync(path.join(dir, 'auth.json'), before, { mode: 0o600 });
  return { dir, src, before };
}

/** Carry a refreshed login back to the host home, then remove the folder. */
export function closeIsolatedHome({ dir, src, before }) {
  try {
    const copy = path.join(dir, 'auth.json');
    const real = path.join(src, 'auth.json');
    if (before && fs.existsSync(copy) && fs.existsSync(real)) {
      const now = fs.readFileSync(copy);
      if (!now.equals(before) && fs.readFileSync(real).equals(before)) fs.writeFileSync(real, now, { mode: 0o600 });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** TOML for a value: JSON strings and objects of strings are valid TOML inline forms. */
const toml = (o) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ')}}`;

/**
 * The sealed run's sandbox: a Codex permission profile. Everything readable except the seal's
 * deny list; writable only the repo (with its .git), the run's home and the seal's temp folder.
 * Network stays off for commands (a profile without a network table has none).
 */
export function sealedProfile({ repo, deny, writable = [] }) {
  const fsMap = { '/': 'read' };
  for (const p of deny) fsMap[p] = 'deny';
  for (const p of [repo, path.join(repo, '.git'), ...writable]) fsMap[p] = 'write';
  return ['-c', 'default_permissions="sealed"', '-c', `permissions.sealed.filesystem=${toml(fsMap)}`];
}

export function codexArgs({ repo, model, profile = null }) {
  const sandbox = profile || ['--sandbox', 'workspace-write',
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([path.join(repo, '.git')])}`,
    '-c', 'sandbox_workspace_write.network_access=false'];
  const args = ['exec', '--json',
    ...sandbox,
    '-c', 'approval_policy="never"',
    // No hosted web search and no ChatGPT connectors: both would run outside the sandbox.
    '-c', 'web_search="disabled"', '-c', 'features.apps=false',
    '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--color', 'never',
    '-C', repo];
  if (model) args.push('-m', model);
  args.push('-'); // the prompt comes on stdin
  return args;
}

/** Read the --json event stream: thread id, usage, failures, commands run. */
export function parseCodexStream(text = '') {
  let threadId = null;
  let error = null;
  let lastMessage = null;
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let sawUsage = false;
  let commands = 0;
  let model = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'thread.started') threadId = o.thread_id || threadId;
    else if (o.type === 'turn.completed' && o.usage) {
      sawUsage = true;
      for (const k of Object.keys(usage)) usage[k] += Number(o.usage[k] || 0);
    } else if (o.type === 'turn.failed') error = o.error?.message || 'turn failed';
    else if (o.type === 'error') error = o.message || 'codex error';
    else if (o.type === 'item.completed' && o.item?.type === 'agent_message') lastMessage = o.item.text;
    else if (o.type === 'item.completed' && o.item?.type === 'command_execution') commands++;
    if (o.model && !model) model = o.model;
  }
  return { thread_id: threadId, error, usage: sawUsage ? usage : null, final_text: lastMessage ? String(lastMessage).slice(0, 4000) : null, commands, model };
}

/** The session file Codex wrote for this thread (searched newest-first, bounded). */
export function findSession(threadId, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (!threadId) return null;
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return null;
  const dirs = (p) => (fs.existsSync(p) ? fs.readdirSync(p).sort().reverse() : []);
  let looked = 0;
  for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    if (++looked > 5) return null; // only the last few days
    const dir = path.join(root, y, m, d);
    const hit = dirs(dir).find((f) => f.includes(threadId));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** The model (and effort) from a session file's turn context. */
export function sessionModel(file) {
  if (!file || !fs.existsSync(file)) return { model: null, effort: null };
  let model = null;
  let effort = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('model')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || o;
    if (p.model && !model) model = p.model;
    if ((p.effort || p.reasoning_effort) && !effort) effort = p.effort || p.reasoning_effort;
    if (model && effort) break;
  }
  return { model, effort };
}

export function codexAgent({ bin = codexBin(), home = process.env.E1_CODEX_HOME || 'isolated', seal: sealMode = process.env.E1_SEAL || 'on', box = null } = {}) {
  const inherit = home === 'inherit' && !box;
  const sealed = Boolean(box) || (sealMode !== 'off' && !inherit);
  return {
    name: 'codex',
    async describe() {
      if (box) {
        const v = await boxRun({ image: box.image, cmd: ['codex', '--version'], timeoutMs: 60_000, prefix: 'ver' });
        return { agent: 'codex', cli: 'codex', bin: `box:${box.image}:codex`, version: v.code === 0 ? v.out.trim() : null, image_id: box.imageId, home: 'box (fresh container per run; login from a Docker volume)', sealed: true, instructions: [] };
      }
      const v = await run(bin, ['--version'], { env: harnessEnv(), timeoutMs: 30_000 });
      return {
        agent: 'codex', cli: 'codex', bin, version: v.code === 0 ? v.out.trim() : null,
        home: inherit ? 'inherited' : sealed ? 'sealed (empty HOME; CODEX_HOME holds auth.json only)' : 'isolated (auth.json only)',
        sealed,
        instructions: inherit ? codexInstructions(hostCodexHome()) : [],
      };
    },
    async run({ repo, prompt, runDir, timeoutMs, model, extraEnv = {}, seal = null, boxMounts = [], boxEnv = {}, boxHome = null }) {
      if (box) return runInBox({ box, repo, prompt, runDir, timeoutMs, model, boxMounts, boxEnv, boxHome });
      if (sealed && !seal) throw new Error('codex: sealed mode needs the batch seal (harness bug)');
      const home = sealed ? sealedHome(seal.root, 'codex') : null;
      const iso = inherit ? null : isolatedHome(hostCodexHome(), home ? path.join(home, '.codex') : null);
      let env = harnessEnv(iso ? { ...extraEnv, CODEX_HOME: iso.dir } : extraEnv);
      if (sealed) env = agentEnv(env, { home, tmp: path.join(home, 'tmp'), pathDirs: agentPathDirs(env.PATH, PYTHON.dir, seal), root: seal.root, auth: ['CODEX_HOME', 'OPENAI_API_KEY'], forbid: forbiddenStrings([POCP_ROOT]) });
      const args = codexArgs({ repo, model, profile: sealed ? sealedProfile({ repo, deny: seal.deny, writable: [home] }) : null });
      const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
      let r;
      let session;
      let parsed;
      try {
        if (iso && codexInstructions(iso.dir).length) throw new Error('isolated CODEX_HOME holds instruction files');
        r = await run(bin, args, { cwd: repo, env, input: prompt, timeoutMs, stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr) });
        const out = fs.existsSync(path.join(runDir, files.transcript)) ? fs.readFileSync(path.join(runDir, files.transcript), 'utf8') : '';
        parsed = parseCodexStream(out);
        session = findSession(parsed.thread_id, iso ? iso.dir : hostCodexHome());
        if (session) {
          files.session = 'agent.session.jsonl';
          fs.copyFileSync(session, path.join(runDir, files.session));
          session = path.join(runDir, files.session);
        }
      } finally {
        if (iso) closeIsolatedHome(iso);
        removeHome(home);
      }
      const sm = sessionModel(session);
      return {
        status: statusOf(r, parsed.error),
        exit: r.code,
        signal: r.signal,
        duration_s: r.ms / 1000,
        model_requested: model || null,
        model_used: sm.model || parsed.model || null,
        reasoning_effort: sm.effort,
        usage: parsed.usage,
        cost_usd: null,
        turns: null,
        commands_run: parsed.commands,
        thread_id: parsed.thread_id,
        settings: {
          argv: args.map((a) => (a.startsWith('permissions.sealed.filesystem=') ? 'permissions.sealed.filesystem=<seal profile>' : a)),
          sandbox: sealed ? 'seal profile: all readable except the seal deny list; writable repo, .git, run home, seal tmp; no network' : 'workspace-write (+ .git writable), network off for commands',
          codex_home: inherit ? 'inherited' : 'isolated (auth.json only)',
          sealed,
          seal_deny_paths: sealed ? seal.deny.length : 0,
          env_names: Object.keys(env).sort(),
          network: 'commands have no network (Codex sandbox); the CLI itself reaches the model API',
        },
        error: parsed.error || (r.code !== 0 ? (r.err || '').slice(-1000) : null),
        final_text: parsed.final_text,
        files,
      };
    },
  };
}

/**
 * One Codex run in the box. Codex's login lives in a Docker volume the owner filled once. It is
 * never mounted into the agent's container: a short-lived helper copies it into this run's fresh
 * CODEX_HOME (a host folder mounted at its own path, so the session file can be read back), and
 * after the run, even after a timeout, the harness writes a refreshed login back (only if the
 * volume still holds what this run started from) and deletes the copy. Codex's own sandbox
 * can't start in a container (no user namespaces), so it runs with danger-full-access and the
 * container is the boundary. Web search and connectors stay off.
 */
export const BOX_SANDBOX = ['--sandbox', 'danger-full-access'];

/** Every long string in a login file: what redaction must remove from transcripts. */
export function loginSecrets(buf) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string' && v.length >= 20) out.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  try { walk(JSON.parse(String(buf))); } catch { /* not JSON: nothing to redact by value */ }
  return out;
}

function redactFiles(dir, names, secrets) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) continue;
    let t = fs.readFileSync(p, 'utf8');
    const before = t;
    for (const sec of secrets) t = t.split(sec).join('[redacted]');
    if (t !== before) fs.writeFileSync(p, t);
  }
}

async function runInBox({ box, repo, prompt, runDir, timeoutMs, model, boxMounts, boxEnv, boxHome }) {
  if (!boxHome) throw new Error('codex: the box needs a per-run CODEX_HOME folder (harness bug)');
  const codexHome = path.join(boxHome, '.codex');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const args = codexArgs({ repo, model, profile: BOX_SANDBOX });
  const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
  const before = await copyLoginIn(box.image, codexHome);
  let r;
  let loginWriteBack;
  let redactWith = [];
  try {
    r = await boxRun({
      image: box.image, network: box.net,
      mounts: [...boxMounts, { src: boxHome }],
      env: { ...PROXY_ENV, ...boxEnv, CODEX_HOME: codexHome }, workdir: repo,
      cmd: ['codex', ...args], input: prompt, timeoutMs,
      stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr), prefix: 'run',
    });
  } finally {
    loginWriteBack = await copyLoginOut(box.image, codexHome, before);
    redactWith = loginSecrets(before).concat(fs.existsSync(path.join(codexHome, 'auth.json')) ? loginSecrets(fs.readFileSync(path.join(codexHome, 'auth.json'))) : []);
    fs.rmSync(path.join(codexHome, 'auth.json'), { force: true });
  }
  const out = fs.existsSync(path.join(runDir, files.transcript)) ? fs.readFileSync(path.join(runDir, files.transcript), 'utf8') : '';
  const parsed = parseCodexStream(out);
  let session = findSession(parsed.thread_id, codexHome);
  if (session) {
    files.session = 'agent.session.jsonl';
    fs.copyFileSync(session, path.join(runDir, files.session));
    session = path.join(runDir, files.session);
  }
  // The login could reach the files only if the agent printed it; scrub them anyway.
  redactFiles(runDir, Object.values(files), redactWith);
  const sm = sessionModel(session);
  return {
    status: r.boxFailure ? 'harness-error' : statusOf(r, parsed.error),
    box_failure: r.boxFailure || null,
    exit: r.code,
    signal: r.signal,
    duration_s: r.ms / 1000,
    model_requested: model || null,
    model_used: sm.model || parsed.model || null,
    reasoning_effort: sm.effort,
    usage: parsed.usage,
    cost_usd: null,
    turns: null,
    commands_run: parsed.commands,
    thread_id: parsed.thread_id,
    settings: {
      argv: args,
      sandbox: 'box: container is the boundary (codex danger-full-access inside); internal network, model APIs only via the allow-list proxy',
      codex_home: 'box (fresh per run; login copied in and out by a helper container)',
      login_write_back: loginWriteBack,
      sealed: true,
      box: { image: box.image, image_id: box.imageId, network: box.net },
      env_names: [...Object.keys(PROXY_ENV), ...Object.keys(boxEnv), 'CODEX_HOME'].sort(),
      network: 'model APIs only, through the proxy',
    },
    error: r.boxFailure || parsed.error || (r.code !== 0 ? (r.err || '').slice(-1000) : null),
    final_text: parsed.final_text,
    files,
  };
}
