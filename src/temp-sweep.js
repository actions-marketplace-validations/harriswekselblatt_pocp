// Temporary folders left behind by a process that could not clean up after itself.
//
// pocp removes its temporary folders on exit and on SIGINT/SIGTERM/SIGHUP (src/exit.js). SIGKILL,
// a crash or the OOM killer leave no chance to run anything, so a killed pocp kept its copy of the
// repository in the temp folder forever. Each folder's name now records the process that owns it:
//
//   pocp-<kind>-<pid>-<start>-XXXXXX      start: the owner's start time, seconds, base 36
//
// The owner is in the name, so it exists the moment mkdtemp makes the folder: there is no
// window in which a live folder has no owner, and nothing is written inside it (a snapshot holds
// exactly the repository's files). A later run removes a folder only when its owner is gone: its
// process ID is no longer running, or it is running again under another process (PID reuse), seen
// because that process started at another time.
//
// What a sweep may touch, and nothing else:
//   - direct children of the given temp folder, never anything deeper or elsewhere;
//   - names matching `pocp-<kind>-` for the kinds the caller lists, followed by mkdtemp's six
//     characters (with an owner in front of them, or not);
//   - real folders (not symlinks) owned by the current user.
// A folder from before owners were recorded (pocp-<kind>-XXXXXX) has no owner to ask. It is
// removed only when neither it nor anything directly inside it changed for a day (LEGACY_AGE_MS),
// far longer than any check runs (pocp stops a check after its time limit). When in doubt, a
// folder is kept: ps failing or printing something unexpected keeps every folder whose process
// ID is running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** This process's start time, whole seconds since the epoch. */
const START = Math.floor((Date.now() - process.uptime() * 1000) / 1000);
/** The owner part of every temporary folder name this process makes. */
export const OWNER = `${process.pid}-${START.toString(36)}`;
/** A start time read back from ps may differ from the recorded one by this much (rounding, the
 *  time between exec and Node starting). A process that reuses a PID starts later than that. */
const START_SLACK_S = 60;
export const LEGACY_AGE_MS = 24 * 60 * 60 * 1000;

/** The mkdtemp prefix for a temporary folder of `kind` owned by this process. */
export function ownedPrefix(kind) {
  return `pocp-${kind}-${OWNER}-`;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kindsPattern = (kinds) => kinds.map(escape).join('|');

/** The owner recorded in a folder name, or null. */
export function ownerOf(name, kinds) {
  const m = new RegExp(`^pocp-(?:${kindsPattern(kinds)})-(\\d+)-([0-9a-z]+)-[A-Za-z0-9]{6}$`).exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  const start = parseInt(m[2], 36);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(start)) return null;
  return { pid, start };
}

function pidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM: running, as another user
  }
}

/**
 * Start times (seconds since the epoch) of running processes, from one `ps` call. Returns null
 * when ps fails, so callers keep every folder whose process ID is running.
 */
export function processStarts(pids) {
  if (!pids.length) return new Map();
  let r;
  try {
    r = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
  } catch {
    return null;
  }
  if (r.error || typeof r.stdout !== 'string') return null;
  const out = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!m) continue;
    const t = Date.parse(`${m[2]} UTC`);
    if (Number.isFinite(t)) out.set(Number(m[1]), Math.floor(t / 1000));
  }
  return out;
}

function newestMtime(dir, st) {
  let newest = st.mtimeMs;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return Infinity; // can't look inside: treat as just changed
  }
  for (const n of names) {
    try {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, n)).mtimeMs);
    } catch { /* gone meanwhile */ }
  }
  return newest;
}

/** Remove a folder, making read-only folders inside writable first if a plain removal fails. */
export function forceRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch { /* read-only folders inside: make them writable and retry */ }
  const walk = (d) => {
    try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
  };
  walk(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Remove the temporary folders in `base` whose owner is gone.
 *   kinds        kinds whose folders record an owner (pocp-<kind>-<pid>-<start>-XXXXXX)
 *   legacyKinds  kinds whose owner-less folders (pocp-<kind>-XXXXXX) may go once a day old
 *   budgetMs     stop removing after this long (the rest waits for the next sweep)
 * Returns { removed, live, young, more }: names removed, counts kept, and whether the budget ran out.
 */
export function sweepStale(base, { kinds = [], legacyKinds = [], legacyAgeMs = LEGACY_AGE_MS, budgetMs = Infinity, now = Date.now() } = {}) {
  const res = { removed: [], live: 0, young: 0, more: false };
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return res;
  }
  const legacy = legacyKinds.length ? new RegExp(`^pocp-(?:${kindsPattern(legacyKinds)})-[A-Za-z0-9]{6}$`) : null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const isOurFolder = (full) => {
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      return null;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (uid !== null && st.uid !== uid) return null;
    return st;
  };

  const owned = [];
  const old = [];
  for (const name of names) {
    if (!name.startsWith('pocp-')) continue;
    const owner = kinds.length ? ownerOf(name, kinds) : null;
    if (owner) owned.push({ name, ...owner });
    else if (legacy?.test(name)) old.push(name);
  }

  // Whose owner is gone: not running, or running as a process that started at another time.
  const stale = [];
  const running = [];
  for (const f of owned) {
    if (f.pid === process.pid) {
      if (Math.abs(f.start - START) <= START_SLACK_S) res.live++;
      else stale.push(f.name);
    } else if (!pidRunning(f.pid)) stale.push(f.name);
    else running.push(f);
  }
  if (running.length) {
    const starts = processStarts([...new Set(running.map((f) => f.pid))]);
    for (const f of running) {
      const actual = starts?.get(f.pid);
      if (actual !== undefined && Math.abs(actual - f.start) > START_SLACK_S) stale.push(f.name);
      else res.live++; // same process, or ps couldn't say: keep
    }
  }

  const deadline = Date.now() + budgetMs;
  const remove = (name) => {
    if (Date.now() > deadline) {
      res.more = true;
      return;
    }
    const full = path.join(base, name);
    if (!isOurFolder(full)) return;
    forceRemove(full);
    if (!fs.existsSync(full)) res.removed.push(name);
  };
  for (const name of stale) remove(name);
  for (const name of old) {
    if (Date.now() > deadline) {
      res.more = true;
      break;
    }
    const full = path.join(base, name);
    const st = isOurFolder(full);
    if (!st) continue;
    if (now - newestMtime(full, st) < legacyAgeMs) res.young++;
    else remove(name);
  }
  return res;
}

/**
 * Whether a sweep is due: true at most once per `everyMs` for a given stamp file, which this call
 * claims. Sweeping reads the whole temp folder, which on a crowded machine takes seconds, so runs
 * share one sweep instead of each paying for it. The claim is atomic: test files start together,
 * and only the one whose rename of an old stamp (or exclusive create of a missing one) succeeds
 * sweeps. Any doubt (an unwritable stamp) means no sweep.
 */
export function sweepDue(stamp, everyMs, now = Date.now()) {
  if (!stamp) return false;
  try {
    let old = true;
    try {
      const t = fs.statSync(stamp).mtimeMs;
      if (now - t < everyMs && t <= now + 60_000) return false;
    } catch (err) {
      if (err.code !== 'ENOENT') return false;
      old = false;
    }
    fs.mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
    if (old) {
      const claimed = `${stamp}.${process.pid}`;
      fs.renameSync(stamp, claimed); // another claimant got there first: ENOENT
      if (now - fs.statSync(claimed).mtimeMs < everyMs) {
        // What we took was a claimant's new stamp, written after we looked: put it back.
        fs.renameSync(claimed, stamp);
        return false;
      }
      fs.rmSync(claimed, { force: true });
    }
    fs.writeFileSync(stamp, `${process.pid}\n`, { flag: 'wx' });
    const s = now / 1000;
    fs.utimesSync(stamp, s, s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where sweep stamps live: POCP_SWEEP_DIR, else pocp/ in the user's cache folder (the folder
 * that holds the machine-wide check slots). One stamp per sweep, never one per temp folder.
 */
export function sweepStampDir(env = process.env, { platform = process.platform } = {}) {
  if (env.POCP_SWEEP_DIR) return path.resolve(env.POCP_SWEEP_DIR);
  if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) return path.join(env.XDG_CACHE_HOME, 'pocp');
  let home = null;
  try {
    home = os.homedir() || null;
  } catch { /* no home folder */ }
  if (!home) return null;
  return path.join(home, ...(platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'pocp');
}

function isCi(env) {
  const v = env.CI;
  return v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

/** pocp's own temporary folders, for the sweep at the start of a pocp run. */
export const PRODUCT_KINDS = ['snap', 'tree', 'copy'];

let productSwept = false;
/**
 * Once per process, and at most once an hour per user: remove pocp's temporary folders whose
 * owner was killed before it could remove them. Called before pocp makes its first temp folder,
 * so only commands that copy the repository pay for reading the temp folder.
 */
export function sweepProductTemp({ base = os.tmpdir(), env = process.env } = {}) {
  if (productSwept) return null;
  productSwept = true;
  // A CI job's machine starts empty and goes away. Containers may share a temp folder while each
  // has its own process IDs, where "not running" can't be told from "running elsewhere".
  if (isCi(env)) return null;
  try {
    const dir = sweepStampDir(env);
    if (!dir || !sweepDue(path.join(dir, 'temp-sweep'), 60 * 60 * 1000)) return null;
    return sweepStale(base, { kinds: PRODUCT_KINDS, legacyKinds: PRODUCT_KINDS, budgetMs: 5000 });
  } catch {
    return null; // never let cleanup of old runs fail this one
  }
}
