// A machine-wide cap on how many pocp processes run checks at once.
//
// POCP's repository lock (.proof/runs/pocp.lock) is per repository, so N worktrees or clones
// on one machine ran N test suites at once, each slower than the check's time limit allows.
// Here every pocp process that runs a check first takes one of `limit` slot files in a folder
// shared by the whole user account (the user's cache folder). Others wait in line, in order.
//
// What it is and isn't:
// - Scheduling only. It decides when a check starts, never what runs or what is recorded; the
//   time spent waiting is not part of the check's time limit or its duration_ms.
// - It must never hang or fail a check. The repository lock protects data, so it never steals
//   a lock that might be live. This one protects load, so it errs the other way: a slot whose
//   holder died, or stopped sending its heartbeat, is reclaimed, and anything unexpected (no
//   cache folder, a read-only one, a bug) runs the check uncapped with a note.
// - The unit is a pocp process, not a check: one process takes one slot for every check it
//   runs at once (the test guard and verify run several). A prove keeps it until it ends, and
//   any process keeps it for a moment after its last check, so a `pocp fix` with four checks
//   doesn't queue four times.
// - Nested pocp never queues. Every check runs with POCP_MACHINE_SLOT=1 in its environment,
//   and a pocp that sees it (pocp's own tests, a check that runs pocp prove) is running inside
//   a check that already holds a slot. Without that, a limit of 1 would deadlock. A nested pocp
//   whose environment was scrubbed is caught too: before waiting, it looks for a slot holder
//   among its own parent processes.
// - Off in CI (CI is set): a CI job has its machine to itself, and verify's --jobs decides
//   how many checks run there. POCP_MACHINE_CHECKS set explicitly applies in CI too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pidAlive, publishExclusive } from './store.js';
import { onCleanup } from './exit.js';

/** Set in every check's environment: a pocp started inside a check doesn't queue. */
export const SLOT_ENV = 'POCP_MACHINE_SLOT';
/** How many pocp processes may run checks at once on this machine: a number, or "off". */
export const LIMIT_ENV = 'POCP_MACHINE_CHECKS';
/** The folder that holds the slots (default: pocp/check-slots in the user's cache folder). */
export const DIR_ENV = 'POCP_MACHINE_DIR';

// A holder touches its slot file this often. A slot not touched for STALE_MS is reclaimed even
// if a process with its pid is alive (the pid may have been reused after a crash).
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 120_000;
// Waiters touch their ticket on every poll; a ticket not touched this long is dropped.
export const TICKET_STALE_MS = 30_000;
// After its last check ends, a process keeps its slot this long, for the next check.
export const LINGER_MS = 3_000;
const POLL_MS = 500;
const NOTE_EVERY_MS = 60_000;

// The default: one at a time. A typical test suite (node --test, jest, vitest, pytest -n,
// go test, cargo test) already uses every core, so two at once each take about twice as long:
// for a suite near half its time limit, that is a timeout, the failure this limit exists to
// prevent. Waiting costs no time limit. Machines with single-threaded checks can raise it.
export const DEFAULT_LIMIT = 1;
/** The file in the slots folder that sets the limit for the whole account (a number, or "off"). */
export const LIMIT_FILE = 'limit';

/** The slots folder: POCP_MACHINE_DIR, else pocp/check-slots in the user's cache folder. */
export function slotsDir(env = process.env, { platform = process.platform, home = safeHome() } = {}) {
  if (env[DIR_ENV]) return path.resolve(env[DIR_ENV]);
  let base;
  if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) base = env.XDG_CACHE_HOME;
  else if (!home) return null;
  else base = platform === 'darwin' ? path.join(home, 'Library', 'Caches') : path.join(home, '.cache');
  return path.join(base, 'pocp', 'check-slots');
}

function safeHome() {
  try {
    return os.homedir() || null;
  } catch {
    return null;
  }
}

function isCi(env) {
  const v = env.CI;
  return v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

/** A limit setting: a whole number, or "off" (0); null if it is neither. */
function parseLimit(raw) {
  const s = String(raw).trim().toLowerCase();
  if (s === 'off') return 0;
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * The settings in force: { limit, dir, why, warning, from }. limit 0 means uncapped, and `why`
 * says why: 'nested' (inside a check), 'ci', or 'off'. The limit comes from, in order:
 * POCP_MACHINE_CHECKS, the `limit` file in the slots folder, the default (1).
 */
export function machineSettings(env = process.env) {
  if (env[SLOT_ENV]) return { limit: 0, dir: null, why: 'nested', warning: null, from: 'nested' };
  const raw = env[LIMIT_ENV];
  const dir = slotsDir(env);
  let limit = null;
  let from = 'default';
  let warning = null;
  if (raw !== undefined && String(raw).trim() !== '') {
    limit = parseLimit(raw);
    from = LIMIT_ENV;
    if (limit === null) warning = `${LIMIT_ENV}=${JSON.stringify(String(raw))} is not a number or "off"`;
  } else if (isCi(env)) {
    return { limit: 0, dir: null, why: 'ci', warning: null, from: 'ci' };
  } else if (dir) {
    const text = readText(path.join(dir, LIMIT_FILE));
    if (text !== null && text.trim() !== '') {
      limit = parseLimit(text);
      from = path.join(dir, LIMIT_FILE);
      if (limit === null) warning = `${from} holds ${JSON.stringify(text.trim().slice(0, 20))}, not a number or "off"`;
    }
  }
  if (limit === null) {
    if (warning) warning += `, so the default (${DEFAULT_LIMIT}) applies`;
    limit = DEFAULT_LIMIT;
    from = 'default';
  }
  if (!limit) return { limit: 0, dir: null, why: 'off', warning, from };
  return { limit, dir, why: null, warning, from };
}

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const parse = (text) => {
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
};
const ageMs = (f) => {
  try {
    return Date.now() - fs.statSync(f).mtimeMs;
  } catch {
    return null;
  }
};
const slotFile = (dir, i) => path.join(dir, `slot-${i}.json`);

/** Is the slot at `file`, holding `text`, abandoned: its holder gone or silent too long? */
function abandoned(file, text) {
  const age = ageMs(file);
  if (age === null) return false; // gone: free, not abandoned
  if (age > STALE_MS) return true;
  const o = parse(text);
  if (!o) return false; // unreadable but recent: wait for it to go stale
  return !pidAlive(o.pid);
}

/**
 * Reclaim an abandoned slot whose content was `observed`. The file is renamed aside first, so
 * whatever is there is taken at once; if that turns out to be a holder that got the slot in
 * the meantime, it is put back. In the rare case that someone else took the free slot in that
 * instant, one extra check runs for a while: this lock protects load, not data.
 */
function reclaim(file, observed) {
  const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return;
  }
  if (readText(aside) !== observed) {
    try {
      fs.linkSync(aside, file);
    } catch { /* the slot was taken again meanwhile */ }
  }
  fs.rmSync(aside, { force: true });
}

/** The live tickets in the queue, oldest first. Dead or silent ones are removed. */
function liveTickets(queueDir) {
  let names;
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const f = path.join(queueDir, name);
    const o = parse(readText(f));
    const age = ageMs(f);
    if (age === null) continue;
    if (!o || age > TICKET_STALE_MS || !pidAlive(o.pid)) {
      if (!o && age <= TICKET_STALE_MS) continue; // being written
      fs.rmSync(f, { force: true });
      continue;
    }
    out.push({ name, ...o });
  }
  return out;
}

/** Whether process `pid` is waiting in the machine-wide queue for a check slot. */
export function isQueued(pid, env = process.env) {
  const s = machineSettings(env);
  if (!s.dir || !s.limit) return false;
  return liveTickets(path.join(s.dir, 'queue')).some((t) => Number(t.pid) === Number(pid));
}

/** The slots' holders: [{ i, file, text, info }] for slots that are taken. */
function holders(dir, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const file = slotFile(dir, i);
    const text = readText(file);
    if (text !== null) out.push({ i, file, text, info: parse(text) || {} });
  }
  return out;
}

/**
 * Try to take a slot below `limit`. A free slot goes to the oldest waiter that can use it
 * (waiters with a lower limit can only use the lower slots), so a waiter never takes a slot
 * an older one is waiting for. Returns { file, content } or null.
 */
function tryTake(dir, limit, content, ticketName) {
  const older = liveTickets(path.join(dir, 'queue')).filter((t) => ticketName === null || t.name < ticketName);
  const claimed = new Set();
  for (let i = 0; i < limit; i++) {
    const file = slotFile(dir, i);
    const text = readText(file);
    if (text !== null) {
      if (!abandoned(file, text)) continue;
      reclaim(file, text);
      if (fs.existsSync(file)) continue;
    }
    // Free: is an older waiter in line for it?
    const ahead = older.findIndex((t, k) => !claimed.has(k) && Number(t.limit) > i);
    if (ahead >= 0) {
      claimed.add(ahead);
      continue;
    }
    if (publishExclusive(file, content)) return { file, content };
  }
  return null;
}

function ancestors() {
  let out;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return new Set();
  }
  const parent = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) parent.set(pid, ppid);
  }
  const seen = new Set();
  for (let p = process.ppid; p > 1 && !seen.has(p); p = parent.get(p)) seen.add(p);
  return seen;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function formatWait(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function describe(h) {
  const i = h.info || {};
  const what = i.check ? `"${String(i.check).slice(0, 60)}"` : 'a check';
  const where = i.repo ? ` in ${i.repo}` : '';
  const since = Number.isFinite(i.since) ? `, running ${formatWait(Date.now() - i.since)}` : '';
  return `${what}${where} (pid ${i.pid ?? '?'}${since})`;
}

// One slot per process (see the top of the file).
const state = { count: 0, keepers: 0, held: null, acquiring: null, linger: null, heartbeat: null, unregister: null, noted: new Set() };

function noteOnce(write, key, text) {
  if (state.noted.has(key)) return;
  state.noted.add(key);
  write(text);
}

function letGo() {
  const h = state.held;
  state.held = null;
  clearInterval(state.heartbeat);
  clearTimeout(state.linger);
  state.heartbeat = null;
  state.linger = null;
  state.unregister?.();
  state.unregister = null;
  if (h && readText(h.file) === h.content) fs.rmSync(h.file, { force: true });
}

function keep(slot) {
  state.held = slot;
  state.heartbeat = setInterval(() => {
    try {
      if (readText(slot.file) === slot.content) {
        const now = new Date();
        fs.utimesSync(slot.file, now, now);
      }
    } catch { /* best effort */ }
  }, HEARTBEAT_MS);
  state.heartbeat.unref?.();
  state.unregister = onCleanup(letGo);
}

async function takeSlot({ env, label, repo, write, sleep }) {
  const s = machineSettings(env);
  if (s.warning) noteOnce(write, 'warning', `pocp: ${s.warning}\n`);
  if (!s.limit) return null;
  if (!s.dir) {
    noteOnce(write, 'nodir', 'pocp: no cache folder for the machine-wide check limit (set POCP_MACHINE_DIR); checks run without it\n');
    return null;
  }
  const queueDir = path.join(s.dir, 'queue');
  try {
    fs.mkdirSync(queueDir, { recursive: true });
  } catch (err) {
    noteOnce(write, 'mkdir', `pocp: can't use ${s.dir} for the machine-wide check limit (${err.code || err.message}); checks run without it\n`);
    return null;
  }
  const since = Date.now();
  const token = randomBytes(8).toString('hex');
  // `since` in a slot is when its holder got it (for "running 4m"), not when it started waiting.
  const content = () => `${JSON.stringify({ pid: process.pid, token, repo: repo || null, check: label || null, since: Date.now(), limit: s.limit })}\n`;
  let ticket = null;
  let lastNote = 0;
  let checkedAncestors = false;
  const dropTicket = () => {
    if (ticket) fs.rmSync(ticket.file, { force: true });
    ticket = null;
  };
  const unregister = onCleanup(dropTicket);
  try {
    for (;;) {
      const got = tryTake(s.dir, s.limit, content(), ticket?.name ?? null);
      if (got) {
        if (lastNote) write(`pocp: got a check slot after ${formatWait(Date.now() - since)}\n`);
        return got;
      }
      const busy = holders(s.dir, s.limit);
      if (!checkedAncestors) {
        checkedAncestors = true;
        const up = ancestors();
        if (busy.some((h) => up.has(Number(h.info.pid)))) {
          noteOnce(write, 'nested', 'pocp: running inside a check that holds a machine-wide check slot, so not waiting for another\n');
          return null;
        }
      }
      if (!ticket) {
        const name = `${String(since).padStart(15, '0')}-${String(process.pid).padStart(8, '0')}-${token}.json`;
        ticket = { name, file: path.join(queueDir, name) };
        fs.writeFileSync(ticket.file, JSON.stringify({ pid: process.pid, limit: s.limit, since, repo: repo || null }));
      } else {
        try {
          const now = new Date();
          fs.utimesSync(ticket.file, now, now);
        } catch {
          fs.writeFileSync(ticket.file, JSON.stringify({ pid: process.pid, limit: s.limit, since, repo: repo || null }));
        }
      }
      const now = Date.now();
      if (!lastNote) {
        const ahead = liveTickets(queueDir).filter((t) => t.name < ticket.name).length;
        write([
          `pocp: waiting for ${plural(busy.length, 'other POCP check')} on this machine (limit ${s.limit}${s.from === 'default' ? `; ${LIMIT_ENV} or ${path.join(s.dir, LIMIT_FILE)} changes it` : `, set by ${s.from}`}). Waiting doesn't count toward the check's time limit.`,
          ...busy.map((h) => `  running: ${describe(h)}`),
          ...(ahead ? [`  ${plural(ahead, 'other pocp', 'other pocps')} waiting ahead of this one`] : []),
          '',
        ].join('\n'));
        lastNote = now;
      } else if (now - lastNote >= NOTE_EVERY_MS) {
        write(`pocp: still waiting for a check slot (${formatWait(now - since)} so far; running: ${busy.map(describe).join('; ') || 'none'})\n`);
        lastNote = now;
      }
      await sleep(POLL_MS + Math.floor(Math.random() * 250));
    }
  } finally {
    dropTicket();
    unregister();
  }
}

const defaultWrite = (text) => {
  try {
    process.stderr.write(text);
  } catch { /* nowhere to write */ }
};
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for this process's machine-wide check slot. Returns { queued_ms, release }: call
 * release() once the check has finished. Never throws: if the slot can't be used, the check
 * runs uncapped (with a note on stderr).
 */
export async function acquireMachineSlot({ env = process.env, label = null, repo = null, write = defaultWrite, sleep = defaultSleep } = {}) {
  state.count++;
  const t0 = Date.now();
  try {
    if (state.linger) {
      clearTimeout(state.linger);
      state.linger = null;
    }
    if (!state.held) {
      if (!state.acquiring) {
        state.acquiring = takeSlot({ env, label, repo, write, sleep })
          .then((slot) => {
            if (slot) keep(slot);
          }, (err) => {
            noteOnce(write, 'error', `pocp: the machine-wide check limit failed (${err?.message || err}); checks run without it\n`);
          })
          .finally(() => {
            state.acquiring = null;
          });
      }
      await state.acquiring;
    }
  } catch { /* never fails a check */ }
  let released = false;
  return {
    queued_ms: Date.now() - t0,
    release() {
      if (released) return;
      released = true;
      state.count--;
      lingerIfIdle();
    },
  };
}

function lingerIfIdle() {
  if (state.count > 0 || state.keepers > 0 || !state.held || state.linger) return;
  state.linger = setTimeout(letGo, LINGER_MS);
  state.linger.unref?.();
}

/**
 * Keep this process's slot, once a check has taken one, until done() is called: a prove that
 * runs several checks (plain ones, then the test guard) waits in line once, not before each.
 * Takes no slot itself, so a prove with nothing to run never waits.
 */
export function keepMachineSlot() {
  state.keepers++;
  let done = false;
  return {
    done() {
      if (done) return;
      done = true;
      state.keepers--;
      lingerIfIdle();
    },
  };
}

/** Run `fn` with this process's machine-wide check slot; resolves to { result, queued_ms }. */
export async function withMachineSlot(fn, opts = {}) {
  const slot = await acquireMachineSlot(opts);
  try {
    return { result: await fn(), queued_ms: slot.queued_ms };
  } finally {
    slot.release();
  }
}

/** For `pocp doctor` and tests: the limit in force and who holds the slots now. */
export function machineStatus(env = process.env) {
  const s = machineSettings(env);
  if (!s.limit || !s.dir) return { ...s, running: [], waiting: 0 };
  const running = holders(s.dir, s.limit).filter((h) => !abandoned(h.file, h.text)).map((h) => ({ ...h.info, slot: h.i }));
  return { ...s, running, waiting: liveTickets(path.join(s.dir, 'queue')).length };
}

/** Tests only: forget this process's slot state. */
export function _resetForTests() {
  letGo();
  state.count = 0;
  state.keepers = 0;
  state.acquiring = null;
  state.noted.clear();
}
