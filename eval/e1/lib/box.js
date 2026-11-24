// The box: every agent run and every judge step runs in a Linux container.
//
// Why: on macOS, Claude Code's shell writes a file to /tmp/claude-<uid>/ that no setting
// moves, and that folder can't be opened to the agent without opening every other session's
// files. Inside a container there is nothing else to protect: the container's filesystem holds
// the pinned tools and the run's own folders, mounted at the same paths as on the host.
//
//   - Image eval/e1/box/agent (pinned base digests, pinned CLI versions, no auto-update), user
//     `dev`, hostname `devbox`. The image id is recorded per run.
//   - Network: an internal Docker network with no route out, plus one proxy container
//     (eval/e1/box/proxy) that forwards only to the model APIs. Judge steps get no network.
//   - Mounts: the run's project folder (read-write) and the agent's POCP copy (read-only).
//     Nothing from the owner's home. Codex's login comes from a Docker volume the owner filled.
//   - Hardened: all capabilities dropped, no-new-privileges, memory and process limits, no
//     Docker socket. Each container is named, and killed on timeout.
// Login values pass by variable name (`-e NAME`), never on the command line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E1_DIR, run } from './proc.js';

export const BOX_DIR = path.join(E1_DIR, 'box');
// Neutral names: an agent that runs `env` sees the proxy's address, so it must not say "pocp".
export const NET = 'devnet';
export const PROXY = 'devnet-proxy';
export const PROXY_ALIAS = 'proxy';
export const PROXY_URL = `http://${PROXY_ALIAS}:8888`;
export const CODEX_LOGIN_VOLUME = 'pocp-codex-login';
/** Label on every container the harness starts (not visible inside the container). */
export const LABEL = 'box.batch';
export const HOSTNAME = 'devbox';
export const BOX_NODE = '/usr/local/bin/node';
export const BOX_PATH = '/usr/local/bin:/usr/bin:/bin';
const LIMITS = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '--pids-limit', '512'];

/** The docker CLI: $E1_DOCKER, OrbStack's own copy, or `docker` on PATH. */
export function dockerBin(env = process.env) {
  if (env.E1_DOCKER) return env.E1_DOCKER;
  const orb = path.join(os.homedir(), '.orbstack', 'bin', 'docker');
  return fs.existsSync(orb) ? orb : 'docker';
}

const docker = (args, opts = {}) => run(dockerBin(), args, { env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }, timeoutMs: 20 * 60_000, ...opts });

/** Hash of a build folder (file names and contents): the image tag, so a changed Dockerfile is a new image. */
export function folderHash(dir) {
  const h = crypto.createHash('sha256');
  for (const n of fs.readdirSync(dir).sort()) {
    h.update(n);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, n)));
  }
  return h.digest('hex').slice(0, 12);
}

/** Build an image from one of eval/e1/box/<name>, from an empty copy of that folder (nothing else in the build context). */
async function buildImage(name) {
  const src = path.join(BOX_DIR, name);
  const tag = `pocp-${name}:${folderHash(src)}`;
  if ((await docker(['image', 'inspect', tag])).code === 0) return tag;
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'box-ctx-'));
  try {
    for (const n of fs.readdirSync(src)) fs.copyFileSync(path.join(src, n), path.join(ctx, n));
    const r = await docker(['build', '-q', '-t', tag, ctx]);
    if (r.code !== 0) throw new Error(`docker build ${name} failed: ${(r.err || r.out).slice(-1500)}`);
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true });
  }
  return tag;
}

/**
 * Make sure the box is ready: both images built, the internal network and the proxy running.
 * Returns { image, imageId, proxyImage, net, proxy }. Throws (with what to do) when Docker is
 * missing or Codex's login volume is empty and Codex is needed.
 */
export async function ensureBox({ needCodexLogin = false } = {}) {
  const v = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 60_000 });
  if (v.code !== 0) throw new Error(`the box needs Docker (OrbStack): ${(v.err || v.out).trim().slice(0, 300)}`);
  const image = await buildImage('agent');
  const proxyImage = await buildImage('proxy');
  const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).out.trim();
  if ((await docker(['network', 'inspect', NET])).code !== 0) {
    const r = await docker(['network', 'create', '--internal', NET]);
    if (r.code !== 0) throw new Error(`docker network create failed: ${r.err}`);
  }
  const running = (await docker(['inspect', '--format', '{{.State.Running}} {{.Config.Image}}', PROXY])).out.trim();
  if (running && running !== `true ${proxyImage}`) {
    // Never swap the proxy under another batch: a different allow-list mid-batch changes the runs.
    if (process.env.E1_BOX_REPLACE_PROXY !== '1') throw new Error(`the box proxy (${PROXY}) runs ${running.split(' ')[1] || 'a stopped container'}, not ${proxyImage}; stop any running batch, then rerun with E1_BOX_REPLACE_PROXY=1 to replace it`);
  }
  if (running !== `true ${proxyImage}`) {
    await docker(['rm', '-f', PROXY]);
    const r = await docker(['run', '-d', '--restart', 'unless-stopped', '--name', PROXY, '--network', NET, '--network-alias', PROXY_ALIAS, ...LIMITS, proxyImage]);
    // Another batch may have started it a moment ago: fine if it's the right image.
    if (r.code !== 0 && (await docker(['inspect', '--format', '{{.State.Running}} {{.Config.Image}}', PROXY])).out.trim() === `true ${proxyImage}`) return { image, imageId, proxyImage, net: NET, proxy: PROXY };
    if (r.code !== 0) throw new Error(`starting the proxy failed: ${r.err}`);
    const c = await docker(['network', 'connect', 'bridge', PROXY]);
    if (c.code !== 0) throw new Error(`connecting the proxy failed: ${c.err}`);
  }
  if (needCodexLogin) {
    const r = await docker(['run', '--rm', '-v', `${CODEX_LOGIN_VOLUME}:/login:ro`, image, 'test', '-s', '/login/auth.json']);
    if (r.code !== 0) throw new Error(`Codex isn't logged in inside the box: the ${CODEX_LOGIN_VOLUME} volume has no auth.json (see eval/e1/README.md, "The box")`);
  }
  const ver = await docker(['run', '--rm', '--network', 'none', image, 'sh', '-c', 'python3 -c "import platform;print(platform.python_version())"; git --version; node --version; claude --version; codex --version']);
  const versions = ver.code === 0 ? ver.out.trim().split('\n') : [];
  return { image, imageId, proxyImage, proxyConfig: await proxyFingerprint(), net: NET, proxy: PROXY, versions: { python: versions[0] || null, git: versions[1] || null, node: versions[2] || null, claude: versions[3] || null, codex: versions[4] || null } };
}

/** The proxy's image and allow-list as running now: compared before every run of a batch. */
export async function proxyFingerprint() {
  const r = await docker(['inspect', '--format', '{{.Image}} {{.State.Running}}', PROXY]);
  return r.code === 0 ? r.out.trim() : null;
}

/** The agent image id a tag points at now. */
export async function imageIdOf(image) {
  const r = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  return r.code === 0 ? r.out.trim() : null;
}

/** docker exit codes that mean the container never ran the command (not the command's own exit). */
export const DOCKER_FAILED = [125, 126, 127];

/** Remove every container a batch started (after a crash or Ctrl-C). */
export async function killBatchContainers(batchLabel) {
  const ps = await docker(['ps', '-aq', '--filter', `label=${LABEL}=${batchLabel}`]);
  const ids = ps.out.split('\n').filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]);
  return ids.length;
}

/**
 * Codex's login, copied in and out by a short-lived container the agent never shares: the
 * volume is never mounted into an agent's container. copyLoginIn returns the login as it was
 * (for the compare-and-swap on the way back); copyLoginOut writes a refreshed login back only
 * if the volume still holds what was copied in, via a temp file and rename, under a lock.
 */
const LOCK = path.join(os.tmpdir(), 'box-codex-login.lock');
async function withLock(fn) {
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch {
      if (i > 600) throw new Error(`could not take ${LOCK} (another batch holds it; remove it if no batch is running)`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

export async function copyLoginIn(image, codexHome) {
  return withLock(async () => {
    const r = await docker(['run', '--rm', '--network', 'none', '-v', `${CODEX_LOGIN_VOLUME}:/login:ro`, '-v', `${codexHome}:${codexHome}`, image, 'sh', '-c', 'cp /login/auth.json "$1/auth.json" && chmod 600 "$1/auth.json"', 'copy', codexHome]);
    if (r.code !== 0) throw new Error(`copying Codex's login into the run failed: ${r.err.slice(-300)}`);
    return fs.readFileSync(path.join(codexHome, 'auth.json'));
  });
}

export async function copyLoginOut(image, codexHome, before) {
  const now = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(now) || !before) return 'none';
  const after = fs.readFileSync(now);
  if (after.equals(before) || after.length === 0) return 'unchanged';
  return withLock(async () => {
    const cur = path.join(codexHome, 'auth.before.json');
    fs.writeFileSync(cur, before, { mode: 0o600 });
    // In the helper: only replace when the volume still holds what this run started from.
    const r = await docker(['run', '--rm', '--network', 'none', '-v', `${CODEX_LOGIN_VOLUME}:/login`, '-v', `${codexHome}:${codexHome}`, image, 'sh', '-c',
      'if cmp -s /login/auth.json "$1/auth.before.json"; then cp "$1/auth.json" /login/.auth.json.new && mv /login/.auth.json.new /login/auth.json && echo written; else echo skipped; fi', 'copy', codexHome]);
    fs.rmSync(cur, { force: true });
    return r.code === 0 ? r.out.trim() : `failed: ${r.err.slice(-200)}`;
  });
}

/**
 * The `docker run` arguments for one container. mounts: [{ src, dst = src, ro }]. env: values
 * that may appear in argv (paths, flags). envNames: variables whose values come from the
 * docker client's own environment (logins), so they never appear in argv or records.
 */
export function boxRunArgs({ image, name, network = 'none', mounts = [], env = {}, envNames = [], workdir, cmd, interactive = true, label = 'none' }) {
  const args = ['run', '--rm', ...(interactive ? ['-i'] : []), '--name', name, '--label', `${LABEL}=${label}`, '--hostname', HOSTNAME, '--network', network, ...LIMITS];
  for (const m of mounts) args.push('-v', `${m.src}:${m.dst || m.src}${m.ro ? ':ro' : ''}`);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const k of envNames) args.push('-e', k);
  if (workdir) args.push('-w', workdir);
  args.push(image, ...cmd);
  return args;
}

/** A unique, neutral container name. */
export function containerName(prefix = 'box') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Run a command in the box. Same result shape as proc.run. secretEnv: { NAME: value } passed by
 * name only. The container is killed (not just the docker client) on timeout and afterwards.
 */
export async function boxRun({ image, network, mounts, env, secretEnv = {}, workdir, cmd, input, timeoutMs, stdoutFile, stderrFile, prefix, label = process.env.E1_BOX_LABEL || 'none' }) {
  const name = containerName(prefix);
  const args = boxRunArgs({ image, name, network, mounts, env, envNames: Object.keys(secretEnv), workdir, cmd, label });
  try {
    const r = await run(dockerBin(), args, { env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), ...secretEnv }, input, timeoutMs, stdoutFile, stderrFile });
    // The container never ran the command (docker's own failure), or was killed for memory.
    r.boxFailure = DOCKER_FAILED.includes(r.code) ? `docker exit ${r.code}: ${(r.err || '').trim().slice(-300)}` : (r.code === 137 && !r.timedOut ? 'killed (out of memory?)' : null);
    return r;
  } finally {
    await docker(['kill', name], { timeoutMs: 30_000 });
  }
}

/** The proxy settings for an agent container (the only way out). */
export const PROXY_ENV = { HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, https_proxy: PROXY_URL, http_proxy: PROXY_URL, NO_PROXY: '', no_proxy: '' };
