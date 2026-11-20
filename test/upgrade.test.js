// pocp upgrade, and doctor's version-drift check. A fake npm (POCP_NPM) stands in for the
// registry and the install, so no test touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, pocp, tmpRepo, write } from './helpers.js';
import { compareVersions, installArgs, lockedVersion, repinText } from '../src/upgrade.js';
import { writeGithubWorkflows } from '../src/init.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * A fake npm. `view` prints FAKE_NPM_LATEST (fails when FAKE_NPM_OFFLINE), `root --global`
 * prints FAKE_NPM_GLOBAL, `install` copies this checkout in as proof-of-change@<version> and
 * records it in package.json and package-lock.json. Every call is appended to FAKE_NPM_LOG.
 */
function fakeNpm(dir) {
  const file = path.join(dir, '..', `${path.basename(dir)}-npm.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(' ') + '\\n');
if (args[0] === 'view') {
  if (process.env.FAKE_NPM_OFFLINE) { process.stderr.write('npm error code ENOTFOUND\\n'); process.exit(1); }
  process.stdout.write(process.env.FAKE_NPM_LATEST + '\\n');
  process.exit(0);
}
if (args[0] === 'root') {
  if (!process.env.FAKE_NPM_GLOBAL) process.exit(1);
  process.stdout.write(process.env.FAKE_NPM_GLOBAL + '\\n');
  process.exit(0);
}
if (args[0] === 'install') {
  if (process.env.FAKE_NPM_FAIL) { process.stderr.write('npm error network\\n'); process.exit(1); }
  const spec = args.find((a) => a.startsWith('proof-of-change@'));
  const version = spec.split('@')[1];
  const global = args.includes('--global');
  const nm = global ? process.env.FAKE_NPM_GLOBAL : path.join(process.cwd(), 'node_modules');
  ${installBody()}
  if (!global) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const field = args.includes('--save-prod') ? 'dependencies' : 'devDependencies';
    pkg[field] = { ...pkg[field], 'proof-of-change': args.includes('--save-exact') ? version : '^' + version };
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
    fs.writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/proof-of-change': { version } } }, null, 2) + '\\n');
  }
  process.exit(0);
}
process.exit(2);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

// Puts a copy of this checkout at <nm>/proof-of-change with package.json's version set.
function installBody() {
  return `const dest = path.join(nm, 'proof-of-change');
  fs.rmSync(dest, { recursive: true, force: true });
  for (const d of ['bin', 'src', 'examples']) fs.cpSync(path.join(${JSON.stringify(ROOT)}, d), path.join(dest, d), { recursive: true });
  const own = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ ...own, version }, null, 2));
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  fs.rmSync(path.join(nm, '.bin', 'pocp'), { force: true });
  fs.symlinkSync('../proof-of-change/bin/pocp.js', path.join(nm, '.bin', 'pocp'));`;
}

/** Install proof-of-change@<version> into a folder the way the fake npm does, without npm. */
function installAt(nm, version) {
  // eslint-disable-next-line no-new-func
  new Function('fs', 'path', 'nm', 'version', installBody())(fs, path, nm, version);
}

/** A repository that depends on proof-of-change@<version> (installed), set up with init. */
function adopter({ version = '1.3.0', init = ['--github', '--pocp-ref', `v${version}`], spec = `^${version}` } = {}) {
  const dir = tmpRepo();
  write(dir, 'package.json', `${JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { 'proof-of-change': spec } }, null, 2)}\n`);
  write(dir, 'package-lock.json', `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/proof-of-change': { version } } }, null, 2)}\n`);
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'README.md', 'app\n');
  installAt(path.join(dir, 'node_modules'), version);
  assert.equal(pocp(dir, ['init', ...init]).code, 0);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'adopt POCP', '--no-verify');
  const log = path.join(dir, '..', `${path.basename(dir)}-npm.log`);
  fs.writeFileSync(log, '');
  const env = { POCP_NPM: fakeNpm(dir), FAKE_NPM_LOG: log, FAKE_NPM_LATEST: '1.5.0' };
  return { dir, env, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const status = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=no');

test('versions compare numerically, and a pre-release sorts before its release', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.4.0', '1.4.0') === 0);
  assert.ok(compareVersions('1.5.0-rc.1', '1.5.0') < 0);
  assert.ok(compareVersions('1.5.0-rc.2', '1.5.0-rc.10') < 0);
});

test('the install command fits the package manager, and keeps an exact pin exact', () => {
  assert.deepEqual(installArgs('npm', '1.5.0'), ['install', '--save-dev', 'proof-of-change@1.5.0']);
  assert.deepEqual(installArgs('npm', '1.5.0', { exact: true, field: 'dependencies' }), ['install', '--save-prod', '--save-exact', 'proof-of-change@1.5.0']);
  assert.deepEqual(installArgs('pnpm', '1.5.0'), ['add', '--save-dev', 'proof-of-change@1.5.0']);
  assert.deepEqual(installArgs('yarn', '1.5.0', { exact: true }), ['add', '--dev', '--exact', 'proof-of-change@1.5.0']);
  assert.deepEqual(installArgs('bun', '1.5.0'), ['add', '--dev', 'proof-of-change@1.5.0']);
  assert.deepEqual(installArgs('npm', '1.5.0', { global: true }), ['install', '--global', 'proof-of-change@1.5.0']);
});

test('re-pinning moves release tags forward, and leaves commits, branches and newer tags alone', () => {
  const text = [
    '      - uses: harriswekselblatt/pocp@v1.3.0   # pin a release',
    '      - uses: harriswekselblatt/pocp/status@v1.3.0',
    `      - uses: harriswekselblatt/pocp@${SHA} # v1.3.0`,
    '      - uses: harriswekselblatt/pocp@main',
    '      - uses: harriswekselblatt/pocp@v9.0.0',
    '      - uses: someone/pocp-fork@v1.3.0',
    '      - uses: actions/checkout@v4',
  ].join('\n');
  const r = repinText(text, 'v1.5.0', { version: '1.5.0' });
  assert.deepEqual(r.changed.map((c) => c.from), ['harriswekselblatt/pocp@v1.3.0', 'harriswekselblatt/pocp/status@v1.3.0']);
  assert.deepEqual(r.left.map((l) => l.reason), ['commit', 'branch', 'newer']);
  assert.match(r.text, /pocp@v1\.5\.0 {3}# pin a release/);
  assert.match(r.text, /pocp\/status@v1\.5\.0$/m);
  assert.match(r.text, /someone\/pocp-fork@v1\.3\.0/, 'another repository\'s action is not POCP\'s pin');
  assert.match(r.text, /checkout@v4/);
  // An explicit ref (--pocp-ref) re-pins a commit pin too, and keeps its release comment true.
  const sha2 = 'f'.repeat(40);
  const e = repinText(`      - uses: harriswekselblatt/pocp@${SHA} # v1.3.0`, sha2, { explicit: true, version: '1.5.0' });
  assert.equal(e.text, `      - uses: harriswekselblatt/pocp@${sha2} # v1.5.0`);
});

test('the lockfile version is read from npm, pnpm and yarn lockfiles', () => {
  const dir = tmpRepo();
  write(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  proof-of-change@1.4.0:\n    resolution: {integrity: sha512-x}\n");
  assert.deepEqual(lockedVersion(dir), { file: 'pnpm-lock.yaml', version: '1.4.0' });
  fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
  write(dir, 'yarn.lock', 'proof-of-change@^1.3.0:\n  version "1.3.2"\n  resolved "x"\n');
  assert.deepEqual(lockedVersion(dir), { file: 'yarn.lock', version: '1.3.2' });
  write(dir, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/proof-of-change': { version: '1.2.0' } } }));
  assert.deepEqual(lockedVersion(dir), { file: 'package-lock.json', version: '1.2.0' });
});

test('upgrade: --dry-run shows the bump and the re-pin and changes nothing', () => {
  const { dir, env, calls } = adopter();
  const before = read(dir, '.github/workflows/pocp.yml');
  const r = pocp(dir, ['upgrade', '--dry-run'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /1\.3\.0 → 1\.5\.0 \(the latest on npm\)/);
  assert.match(r.stdout, /would run npm install --save-dev proof-of-change@1\.5\.0 \(package\.json, package-lock\.json\)/);
  assert.match(r.stdout, /\.github\/workflows\/pocp\.yml: harriswekselblatt\/pocp\/status@v1\.3\.0 → v1\.5\.0, harriswekselblatt\/pocp@v1\.3\.0 → v1\.5\.0 \(would re-pin\)/);
  assert.equal(status(dir), '');
  assert.equal(read(dir, '.github/workflows/pocp.yml'), before);
  assert.deepEqual(calls(), ['view proof-of-change version'], 'a dry run only asks the registry');
  const j = pocp(dir, ['upgrade', '--dry-run', '--json'], { env });
  assert.equal(j.json.dry_run, true);
  assert.equal(j.json.target, '1.5.0');
  assert.equal(j.json.dependency.action, 'install');
  assert.deepEqual(j.json.files, ['package.json', 'package-lock.json', '.github/workflows/pocp-status.yml', '.github/workflows/pocp.yml']);
});

test('upgrade: bumps the devDependency, re-pins the workflows like --pocp-ref, says which labels the PR needs, and a re-run changes nothing', () => {
  const { dir, env, calls } = adopter();
  const r = pocp(dir, ['upgrade'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(calls(), ['view proof-of-change version', 'install --save-dev proof-of-change@1.5.0']);
  assert.equal(JSON.parse(read(dir, 'package.json')).devDependencies['proof-of-change'], '^1.5.0');
  assert.equal(JSON.parse(read(dir, 'node_modules/proof-of-change/package.json')).version, '1.5.0');
  // The same files `init --github --pocp-ref v1.5.0` writes.
  const fresh = tmpRepo();
  writeGithubWorkflows(fresh, { ref: 'v1.5.0' });
  for (const f of ['pocp.yml', 'pocp-status.yml']) assert.equal(read(dir, `.github/workflows/${f}`), read(fresh, `.github/workflows/${f}`), f);
  assert.match(r.stdout, /pocp-approve-workflow label, added by a maintainer who isn't the pull request's author, and pocp-approve-policy/);
  assert.match(r.stdout, /an upgrade changes what judges your code/);
  assert.doesNotMatch(r.stdout, /differs from/);
  // Hooks weren't installed (init --github without --hooks): nothing to refresh.
  assert.doesNotMatch(r.stdout, /hooks: /);

  // Run again before committing: nothing left to do, and nothing is written.
  const snapshot = ['package.json', 'package-lock.json', '.github/workflows/pocp.yml'].map((f) => read(dir, f));
  const again = pocp(dir, ['upgrade'], { env });
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /nothing to change: 1\.5\.0 \(the latest on npm\); proof-of-change 1\.5\.0 is installed; the workflows pin v1\.5\.0/);
  assert.deepEqual(['package.json', 'package-lock.json', '.github/workflows/pocp.yml'].map((f) => read(dir, f)), snapshot);
  assert.equal(calls().filter((c) => c.startsWith('install')).length, 1);
});

test('upgrade: refuses with uncommitted changes in other files, and changes nothing', () => {
  const { dir, env, calls } = adopter();
  write(dir, 'README.md', 'app, edited\n');
  const r = pocp(dir, ['upgrade'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /refused: uncommitted changes in README\.md: commit or stash them first/);
  assert.match(r.stdout, /\(nothing changed\)/);
  assert.doesNotMatch(r.stdout, /\bran npm|re-pinned|refreshed/);
  assert.match(r.stdout, /\(would re-pin\)/);
  assert.ok(!calls().some((c) => c.startsWith('install')));
  assert.equal(JSON.parse(read(dir, 'package.json')).devDependencies['proof-of-change'], '^1.3.0');
  // The dry run says it would refuse, and still shows the plan.
  const d = pocp(dir, ['upgrade', '--dry-run'], { env });
  assert.equal(d.code, 0);
  assert.match(d.stdout, /would refuse now: uncommitted changes in README\.md/);
});

test('upgrade: an interrupted upgrade can be run again (its own files may be dirty)', () => {
  const { dir, env } = adopter();
  // The install happened, the re-pin didn't.
  installAt(path.join(dir, 'node_modules'), '1.5.0');
  write(dir, 'package.json', `${JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { 'proof-of-change': '^1.5.0' } }, null, 2)}\n`);
  const r = pocp(dir, ['upgrade'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /dependency: unchanged \(proof-of-change 1\.5\.0 is installed\)/);
  assert.match(read(dir, '.github/workflows/pocp.yml'), /harriswekselblatt\/pocp@v1\.5\.0/);
});

test('upgrade: local mode bumps the dependency, has no workflows to re-pin, refreshes the hooks, and needs no labels', () => {
  const { dir, env } = adopter({ init: ['--local'] });
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  const r = pocp(dir, ['upgrade', '--to', '1.5.0'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /1\.3\.0 → 1\.5\.0 \(from --to\)/);
  assert.match(r.stdout, /local mode: no workflows to re-pin/);
  assert.match(r.stdout, /hooks: {6}refreshed with 1\.5\.0's hooks/);
  assert.match(r.stdout, /local mode: no CI approves this/);
  assert.doesNotMatch(r.stdout, /pocp-approve/);
  assert.ok(fs.readFileSync(hook, 'utf8').includes(path.join('node_modules', 'proof-of-change', 'bin', 'pocp.js')), 'the hooks now remember the new install');
  assert.equal(JSON.parse(read(dir, 'package.json')).devDependencies['proof-of-change'], '^1.5.0');
});

test('upgrade: --to makes no registry lookup; an older --to is refused; an offline lookup says what to do', () => {
  const { dir, env, calls } = adopter({ spec: '1.3.0' });
  const down = pocp(dir, ['upgrade', '--to', '1.2.0'], { env });
  assert.equal(down.code, 1);
  assert.match(down.stdout, /only moves forward/);
  const off = pocp(dir, ['upgrade'], { env: { ...env, FAKE_NPM_OFFLINE: '1' } });
  assert.equal(off.code, 1);
  assert.match(off.stdout, /couldn't ask the npm registry for the latest version \(npm error code ENOTFOUND\)\. Pass --to <version>/);
  const r = pocp(dir, ['upgrade', '--to', '1.4.0'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(calls().includes('install --save-dev --save-exact proof-of-change@1.4.0'), 'an exact pin stays exact');
  assert.equal(calls().filter((c) => c.startsWith('view')).length, 1, 'only the run without --to asked the registry');
  const failed = pocp(dir, ['upgrade', '--to', '1.5.0'], { env: { ...env, FAKE_NPM_FAIL: '1' } });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /failed \(exit 1\); nothing else was changed/);
  assert.doesNotMatch(failed.stdout, /\bran npm/);
  assert.match(failed.stdout, /\(would re-pin\)/);
  assert.match(read(dir, '.github/workflows/pocp.yml'), /pocp@v1\.4\.0/);
});

test('upgrade: a commit pin is left alone with the command to re-pin it; --pocp-ref re-pins it', () => {
  const { dir, env } = adopter({ init: ['--github', '--pocp-ref', SHA] });
  const r = pocp(dir, ['upgrade', '--dry-run'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /pinned to a commit, left alone\. To re-pin it: pocp upgrade --pocp-ref <commit of v1\.5\.0> \(git ls-remote https:\/\/github\.com\/harriswekselblatt\/pocp refs\/tags\/v1\.5\.0/);
  assert.doesNotMatch(r.stdout, /workflow: /);
  const sha2 = 'a'.repeat(40);
  const p = pocp(dir, ['upgrade', '--pocp-ref', sha2], { env });
  assert.equal(p.code, 0, p.stderr + p.stdout);
  assert.ok(!read(dir, '.github/workflows/pocp.yml').includes(SHA));
  assert.match(read(dir, '.github/workflows/pocp-status.yml'), new RegExp(`pocp/status@${sha2}`));
});

test('upgrade: a global install is upgraded with npm --global, and the repository files are left alone', () => {
  const dir = tmpRepo();
  write(dir, 'README.md', 'app\n');
  assert.equal(pocp(dir, ['init', '--github', '--pocp-ref', 'v1.3.0']).code, 0);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'adopt', '--no-verify');
  const groot = path.join(dir, '..', `${path.basename(dir)}-global`);
  installAt(groot, '1.3.0');
  const log = path.join(dir, '..', `${path.basename(dir)}-npm.log`);
  fs.writeFileSync(log, '');
  const env = { POCP_NPM: fakeNpm(dir), FAKE_NPM_LOG: log, FAKE_NPM_GLOBAL: groot };
  const r = pocp(dir, ['upgrade', '--to', '1.5.0'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /ran npm install --global proof-of-change@1\.5\.0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(groot, 'proof-of-change', 'package.json'), 'utf8')).version, '1.5.0');
  assert.match(read(dir, '.github/workflows/pocp.yml'), /pocp@v1\.5\.0/);
  assert.ok(!fs.existsSync(path.join(dir, 'package.json')));
  // Without a global install or a dependency, there's nothing to bump: it says how to add one.
  const none = pocp(dir, ['upgrade', '--to', '1.5.0'], { env: { ...env, FAKE_NPM_GLOBAL: '' } });
  assert.equal(none.code, 0, none.stderr + none.stdout);
  assert.match(none.stdout, /neither a dependency here nor installed globally/);
});

test('upgrade: a re-pinned workflow that differs from the new release\'s template is pointed out', () => {
  const { dir, env } = adopter();
  write(dir, '.github/workflows/pocp.yml', `${read(dir, '.github/workflows/pocp.yml')}# our own tweak\n`);
  git(dir, 'commit', '-qam', 'tweak', '--no-verify');
  const r = pocp(dir, ['upgrade'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /\.github\/workflows\/pocp\.yml differs from 1\.5\.0's template/);
  assert.doesNotMatch(r.stdout, /pocp-status\.yml differs/);
  assert.match(read(dir, '.github/workflows/pocp.yml'), /pocp@v1\.5\.0[\s\S]*# our own tweak/);
});

test('upgrade: a git dependency is explained, not converted', () => {
  const { dir, env } = adopter({ spec: `github:harriswekselblatt/pocp#${SHA}` });
  const r = pocp(dir, ['upgrade', '--to', '1.5.0', '--dry-run'], { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /installs proof-of-change from "github:harriswekselblatt\/pocp#0123/);
});

test('doctor: notes when the hooks and CI run different POCP releases, with no network', () => {
  const { dir, env, calls } = adopter({ init: ['--github', '--pocp-ref', 'v1.5.0'] });
  const r = pocp(dir, ['doctor', '--offline', '--json'], { env });
  const c = r.json.checks.find((x) => x.id === 'pocp-versions');
  assert.equal(c.status, 'warning', JSON.stringify(c));
  assert.match(c.what, /1\.3\.0 in node_modules; package-lock\.json; 1\.5\.0 in \.github\/workflows\/pocp-status\.yml, \.github\/workflows\/pocp\.yml/);
  assert.match(c.fix, /pocp upgrade/);
  assert.deepEqual(calls(), [], 'doctor runs no npm');

  // Once they agree, an ok line.
  assert.equal(pocp(dir, ['upgrade', '--to', '1.5.0'], { env }).code, 0);
  const ok = pocp(dir, ['doctor', '--offline', '--json'], { env }).json.checks.find((x) => x.id === 'pocp-versions');
  assert.equal(ok.status, 'ok');
  assert.match(ok.what, /the same POCP everywhere: 1\.5\.0/);
});

test('doctor: node_modules behind the lockfile says to install, in local mode the workflows are not compared', () => {
  const { dir, env } = adopter({ init: ['--local'] });
  write(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/proof-of-change': { version: '1.4.0' } } }));
  // Leftover workflows from before local mode don't count: no CI runs them.
  writeGithubWorkflows(dir, { ref: 'v1.0.0' });
  const c = pocp(dir, ['doctor', '--offline', '--json'], { env }).json.checks.find((x) => x.id === 'pocp-versions');
  assert.equal(c.status, 'warning', JSON.stringify(c));
  assert.equal(c.fix, 'npm install');
  assert.doesNotMatch(c.what, /workflows/);
});
