// The seal: what an agent can see of the machine it runs on.
//
// Every batch gets one sealed root, a fresh folder whose name says nothing about the owner.
// Everything an agent may touch lives inside it: the task repos, the agent's read-only POCP
// copy and the node that runs it, an empty shell config, and one fresh home per run (with its
// own temp folder), removed when the run ends. Then
// three layers keep the rest of the machine out:
//
//   1. Nothing to find by default. Each run's HOME (and CLAUDE_CONFIG_DIR / CODEX_HOME) is
//      an empty folder in the root holding only what the CLI needs to log in. The agent's
//      environment is an allow-list (agentEnv): no variable from the harness's own
//      environment reaches it unless listed, and PATH holds only system folders, the pinned
//      Python and (POCP arms) the agent's pocp.
//   2. Nothing to read on purpose. Both CLIs' OS sandboxes (macOS seatbelt) deny reading
//      the private parts of the machine (denyList): every user's home under /Users, other
//      volumes, and the shared temp folders, except the path down to the sealed root. The
//      same list becomes Claude Code permission deny rules for its Read/Glob/Grep tools,
//      which the Bash sandbox does not cover.
//   3. Checked after the fact. audit.js reads every transcript for paths outside the root,
//      the host's home path, and (in seal checks) planted canary words.
//
// What the seal does not do: the CLI processes themselves are not sandboxed (they run as the
// owner and reach the model API); the deny list is a snapshot taken when the batch starts,
// so a folder created later beside the root is not on it; and runs in one batch share the
// root, so with --concurrency > 1 one run could read another's repo or home.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where sealed roots are made: /private/var/tmp, a system temp folder holding a handful of
 * system entries. Not /private/tmp or $TMPDIR: those are full of other work, and every entry
 * beside the root lands on the deny list. Codex shows its deny list to the model, and a long
 * list overflows Claude Code's sandbox command line (E2BIG on every Bash call).
 */
export const SEAL_PARENT = ['/private/var/tmp', '/var/tmp'].find((p) => fs.existsSync(p)) || os.tmpdir();
// (On Linux, e.g. in CI, /private/var/tmp doesn't exist: /var/tmp, else the OS temp folder.)

/**
 * Private parts of a Mac. Denied whole, or (when the root lies inside) all but the path down
 * to it. /Library/Logs and /private/var/log hold crash reports that name the owner's folders.
 */
export const SENSITIVE = ['/Users', '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/private/var/root', '/private/var/log', '/Library/Logs'];

/** A ripgrep that lives outside /Users, for the agents' PATH (Claude Code's own rg is inside its install). */
export const RG_CANDIDATES = ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg', '/opt/homebrew/bin/rg', '/usr/local/bin/rg'];

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** A fresh sealed root. The name is random and neutral (no user, project or tool name). */
export function createSealRoot(parent = process.env.E1_SEAL_PARENT || SEAL_PARENT) {
  const root = real(fs.mkdtempSync(path.join(parent, `ws-${crypto.randomBytes(2).toString('hex')}-`)));
  fs.chmodSync(root, 0o700);
  for (const d of ['work', 'homes', 'bin']) fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });
  return root;
}

/**
 * The paths an agent may not read, as real paths. For each sensitive folder: the folder
 * itself if the root is not inside it; otherwise every entry beside the path down to the
 * root (so the root stays reachable and nothing else does). `extra` paths are added when they
 * lie outside the root and no denied folder already covers them: Codex shows the list to the
 * model, so it must not spell out paths that name the owner or the project.
 */
export function denyList(root, { sensitive = SENSITIVE, extra = [] } = {}) {
  const r = real(root);
  const out = new Set();
  for (const s0 of sensitive) {
    const s = real(s0);
    if (!s) continue;
    if (r !== s && !r.startsWith(`${s}/`)) {
      out.add(s);
      continue;
    }
    let cur = s;
    for (const part of r.slice(s.length + 1).split('/').filter(Boolean)) {
      let names = [];
      try { names = fs.readdirSync(cur); } catch { /* unreadable: nothing to list */ }
      for (const n of names) if (n !== part) out.add(path.join(cur, n));
      cur = path.join(cur, part);
    }
  }
  const covered = (p) => [...out].some((d) => p === d || p.startsWith(`${d}/`));
  for (const e of extra) {
    const p = real(e);
    if (p && p !== r && !r.startsWith(`${p}/`) && !p.startsWith(`${r}/`) && !covered(p)) out.add(p);
  }
  return [...out].sort();
}

/**
 * Every spelling of a path that reaches the same file: /tmp → /private/tmp and /var →
 * /private/var symlinks, and the data volume's firmlink (/System/Volumes/Data/<path>).
 * Claude Code's permission rules match strings, so each spelling needs its own rule.
 */
export function aliases(p) {
  const base = [p];
  for (const [priv, short] of [['/private/tmp', '/tmp'], ['/private/var', '/var']]) {
    if (p === priv || p.startsWith(`${priv}/`)) base.push(short + p.slice(priv.length));
  }
  const data = p.startsWith('/System/Volumes/Data/') ? [] : base.map((x) => `/System/Volumes/Data${x}`);
  return [...base, ...data];
}

/** A fresh, empty home for one run, inside the root, with its own temp folder. */
export function sealedHome(root, label = 'run') {
  const dir = fs.mkdtempSync(path.join(root, 'homes', `${label.replace(/[^a-z0-9-]/gi, '')}-`));
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, 'tmp'), { mode: 0o700 });
  return dir;
}

/** Remove a run's home (and its temp folder), so the next run can't read what this one left. */
export function removeHome(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/** A hard link (or copy) of a binary inside the root's bin folder. */
function linkIn(root, src, name) {
  const dst = path.join(root, 'bin', name);
  if (!fs.existsSync(dst)) {
    try {
      fs.linkSync(real(src), dst);
    } catch {
      fs.copyFileSync(real(src), dst);
      fs.chmodSync(dst, 0o755);
    }
  }
  return dst;
}

/** The node that runs the agent's pocp, inside the root, so a sandbox that denies /Users still runs the hooks. */
export function sealedNode(root, src = process.execPath) {
  return linkIn(root, src, 'node');
}

/** Variables an agent's environment may carry over from the harness's (harnessEnv output). Login variables come per agent. */
const PASS = /^(LANG|LC_[A-Z]+|TERM|ZDOTDIR|BASH_ENV|ENV|GIT_[A-Z_]+|PYTHONDONTWRITEBYTECODE|FORCE_COLOR|NO_COLOR)$/;
// The developer tools' own bin first: /usr/bin/git is a shim (xcrun) that writes a cache to
// the per-user temp folder, which the seal denies.
const CLT_BIN = '/Library/Developer/CommandLineTools/usr/bin';
export const SYSTEM_PATH = [...(fs.existsSync(path.join(CLT_BIN, 'git')) ? [CLT_BIN] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Strings no agent environment value may contain: the owner's home, login name and the harness checkout. */
export function forbiddenStrings(extra = []) {
  const user = os.userInfo().username;
  return [os.homedir(), ...(user && user.length >= 6 ? [user] : []), ...extra].filter(Boolean);
}

/**
 * An agent's environment, from the harness's: only allow-listed variables plus this agent's
 * own login variables (`auth`), then HOME, TMPDIR, USER/LOGNAME and SHELL fixed, and PATH
 * rebuilt from `pathDirs` plus the system folders. POCP_BIN passes only when every path in it
 * is inside the root (the agent's own copy). Throws if any value would still name the owner.
 */
export function agentEnv(base, { home, tmp, pathDirs = [], root = null, auth = [], forbid = forbiddenStrings(), extra = {} }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (PASS.test(k) || auth.includes(k)) env[k] = v;
    if (k === 'POCP_BIN' && root && String(v).split(/\s+/).every((t) => t.startsWith(`${root}/`))) env[k] = v;
  }
  const out = {
    ...env,
    ...extra,
    HOME: home,
    TMPDIR: tmp,
    USER: 'agent',
    LOGNAME: 'agent',
    SHELL: '/bin/zsh',
    PATH: [...new Set([...pathDirs.filter(Boolean), ...SYSTEM_PATH])].join(path.delimiter),
  };
  for (const [k, v] of Object.entries(out)) {
    const hit = forbid.find((f) => String(v).includes(f));
    if (hit) throw new Error(`agent environment: ${k} names the host (harness bug)`);
  }
  return out;
}

/** The agent's PATH folders from a harness env PATH: a leading pocp shim folder (POCP arms), the python dir, the seal's bin. */
export function agentPathDirs(harnessPath, pythonDir, seal = null) {
  const first = String(harnessPath || '').split(path.delimiter)[0];
  const shim = /(^|\/)(tools|agent-pocp)\/bin$/.test(first || '') ? first : null;
  return [shim, pythonDir, seal?.rgDir || null];
}

/** One seal per batch: root, deny list (snapshot), sealed node, a ripgrep folder. */
export function openSeal({ extra = [], parent } = {}) {
  const root = createSealRoot(parent);
  const rg = RG_CANDIDATES.find((p) => fs.existsSync(p));
  let rgDir = null;
  if (rg) {
    rgDir = path.join(root, 'rg');
    fs.mkdirSync(rgDir, { mode: 0o700 });
    const dst = path.join(rgDir, 'rg');
    try { fs.linkSync(real(rg), dst); } catch { fs.copyFileSync(real(rg), dst); fs.chmodSync(dst, 0o755); }
  }
  return { root, work: path.join(root, 'work'), homes: path.join(root, 'homes'), deny: denyList(root, { extra }), node: sealedNode(root), rgDir };
}
