// pocp upgrade, and the version-drift check pocp doctor runs.
//
// Network: the only network use is inside `pocp upgrade`, which the user runs: `npm view` to
// find the latest release (skipped with --to) and the package manager's own install. Nothing
// here runs in the git hooks, the gate, or the Claude Code plugin's guard; the doctor check
// reads local files only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredHooksPath, git, repoRoot } from './git.js';
import { GITHUB_WORKFLOWS, hooksHealth, recordedBin } from './init.js';
import { ciProtects, withDefaults } from './store.js';
import { UsageError } from './cli-args.js';

export const PACKAGE = 'proof-of-change';
export const ACTION_REPO = 'harriswekselblatt/pocp';
export const RELEASES_URL = `https://github.com/${ACTION_REPO}/releases`;
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOCKFILES = Object.freeze({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
});
// Other CI systems install the verifier as proof-of-change@<version> (README, "On another CI").
// pocp upgrade doesn't edit these (pocp didn't write them); it and doctor report the pins.
const OTHER_CI_FILES = Object.freeze(['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml', '.buildkite/pipeline.yml', '.drone.yml', '.woodpecker.yml']);

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const readText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

// ---------------------------------------------------------------- versions

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export const isVersion = (v) => SEMVER.test(String(v || ''));
const isRelease = (v) => /^v?\d+\.\d+\.\d+$/.test(String(v || ''));
const bare = (v) => String(v).replace(/^v/, '');

/** Compare two versions (with or without a leading v): negative, 0 or positive. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a));
  const pb = SEMVER.exec(String(b));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0);
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- how pocp is installed

/** The package manager a repository uses: packageManager in package.json, else its lockfile, else npm. */
export function packageManager(root, pkg = readJson(path.join(root, 'package.json'))) {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(String(pkg?.packageManager || ''));
  if (declared) return declared[1];
  for (const pm of ['pnpm', 'yarn', 'bun', 'npm']) if (LOCKFILES[pm].some((f) => fs.existsSync(path.join(root, f)))) return pm;
  return 'npm';
}

/** The install command for proof-of-change@<version>, as argv after the package manager's name. */
export function installArgs(pm, version, { field = 'devDependencies', global = false, exact = false } = {}) {
  const spec = `${PACKAGE}@${version}`;
  const dev = field === 'devDependencies';
  if (global) return ['install', '--global', spec];
  if (pm === 'npm') return ['install', dev ? '--save-dev' : '--save-prod', ...(exact ? ['--save-exact'] : []), spec];
  if (pm === 'pnpm') return ['add', dev ? '--save-dev' : '--save-prod', ...(exact ? ['--save-exact'] : []), spec];
  if (pm === 'yarn' || pm === 'bun') return ['add', ...(dev ? ['--dev'] : []), ...(exact ? ['--exact'] : []), spec];
  throw new Error(`unknown package manager: ${pm}`);
}

const pmBin = (pm) => (pm === 'npm' ? process.env.POCP_NPM || 'npm' : pm);
const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const commandText = (pm, args) => [pm, ...args].map(shellWord).join(' ');

/** The version a lockfile resolves proof-of-change to, or null. Best effort, read only. */
export function lockedVersion(root) {
  const lock = readJson(path.join(root, 'package-lock.json')) || readJson(path.join(root, 'npm-shrinkwrap.json'));
  const fromNpm = lock?.packages?.[`node_modules/${PACKAGE}`]?.version || lock?.dependencies?.[PACKAGE]?.version;
  if (fromNpm) return { file: fs.existsSync(path.join(root, 'package-lock.json')) ? 'package-lock.json' : 'npm-shrinkwrap.json', version: fromNpm };
  const patterns = [
    ['pnpm-lock.yaml', new RegExp(`(?:^|\\s|/)${PACKAGE}@(\\d+\\.\\d+\\.\\d+[^:()\\s'"]*)`, 'm')],
    ['yarn.lock', new RegExp(`^"?${PACKAGE}@[^\\n]*:\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+version:?[ \\t]+"?([^"\\n]+)`, 'm')],
    ['bun.lock', new RegExp(`"${PACKAGE}":\\s*\\[\\s*"${PACKAGE}@([^"]+)"`)],
  ];
  for (const [file, re] of patterns) {
    const m = re.exec(readText(path.join(root, file)) || '');
    if (m && isVersion(m[1])) return { file, version: m[1] };
  }
  return null;
}

// A dependency spec npm doesn't resolve from the registry: git, a tarball, a path, a workspace.
const NON_REGISTRY = /^(github:|gitlab:|bitbucket:|git(\+[a-z]+)?:|https?:|file:|link:|workspace:|portal:|npm:)|^[\w.-]+\/[\w.-]+|\.t?gz$/;

/**
 * How this repository gets pocp:
 *   { kind: 'self' }                          this is POCP's own repository
 *   { kind: 'dependency', field, spec, exact, pm, installed, locked, bin }
 *   { kind: 'other-source', field, spec, installed }   git, tarball or path dependency
 *   { kind: 'global', installed, bin, root }  not a dependency; npm's global install
 *   { kind: 'none' }                          neither (npx, a checkout, another tool)
 * `globalRoot` is called only when the repository has no dependency on POCP (it runs npm).
 */
export function detectInstall(root, { globalRoot = npmGlobalRoot } = {}) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg?.name === PACKAGE) return { kind: 'self' };
  const installedPkg = path.join(root, 'node_modules', PACKAGE, 'package.json');
  for (const field of ['devDependencies', 'dependencies', 'optionalDependencies']) {
    const spec = pkg?.[field]?.[PACKAGE];
    if (typeof spec !== 'string') continue;
    const installed = readJson(installedPkg)?.version || null;
    if (NON_REGISTRY.test(spec)) return { kind: 'other-source', field, spec, installed };
    return {
      kind: 'dependency', field, spec,
      exact: /^=?v?\d+\.\d+\.\d+(-[\w.-]+)?$/.test(spec),
      pm: packageManager(root, pkg),
      installed,
      locked: lockedVersion(root)?.version || null,
      bin: path.join(root, 'node_modules', PACKAGE, 'bin', 'pocp.js'),
    };
  }
  const groot = globalRoot(root);
  const globalVersion = groot ? readJson(path.join(groot, PACKAGE, 'package.json'))?.version : null;
  if (globalVersion) return { kind: 'global', installed: globalVersion, root: groot, bin: path.join(groot, PACKAGE, 'bin', 'pocp.js') };
  return { kind: 'none' };
}

function npmGlobalRoot(cwd) {
  const r = spawnSync(pmBin('npm'), ['root', '--global'], { cwd, encoding: 'utf8', timeout: 30000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The newest release on the npm registry, through `npm view` (a network call). */
function latestVersion(cwd) {
  const r = spawnSync(pmBin('npm'), ['view', PACKAGE, 'version'], { cwd, encoding: 'utf8', timeout: 60000 });
  const v = (r.stdout || '').trim().replace(/^"|"$/g, '');
  if (r.status === 0 && isVersion(v)) return { ok: true, version: v };
  return { ok: false, error: r.error?.message || (r.stderr || '').trim().split('\n').pop() || `npm view exited ${r.status}` };
}

// ---------------------------------------------------------------- pins

// A step that uses the POCP action or its status reporter, pinned to a ref. An optional
// "# v1.2.3" comment after a commit pin (Dependabot's convention) names its release.
const USES = new RegExp(`^(\\s*-?\\s*uses:\\s*['"]?)(${ACTION_REPO.replace('/', '\\/')}(?:\\/status)?)@([^\\s'"#]+)(['"]?)([ \\t]*#[ \\t]*v?\\d+\\.\\d+\\.\\d+[^\\s]*)?`, 'gim');
const isSha = (ref) => /^[0-9a-f]{40}$/i.test(ref);

/**
 * Re-pin every POCP action step in a workflow's text to `ref`, the way `init --pocp-ref` pins
 * them. Release tags move forward (never back); commit and branch pins are left alone unless
 * `explicit` (a --pocp-ref the user gave). Returns { text, changed: [{ from, to }], left: [{ from, reason }] }.
 */
export function repinText(text, ref, { explicit = false, version = null } = {}) {
  const changed = [];
  const left = [];
  const out = String(text).replace(USES, (whole, pre, repo, from, quote, comment) => {
    if (from === ref) return whole;
    if (!explicit) {
      if (isSha(from)) { left.push({ from: `${repo}@${from}`, reason: 'commit' }); return whole; }
      if (!isRelease(from)) { left.push({ from: `${repo}@${from}`, reason: 'branch' }); return whole; }
      if (compareVersions(from, ref) > 0) { left.push({ from: `${repo}@${from}`, reason: 'newer' }); return whole; }
    }
    changed.push({ from: `${repo}@${from}`, to: `${repo}@${ref}` });
    // A "# v1.2.3" comment names the release a commit pin is: keep it true, or drop it for a tag.
    const tail = comment && isSha(ref) && version ? ` # v${bare(version)}` : '';
    return `${pre}${repo}@${ref}${quote}${tail}`;
  });
  return { text: out, changed, left };
}

/** POCP action pins in .github/workflows: [{ file, ref, version }] (version: the release it names, if any). */
export function workflowPins(root) {
  const dir = path.join(root, '.github', 'workflows');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const pins = [];
  for (const f of files) {
    const text = readText(path.join(dir, f)) || '';
    for (const m of text.matchAll(USES)) {
      const ref = m[3];
      const named = /v?(\d+\.\d+\.\d+\S*)/.exec(m[5] || '')?.[1];
      pins.push({ file: `.github/workflows/${f}`, repo: m[2], ref, version: isRelease(ref) ? bare(ref) : isSha(ref) && named ? named : null });
    }
  }
  return pins;
}

/** The pre-commit framework's pin of POCP's hooks, or null. */
export function preCommitPin(root) {
  const text = readText(path.join(root, '.pre-commit-config.yaml'));
  if (!text) return null;
  const m = new RegExp(`repo:\\s*['"]?https://github\\.com/${ACTION_REPO.replace('/', '\\/')}(?:\\.git)?['"]?\\s*\\n\\s*rev:\\s*['"]?([^\\s'"#]+)`, 'i').exec(text);
  return m ? { file: '.pre-commit-config.yaml', ref: m[1], version: isRelease(m[1]) ? bare(m[1]) : null } : null;
}

/** proof-of-change@<version> in other CI systems' files: [{ file, version }]. */
export function otherCiPins(root) {
  const pins = [];
  for (const f of OTHER_CI_FILES) {
    const text = readText(path.join(root, f));
    if (!text) continue;
    for (const m of text.matchAll(new RegExp(`${PACKAGE}@(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, 'g'))) pins.push({ file: f, version: m[1] });
  }
  return pins;
}

// ---------------------------------------------------------------- the version check (doctor)

/** The version of the pocp a bin path belongs to (its package.json, found upward), or null. */
function versionOfBin(bin) {
  let dir;
  try { dir = path.dirname(fs.realpathSync(bin)); } catch { return null; }
  for (let i = 0; i < 6; i++) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg?.name === PACKAGE) return pkg.version;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The pocp this checkout runs locally (what the hooks and npx find), as { where, version }, or null. */
function localPocp(root) {
  const nm = path.join(root, 'node_modules', '.bin', 'pocp');
  if (fs.existsSync(nm)) {
    const version = versionOfBin(nm) || readJson(path.join(root, 'node_modules', PACKAGE, 'package.json'))?.version;
    if (version) return { where: 'node_modules', version };
  }
  const onPath = spawnSync('sh', ['-c', 'command -v pocp'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  if (onPath) {
    const version = versionOfBin(onPath);
    if (version) return { where: `pocp on PATH (${onPath})`, version };
  }
  let pre = null;
  try { pre = path.join(git(root, ['rev-parse', '--git-path', 'hooks']), 'pre-commit'); } catch { /* no git */ }
  const recorded = pre && recordedBin(readText(path.isAbsolute(pre) ? pre : path.join(root, pre)) || '');
  if (recorded && fs.existsSync(recorded)) {
    const version = versionOfBin(recorded);
    if (version) return { where: `the pocp the hooks recorded (${recorded})`, version };
  }
  return null;
}

/**
 * Do the copies of POCP this repository uses agree? Reads local files only (no network): the
 * local pocp (node_modules, PATH or the hooks' recorded copy), the lockfile, the release the
 * workflows pin (unless local mode), the pre-commit rev and other CI files' pins. Returns doctor
 * checks: none when there is at most one copy to compare, else one, ok or a warning. It can't
 * tell that every copy is old: `pocp upgrade --dry-run` asks the registry for that.
 */
export function versionChecks(root, { local = false } = {}) {
  const sources = [];
  const here = localPocp(root);
  if (here) sources.push({ ...here, role: 'local' });
  // A pre-release (a development build) has no release to match: not compared.
  const lock = lockedVersion(root);
  if (lock && readJson(path.join(root, 'package.json'))?.name !== PACKAGE) sources.push({ where: lock.file, version: lock.version, role: 'lock' });
  if (!local) {
    const byVersion = new Map();
    for (const p of workflowPins(root).filter((x) => x.version)) byVersion.set(p.version, [...new Set([...(byVersion.get(p.version) || []), p.file])]);
    for (const [version, files] of byVersion) sources.push({ where: files.join(', '), version, role: 'ci' });
  }
  const pc = preCommitPin(root);
  if (pc?.version) sources.push({ where: pc.file, version: pc.version, role: 'pre-commit' });
  for (const p of otherCiPins(root)) sources.push({ where: p.file, version: p.version, role: 'other-ci' });
  for (let i = sources.length - 1; i >= 0; i--) if (!isRelease(sources[i].version)) sources.splice(i, 1);
  if (sources.length < 2) return [];
  const versions = [...new Set(sources.map((s) => s.version))].sort(compareVersions);
  const list = (ss) => ss.map((s) => s.where).join('; ');
  if (versions.length === 1) {
    return [{ id: 'pocp-versions', status: 'ok', what: `the same POCP everywhere: ${versions[0]} in ${list(sources)}` }];
  }
  const what = `POCP versions differ: ${versions.map((v) => `${v} in ${list(sources.filter((s) => s.version === v))}`).join('; ')}`;
  const onlyInstall = sources.every((s) => s.role === 'local' || s.role === 'lock') && here?.where === 'node_modules';
  if (onlyInstall) {
    const pm = packageManager(root);
    return [{ id: 'pocp-versions', status: 'warning', what, why: `node_modules doesn't match ${lock.file}: the lockfile was updated and this checkout hasn't installed it, so the hooks run another release than the one committed`, fix: `${pm} install` }];
  }
  const ci = sources.some((s) => s.role === 'ci' || s.role === 'other-ci');
  return [{
    id: 'pocp-versions',
    status: 'warning',
    what,
    why: ci ? 'the hooks and CI can judge the same commit differently, and the older copy lacks the newer one\'s fixes' : 'the copies of POCP this repository uses can judge the same commit differently',
    fix: `pocp upgrade moves them to one release (pocp upgrade --dry-run shows what it would change)${pc?.version && versions.some((v) => v !== pc.version) ? `; for pre-commit: pre-commit autoupdate --repo https://github.com/${ACTION_REPO}` : ''}`,
  }];
}

// ---------------------------------------------------------------- pocp upgrade

function readConfig(root) {
  const raw = readJson(path.join(root, '.proof', 'config.json')) || {};
  try { return withDefaults(raw); } catch { return withDefaults({}); }
}

/** Tracked files with uncommitted changes (staged or not). */
function dirtyFiles(root) {
  const outp = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], { trim: false, allowFail: true }) || '';
  const files = [];
  const parts = outp.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    files.push(e.slice(3));
    if (/^R|^C/.test(e)) i++; // the rename's source follows
  }
  return files;
}

/** Re-pin plan for the workflows: [{ file, changed, left, text }] for every file with a POCP pin. */
function planWorkflows(root, ref, opts) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const plans = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const text = readText(path.join(dir, f)) || '';
    const r = repinText(text, ref, opts);
    if (r.changed.length || r.left.length) plans.push({ file: `.github/workflows/${f}`, ...r });
  }
  return plans;
}

/**
 * What `pocp upgrade` would do, and why it can't (refused), without changing anything except
 * asking the registry for the latest version when `to` isn't given.
 * Options: to (a version), ref (--pocp-ref), dryRun, latest (for tests: a function returning
 * { ok, version } or { ok: false, error }), globalRoot.
 */
export function planUpgrade(cwd, { to = null, ref = null, latest = latestVersion, globalRoot } = {}) {
  const root = repoRoot(cwd);
  const cfg = readConfig(root);
  const local = cfg.ci?.mode === 'local';
  const install = detectInstall(root, globalRoot ? { globalRoot } : {});
  const plan = { root, local, install, notes: [], refused: null };
  if (install.kind === 'self') {
    plan.refused = { reason: 'self', message: `this is POCP's own repository (package.json is ${PACKAGE}); there is nothing to upgrade` };
    return plan;
  }
  if (ref !== null && !/^[\w.\-/]+$/.test(ref)) throw new UsageError(`not a usable ref for the POCP action: ${ref}`);
  const current = install.installed || install.locked || null;
  plan.current = current;
  if (to !== null) {
    if (!isVersion(to)) throw new UsageError(`--to takes a version like 1.5.0, not "${to}"`);
    plan.target = bare(to);
    plan.target_from = '--to';
    if (current && compareVersions(plan.target, current) < 0) {
      plan.refused = { reason: 'downgrade', message: `--to ${plan.target} is older than the installed ${current}; pocp upgrade only moves forward. To go back: install ${PACKAGE}@${plan.target} yourself, then pocp init --github --force --pocp-ref v${plan.target}` };
      return plan;
    }
  } else {
    const l = latest(root);
    if (!l.ok) {
      plan.refused = { reason: 'registry', message: `couldn't ask the npm registry for the latest version (${l.error}). Pass --to <version> (see ${RELEASES_URL})` };
      return plan;
    }
    plan.target = l.version;
    plan.target_from = 'npm';
  }
  const target = plan.target;
  // Never move an install back: a development build newer than the latest release stays.
  const ahead = current && compareVersions(current, target) > 0;

  // The dependency.
  if (install.kind === 'dependency') {
    const args = installArgs(install.pm, target, { field: install.field, exact: install.exact });
    plan.dependency = current === target && install.installed
      ? { action: 'none', reason: `${PACKAGE} ${target} is installed` }
      : ahead ? { action: 'none', reason: `the installed ${current} is newer than ${target}` }
        : { action: 'install', pm: install.pm, args, command: commandText(install.pm, args), from: current, to: target, files: ['package.json', ...LOCKFILES[install.pm].filter((f) => fs.existsSync(path.join(root, f)))] };
    if (current === target && !install.installed) plan.notes.push(`node_modules has no ${PACKAGE}: run ${install.pm} install`);
  } else if (install.kind === 'global') {
    const args = installArgs('npm', target, { global: true });
    plan.dependency = current === target ? { action: 'none', reason: `the global ${PACKAGE} is ${target}` }
      : ahead ? { action: 'none', reason: `the global ${current} is newer than ${target}` }
        : { action: 'install', pm: 'npm', args, command: commandText('npm', args), from: current, to: target, files: [], global: true };
  } else if (install.kind === 'other-source') {
    plan.dependency = { action: 'manual', reason: `package.json installs ${PACKAGE} from "${install.spec}", not the npm registry; change that spec yourself (or switch to the release: ${commandText('npm', installArgs('npm', target, { field: install.field }))})` };
  } else {
    plan.dependency = { action: 'manual', reason: `${PACKAGE} is neither a dependency here nor installed globally with npm, so there is nothing for pocp upgrade to update. To pin it in this repository: ${commandText('npm', installArgs('npm', target))}` };
  }

  // The workflows, re-pinned to the release (or --pocp-ref).
  const pinTo = ref || (isRelease(target) ? `v${target}` : null);
  plan.ref = pinTo;
  plan.ref_explicit = Boolean(ref);
  plan.workflows = pinTo ? planWorkflows(root, pinTo, { explicit: Boolean(ref), version: target }) : [];
  if (!pinTo && workflowPins(root).length) plan.notes.push(`${target} is a pre-release, which has no release tag: the workflows are left alone (pass --pocp-ref <tag|sha> to pin them)`);
  for (const w of plan.workflows) {
    for (const l of w.left) {
      if (l.reason === 'commit') plan.notes.push(`${w.file}: ${l.from} is pinned to a commit, left alone. To re-pin it: pocp upgrade --pocp-ref <commit of v${target}> (git ls-remote https://github.com/${ACTION_REPO} refs/tags/v${target} prints it)`);
      else if (l.reason === 'branch') plan.notes.push(`${w.file}: ${l.from} follows a branch, left alone`);
      else plan.notes.push(`${w.file}: ${l.from} is newer than ${target}, left alone`);
    }
  }
  if (local && !plan.workflows.length) plan.notes.push('local mode: no workflows to re-pin');

  // Pins pocp reports but doesn't edit.
  const pc = preCommitPin(root);
  if (pc?.version && compareVersions(pc.version, target) < 0) plan.notes.push(`${pc.file} pins rev ${pc.ref}: pre-commit autoupdate --repo https://github.com/${ACTION_REPO}`);
  for (const p of otherCiPins(root)) if (compareVersions(p.version, target) < 0) plan.notes.push(`${p.file} installs ${PACKAGE}@${p.version}: change it to ${target} by hand`);

  // The git hooks: refreshed with the new release's own `hooks install` when the install changes.
  const h = hooksHealth(root);
  plan.hooks = !plan.dependency || plan.dependency.action !== 'install' ? { action: 'none' }
    : !h.installed ? { action: 'none', reason: 'pocp\'s git hooks are not installed' }
      : h.managedBy === 'pre-commit' ? { action: 'none', reason: 'the pre-commit framework manages the hooks' }
        : configuredHooksPath(root) ? { action: 'none', reason: 'core.hooksPath is set; run pocp hooks install --force there if you want them refreshed' }
          : { action: 'refresh' };

  plan.files = [...new Set([...(plan.dependency.files || []), ...plan.workflows.filter((w) => w.changed.length).map((w) => w.file)])];
  plan.changes = plan.dependency.action === 'install' || plan.workflows.some((w) => w.changed.length);
  // CI files the pull request will change, and the approvals that takes (status-report.js).
  plan.ci_files = plan.files.filter((f) => ciProtects(f, cfg.ci, { withDefaults: true }));
  plan.workflow_approver = cfg.ci?.workflow_approver || 'independent';
  // An upgrade is a change of its own: refuse when other tracked files have uncommitted changes.
  // Changes in the files upgrade writes are fine, so an interrupted upgrade can be run again.
  // The files any upgrade of this install writes count too, so a re-run after the install
  // (package.json changed) and before the re-pin still goes through.
  const own = new Set([...plan.files, ...(install.kind === 'dependency' ? ['package.json', ...LOCKFILES[install.pm]] : []), ...plan.workflows.map((w) => w.file)]);
  plan.blocked_by = plan.changes ? dirtyFiles(root).filter((f) => !own.has(f)) : [];
  return plan;
}

/** Carry out a plan from planUpgrade. Returns the plan with { applied, error } added. */
export function applyUpgrade(plan) {
  const { root } = plan;
  const result = { ...plan, applied: [] };
  if (plan.refused || !plan.changes) return result;
  if (plan.blocked_by.length) {
    result.refused = { reason: 'dirty', message: `uncommitted changes in ${plan.blocked_by.join(', ')}: commit or stash them first, so the upgrade is a change of its own (pocp upgrade --dry-run shows what it would change)` };
    return result;
  }
  let version = plan.target;
  let newBin = null;
  const dep = plan.dependency;
  if (dep.action === 'install') {
    // The install goes first: if it fails (offline, registry down), nothing else has changed.
    const r = spawnSync(pmBin(dep.pm), dep.args, { cwd: root, stdio: ['ignore', 2, 2], timeout: 10 * 60 * 1000 });
    if (r.status !== 0) {
      result.error = `${dep.command} failed (${r.error?.message || `exit ${r.status}`}); nothing else was changed`;
      return result;
    }
    newBin = dep.global ? path.join(plan.install.root, PACKAGE, 'bin', 'pocp.js') : plan.install.bin;
    // Pin what was installed, so the workflows and the install can't disagree.
    const got = readJson(path.join(path.dirname(path.dirname(newBin)), 'package.json'))?.version;
    if (got && got !== version) {
      result.error = `${dep.command} installed ${got}, not ${version}; the workflows were not re-pinned`;
      return result;
    }
    result.applied.push(`installed ${PACKAGE} ${version}${dep.global ? ' globally (every repository on this machine that runs pocp from PATH uses it)' : ''}`);
  } else if (plan.install.bin && fs.existsSync(plan.install.bin)) newBin = plan.install.bin;

  // Re-pin from the files as they are now.
  if (plan.workflows.some((w) => w.changed.length)) {
    const ref = plan.ref;
    result.workflows = planWorkflows(root, ref, { explicit: plan.ref_explicit, version });
    for (const w of result.workflows) if (w.changed.length) fs.writeFileSync(path.join(root, w.file), w.text);
    // Compare with the new release's own templates: a difference is the user's edits or a
    // change in the template that a re-pin doesn't bring.
    const templates = newBin ? path.join(path.dirname(path.dirname(newBin)), 'examples', 'github') : path.join(PKG_ROOT, 'examples', 'github');
    for (const name of GITHUB_WORKFLOWS) {
      const file = `.github/workflows/${name}`;
      const tpl = readText(path.join(templates, name));
      const now = readText(path.join(root, file));
      if (tpl && now && result.workflows.some((w) => w.file === file && w.changed.length) && tpl.replaceAll('POCP_REF', ref) !== now) {
        result.notes = [...(result.notes || []), `${file} differs from ${version}'s template (your edits, or a template change a re-pin doesn't bring): pocp init --github --force rewrites it from the template; review the diff before committing`];
      }
    }
  }

  if (plan.hooks.action === 'refresh' && newBin && fs.existsSync(newBin)) {
    const r = spawnSync(process.execPath, [newBin, 'hooks', 'install'], { cwd: root, encoding: 'utf8' });
    result.hooks = r.status === 0 ? { action: 'refreshed' } : { action: 'failed', reason: (r.stderr || r.stdout || '').trim().split('\n').pop() };
  }
  return result;
}

/** Human output for a plan (dry run) or a result. */
export function formatUpgrade(r, { dryRun = false } = {}) {
  if (r.refused && r.refused.reason !== 'dirty') return `pocp upgrade: ${r.refused.message}`;
  const lines = [];
  const from = r.current || 'not installed';
  const source = r.target_from === 'npm' ? 'the latest on npm' : 'from --to';
  const workflows = (r.workflows || []).filter((w) => w.changed.length);
  if (!r.changes) {
    lines.push(`pocp upgrade: nothing to change: ${r.target} (${source})${r.dependency?.reason && r.dependency.action !== 'manual' ? `; ${r.dependency.reason}` : ''}${r.ref && !workflows.length && workflowPins(r.root).some((p) => p.ref === r.ref) ? `; the workflows pin ${r.ref}` : ''}`);
    if (r.dependency?.action === 'manual') lines.push(`  ${r.dependency.reason}`);
    for (const n of r.notes || []) lines.push(`  note: ${n}`);
    return lines.join('\n');
  }
  // Only a run that went through says what it did; a dry run, a refusal or a failed install
  // says what it would do.
  const done = !dryRun && !r.refused && !r.error;
  lines.push(`pocp upgrade${dryRun ? ' --dry-run' : ''}${done ? '' : ' (nothing changed)'}: ${r.dependency.action === 'install' ? `${from} → ` : ''}${r.target} (${source})`);
  const dep = r.dependency;
  const verb = done ? 'ran' : 'would run';
  if (dep.action === 'install') lines.push(`  dependency: ${verb} ${dep.command}${dep.files.length ? ` (${dep.files.join(', ')})` : ''}`);
  else if (dep.action === 'manual') lines.push(`  dependency: ${dep.reason}`);
  else lines.push(`  dependency: unchanged (${dep.reason})`);
  for (const w of workflows) {
    const pairs = [...new Set(w.changed.map((c) => `${c.from} → ${c.to.split('@').pop()}`))];
    lines.push(`  workflow:   ${w.file}: ${pairs.join(', ')}${done ? '' : ' (would re-pin)'}`);
  }
  if (r.hooks?.action === 'refresh') lines.push(`  hooks:      would refresh with ${r.target}'s hooks`);
  else if (r.hooks?.action === 'refreshed') lines.push(`  hooks:      refreshed with ${r.target}'s hooks`);
  else if (r.hooks?.action === 'failed') lines.push(`  hooks:      not refreshed (${r.hooks.reason}); run pocp hooks install`);
  for (const n of r.notes || []) lines.push(`  note: ${n}`);
  if (r.error) {
    lines.push(`error: ${r.error}`);
    return lines.join('\n');
  }
  if (r.refused) {
    lines.push(`refused: ${r.refused.message}`);
    return lines.join('\n');
  }
  if (dryRun) {
    if (r.blocked_by?.length) lines.push(`  would refuse now: uncommitted changes in ${r.blocked_by.join(', ')} (commit or stash them first)`);
    lines.push('run pocp upgrade to apply it');
  } else {
    lines.push('next:');
    lines.push(`  1. review it: git diff${r.files.length ? ` -- ${r.files.join(' ')}` : ''}`);
    if (r.files.length) lines.push(`  2. commit it on a branch of its own (if the hook blocks the commit: pocp fix --intent "Upgrade POCP to ${r.target}")`);
    if (r.ci_files.length && !r.local) {
      const who = r.workflow_approver === 'independent' ? ', added by a maintainer who isn\'t the pull request\'s author' : ', added by a maintainer';
      lines.push(`  3. the pull request changes CI files (${r.ci_files.join(', ')}), so it needs the pocp-approve-workflow label${who}, and pocp-approve-policy. That's expected, not friction: an upgrade changes what judges your code, so a person approves it.`);
    } else if (r.local) lines.push('  local mode: no CI approves this; the hooks run the new release from the next commit');
    lines.push(`  then: pocp doctor   (release notes: ${RELEASES_URL}/tag/v${r.target})`);
  }
  return lines.join('\n');
}

/** The JSON shape: the plan or result without the file texts. */
export function upgradeJson(r, { dryRun = false } = {}) {
  const strip = (ws) => (ws || []).map(({ text, ...w }) => w);
  const { root, install, ...rest } = r;
  return { dry_run: dryRun, ...rest, install: install && { ...install }, workflows: strip(r.workflows) };
}
