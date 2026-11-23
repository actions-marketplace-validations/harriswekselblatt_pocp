// The box (lib/box.js): how containers are started, and what each run mounts and sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOX_NODE, BOX_PATH, boxRunArgs, folderHash, BOX_DIR, PROXY_ENV } from '../lib/box.js';
import { boxRunParts } from '../run.js';
import { BOX_SETTINGS } from '../agents/claude.js';
import { BOX_SANDBOX, codexArgs } from '../agents/codex.js';
import { boxExec } from '../judge.js';
import { POCP_ROOT } from '../lib/proc.js';

test('boxRunArgs: hardened, named, no network by default, logins by name only', () => {
  const args = boxRunArgs({ image: 'img', name: 'run-1', mounts: [{ src: '/w/p' }, { src: '/w/tools', ro: true }, { src: 'vol', dst: '/home/dev/x' }], env: { PATH: '/usr/bin' }, envNames: ['CLAUDE_CODE_OAUTH_TOKEN'], workdir: '/w/p/repo', cmd: ['claude', '-p'] });
  const s = args.join(' ');
  for (const part of ['--rm', '--name run-1', '--hostname devbox', '--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 4g', '--pids-limit 512', '-v /w/p:/w/p', '-v /w/tools:/w/tools:ro', '-v vol:/home/dev/x', '-e PATH=/usr/bin', '-e CLAUDE_CODE_OAUTH_TOKEN', '-w /w/p/repo']) assert.ok(s.includes(part), part);
  assert.ok(!s.includes('CLAUDE_CODE_OAUTH_TOKEN='), 'a login value never appears in argv');
  assert.ok(!args.includes('/var/run/docker.sock') && !s.includes('docker.sock'));
  assert.deepEqual(args.slice(-3), ['img', 'claude', '-p']);
});

test('the proxy is the only way out: proxy variables point at it and nothing bypasses it', () => {
  assert.equal(PROXY_ENV.HTTPS_PROXY, 'http://proxy:8888');
  assert.ok(!JSON.stringify(PROXY_ENV).toLowerCase().includes('pocp'), 'nothing in an agent\'s env names POCP');
  assert.equal(PROXY_ENV.NO_PROXY, '');
  const filter = fs.readFileSync(path.join(BOX_DIR, 'proxy', 'filter'), 'utf8').trim().split('\n');
  assert.deepEqual(filter, ['^api\\.anthropic\\.com$', '^chatgpt\\.com$', '^auth\\.openai\\.com$']);
  assert.match(fs.readFileSync(path.join(BOX_DIR, 'proxy', 'tinyproxy.conf'), 'utf8'), /FilterDefaultDeny Yes/);
});

test('the box image is pinned: base images by digest, CLIs by exact version, no auto-update', () => {
  const df = fs.readFileSync(path.join(BOX_DIR, 'agent', 'Dockerfile'), 'utf8');
  for (const m of df.matchAll(/^FROM (\S+)/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}$/, m[1]);
  assert.match(df, /@anthropic-ai\/claude-code@2\.1\.178/);
  assert.match(df, /@openai\/codex@0\.169\.1/);
  assert.match(df, /DISABLE_AUTOUPDATER=1/);
  assert.equal(folderHash(path.join(BOX_DIR, 'agent')).length, 12);
});

test('boxRunParts: plain arms mount only their project; POCP arms add the copy read-only and its node', () => {
  const seal = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'boxparts-')) };
  fs.mkdirSync(path.join(seal.root, 'homes'));
  const copy = { root: '/w/tools/pocp', bin: '/w/tools/pocp/bin/pocp.js', binDir: '/w/tools/bin' };
  const m = { top: '/w/proj-1' };
  const plain = boxRunParts({ arm: 'plain', agent: 'claude' }, m, copy, { seal });
  assert.deepEqual(plain.boxMounts, [{ src: '/w/proj-1' }]);
  assert.equal(plain.boxEnv.PATH, BOX_PATH);
  assert.ok(!('POCP_BIN' in plain.boxEnv));
  assert.equal(plain.boxHome, null);
  const ci = boxRunParts({ arm: 'pocp-ci', agent: 'codex' }, m, copy, { seal });
  assert.deepEqual(ci.boxMounts, [{ src: '/w/proj-1' }, { src: '/w/tools', ro: true }]);
  assert.equal(ci.boxEnv.POCP_BIN, `${BOX_NODE} /w/tools/pocp/bin/pocp.js`);
  assert.ok(ci.boxEnv.PATH.startsWith('/w/tools/bin:'));
  assert.ok(ci.boxHome.startsWith(path.join(seal.root, 'homes')));
  assert.equal(ci.boxEnv.GIT_AUTHOR_NAME, 'Developer');
  fs.rmSync(seal.root, { recursive: true, force: true });
});

test('in the box both agents run without their own sandbox (the container is the boundary), web tools still off', () => {
  assert.equal(BOX_SETTINGS.sandbox.enabled, false);
  assert.ok(BOX_SETTINGS.permissions.deny.includes('WebFetch'));
  const args = codexArgs({ repo: '/w/r', model: 'm', profile: BOX_SANDBOX });
  assert.ok(args.join(' ').includes('--sandbox danger-full-access'));
  assert.ok(args.includes('web_search="disabled"'));
});

test('the judge in the box: no network, only the step\'s folder (and read-only code it needs), no host values', async () => {
  const calls = [];
  const runner = async (o) => { calls.push(o); return { code: 0, out: 'ok\n', err: '', boxFailure: null }; };
  const ref = path.join(POCP_ROOT, 'eval', 'reference', 'check.py');
  const x = boxExec({ image: 'img' }, { top: '/w/proj-1', referencePath: ref, frozenFile: '/f/frozen.jsonl', runner });
  await x.run('sh', ['-c', 'python3 tests/test_task.py'], { cwd: '/w/proj-1/c1/repo', env: { HOME: '/Users/me', GIT_AUTHOR_NAME: 'Developer', POCP_BIN: '/Users/me/.local/bin/node /x/pocp.js', SECRET: 's' } });
  assert.equal(calls[0].network, 'none');
  assert.deepEqual(calls[0].mounts, [{ src: '/w/proj-1/c1/repo' }], 'plain CI sees only the clone it judges');
  assert.deepEqual(Object.keys(calls[0].env).sort(), ['GIT_AUTHOR_NAME', 'PATH', 'POCP_BIN']);
  assert.ok(!JSON.stringify(calls[0].env).includes('/Users/me'));
  assert.deepEqual(x.refMounts(), [{ src: path.dirname(ref), ro: true }, { src: '/f/frozen.jsonl', ro: true }]);
  assert.ok(x.pocpMounts.every((m) => m.ro && m.src.startsWith(POCP_ROOT)));
  // git on the agent's repo runs in the box too (its .git/config could make git run commands).
  assert.equal(await x.git('/w/proj-1/repo', ['rev-parse', 'HEAD']), 'ok');
  assert.equal(calls[1].cmd[0], 'git');
  assert.deepEqual(calls[1].mounts, [{ src: '/w/proj-1' }]);
  // A box that never ran the command is a harness error, not a result.
  const bad = boxExec({ image: 'img' }, { top: '/w', runner: async () => ({ code: 125, boxFailure: 'docker exit 125' }) });
  await assert.rejects(bad.run('sh', [], { cwd: '/w' }), /box failure/);
});

test('Codex login secrets are found for redaction; the agent POCP copy carries a stripped package.json', async () => {
  const { loginSecrets } = await import('../agents/codex.js');
  const sec = loginSecrets(Buffer.from(JSON.stringify({ tokens: { access_token: 'a'.repeat(40), id_token: 'b'.repeat(30), short: 'x' }, last_refresh: '2026' })));
  assert.deepEqual(sec.sort(), ['a'.repeat(40), 'b'.repeat(30)]);
  assert.deepEqual(loginSecrets('not json'), []);
  const { pocpCopy } = await import('../materialize.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-'));
  const c = pocpCopy(path.join(dir, 'tools'));
  const pkg = JSON.parse(fs.readFileSync(path.join(c.root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg).sort(), ['bin', 'engines', 'name', 'type', 'version']);
  const { removeTree } = await import('../lib/proc.js');
  removeTree(dir);
});

test('infraFailure: a box failure is the harness\'s, re-run after a stop', async () => {
  const { infraFailure, RERUN_INFRA, VOIDING } = await import('../run.js');
  assert.equal(infraFailure({ status: 'harness-error', box_failure: 'docker exit 125: no such image' }).kind, 'box-failure');
  assert.ok(RERUN_INFRA.includes('box-failure'));
  assert.ok(VOIDING.includes('image-changed'));
});
