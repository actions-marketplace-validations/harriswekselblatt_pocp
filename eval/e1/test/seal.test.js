// The seal (lib/seal.js) and the seal audit (lib/audit.js): what an agent can reach of the
// machine, and what its transcript shows it touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_SETTINGS, sealedSettings } from '../agents/claude.js';
import { APP_BIN, sealedProfile } from '../agents/codex.js';
import { SEAL_PARENT, SYSTEM_PATH, agentEnv, aliases, createSealRoot, denyList, openSeal } from '../lib/seal.js';
import { allowedPath, auditRun, pathsInCommand, toolCalls } from '../lib/audit.js';
import { Refusal, runBatch, strayInstructions } from '../run.js';
import { FIX, FROZEN, STUB_CHECK, fake, tmp } from './helpers.js';

function tree() {
  // /<t>/top/{a,b,c}/... with the root at /<t>/top/b/inner/root
  const t = tmp('seal-');
  for (const p of ['top/a', 'top/b/inner/root', 'top/b/inner/other', 'top/b/side', 'top/c', 'elsewhere']) fs.mkdirSync(path.join(t, p), { recursive: true });
  return t;
}

test('denyList: a sensitive folder holding the root is denied except the path down to it', () => {
  const t = tree();
  const root = path.join(t, 'top/b/inner/root');
  const deny = denyList(root, { sensitive: [path.join(t, 'top'), path.join(t, 'elsewhere'), '/no/such/folder'] });
  assert.deepEqual(deny, [
    path.join(t, 'elsewhere'),
    path.join(t, 'top/a'),
    path.join(t, 'top/b/inner/other'),
    path.join(t, 'top/b/side'),
    path.join(t, 'top/c'),
  ].sort());
  assert.ok(!deny.some((p) => root.startsWith(p)), 'nothing above the root is denied');
});

test('denyList: the real seal denies /Users, other volumes and temp folders, never its own root', () => {
  const seal = openSeal({ extra: [path.join(os.homedir(), 'nonexistent-x')] });
  try {
    assert.ok(!seal.deny.some((p) => seal.root === p || seal.root.startsWith(`${p}/`)));
    assert.ok(new RegExp(`^${fs.realpathSync(SEAL_PARENT)}/ws-[0-9a-f]{4}-`).test(seal.root), seal.root);
    // The macOS layout the seal is built for (on Linux, e.g. CI, these folders don't exist).
    if (process.platform === 'darwin') {
      assert.ok(seal.deny.includes('/Users'));
      assert.ok(seal.deny.some((p) => p.startsWith('/private/var/folders')));
      assert.ok(seal.deny.includes('/private/tmp'), 'the shared temp folder is denied whole');
      assert.ok(seal.deny.length < 40, `a short list (${seal.deny.length}): Codex shows it to the model`);
      assert.ok(!seal.deny.some((p) => p.includes(os.userInfo().username)), 'no path in the list names the owner');
    }
    assert.ok(!seal.root.includes(os.userInfo().username));
    assert.ok(fs.existsSync(seal.node));
  } finally {
    fs.rmSync(seal.root, { recursive: true, force: true });
  }
});

test('aliases: /private/tmp and /private/var paths also get their short spellings', () => {
  assert.deepEqual(aliases('/private/tmp/x'), ['/private/tmp/x', '/tmp/x', '/System/Volumes/Data/private/tmp/x', '/System/Volumes/Data/tmp/x']);
  assert.deepEqual(aliases('/Users'), ['/Users', '/System/Volumes/Data/Users']);
});

test('agentEnv: only allow-listed variables and this agent\'s login pass; HOME, TMPDIR, USER and PATH are the seal\'s', () => {
  const base = {
    PATH: '/Users/me/.local/bin:/usr/bin', HOME: '/Users/me', USER: 'me', NOTES_DIR: '/Users/me/notes', PWD: '/Users/me/studio',
    SSH_AUTH_SOCK: '/x', LANG: 'en_US.UTF-8', GIT_AUTHOR_NAME: 'Developer', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', ZDOTDIR: '/s/z',
    POCP_BIN: '/Users/me/.local/bin/node /Users/me/pocp/bin/pocp.js',
  };
  const env = agentEnv(base, { home: '/s/h', tmp: '/s/h/tmp', pathDirs: ['/s/tools/bin', '/py/bin'], root: '/s', auth: ['CLAUDE_CODE_OAUTH_TOKEN'], forbid: ['/Users/me'] });
  assert.equal(env.HOME, '/s/h');
  assert.equal(env.TMPDIR, '/s/h/tmp');
  assert.equal(env.USER, 'agent');
  assert.equal(env.PATH, ['/s/tools/bin', '/py/bin', ...SYSTEM_PATH].join(':'));
  for (const k of ['NOTES_DIR', 'PWD', 'SSH_AUTH_SOCK', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'POCP_BIN']) assert.ok(!(k in env), k);
  for (const k of ['LANG', 'GIT_AUTHOR_NAME', 'CLAUDE_CODE_OAUTH_TOKEN', 'ZDOTDIR']) assert.ok(k in env, k);
  // POCP_BIN passes only when it points inside the root (the agent's own copy).
  const pocp = agentEnv({ ...base, POCP_BIN: '/s/bin/node /s/work/tools/pocp/bin/pocp.js' }, { home: '/s/h', tmp: '/s/h/tmp', root: '/s', forbid: ['/Users/me'] });
  assert.equal(pocp.POCP_BIN, '/s/bin/node /s/work/tools/pocp/bin/pocp.js');
  // A value that would still name the host is a harness bug: refused, not passed.
  assert.throws(() => agentEnv({ LANG: 'x' }, { home: '/s/h', tmp: '/s/h/tmp', extra: { CLAUDE_CONFIG_DIR: '/Users/me/.claude' }, forbid: ['/Users/me'] }), /names the host/);
});

test('agentEnv on the real harness environment: no value names the owner or the harness checkout', async () => {
  const { harnessEnv, POCP_ROOT } = await import('../lib/proc.js');
  const { forbiddenStrings } = await import('../lib/seal.js');
  const env = agentEnv(harnessEnv(), { home: '/private/var/tmp/ws-x/homes/h', tmp: '/private/var/tmp/ws-x/homes/h/tmp', root: '/private/var/tmp/ws-x', forbid: forbiddenStrings([POCP_ROOT]) });
  assert.ok(!('POCP_BIN' in env), 'the plain arm gets no POCP_BIN (the default names the harness checkout)');
});

test('sealedSettings: the deny list is the Bash sandbox denyRead and file-tool deny rules', () => {
  const s = sealedSettings(['/Users', '/private/tmp/other']);
  assert.ok(s.sandbox.filesystem.denyRead.includes('/tmp/other'));
  for (const r of ['Read(//Users/**)', 'Read(//Users)', 'Edit(//Users/**)', 'Read(//tmp/other/**)', 'Read(//System/Volumes/Data/Users/**)']) assert.ok(s.permissions.deny.includes(r), r);
  for (const t of ['WebFetch', 'PushNotification', 'RemoteTrigger', 'Monitor']) assert.ok(s.permissions.deny.includes(t), t);
  assert.equal(CLAUDE_SETTINGS.sandbox.filesystem, undefined, 'the base settings are not changed');
});

test('sealedProfile: everything readable except the deny list; writable only repo, .git and the given folders', () => {
  const args = sealedProfile({ repo: '/s/work/r', deny: ['/Users'], writable: ['/s/h'] });
  assert.equal(args[1], 'default_permissions="sealed"');
  assert.equal(args[3], 'permissions.sealed.filesystem={"/"="read", "/Users"="deny", "/s/work/r"="write", "/s/work/r/.git"="write", "/s/h"="write"}');
});

test('Codex sandbox with the seal profile: the deny list is unreadable, the repo is writable (no model call)', { skip: !fs.existsSync(APP_BIN) && 'Codex CLI not installed' }, () => {
  const root = createSealRoot();
  try {
    const secret = fs.mkdtempSync(path.join('/private/tmp', 'outside-'));
    fs.writeFileSync(path.join(secret, 's.txt'), 'SECRET');
    const repo = path.join(root, 'work', 'r');
    fs.mkdirSync(repo, { recursive: true });
    const home = path.join(root, 'homes', 'h');
    fs.mkdirSync(home, { recursive: true });
    const deny = denyList(root);
    assert.ok(deny.some((d) => fs.realpathSync(secret).startsWith(`${d}/`)));
    const r = spawnSync(APP_BIN, ['sandbox', ...sealedProfile({ repo, deny, writable: [home] }), '--', '/bin/sh', '-c',
      `exec 2>&1; cat ${secret}/s.txt; echo ---; ls ${os.homedir()}; echo ---; echo ok > ${repo}/w.txt && cat ${repo}/w.txt; echo ---; echo no > ${root}/x.txt`],
    { cwd: repo, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home, TMPDIR: path.join(root, 'tmp') } });
    const parts = r.stdout.split('---');
    assert.ok(!r.stdout.includes('SECRET'), r.stdout);
    assert.match(parts[0], /Operation not permitted/);
    assert.match(parts[1], /Operation not permitted/);
    assert.match(parts[2], /ok/);
    assert.match(parts[3], /Operation not permitted/, 'the root itself is not writable');
    fs.rmSync(secret, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pathsInCommand finds absolute and ~ paths in shell commands', () => {
  assert.deepEqual(pathsInCommand('cat /Users/x/notes/a.md && ls ~/.claude; echo "$HOME"'), ['/Users/x/notes/a.md', '~/.claude']);
  assert.deepEqual(pathsInCommand('python3 tests/test_task.py'), []);
  assert.deepEqual(pathsInCommand("bash -lc 'cat /etc/hosts'"), ['/etc/hosts']);
});

test('allowedPath: the root, ~ and system locations are fine; other homes and temp folders are not', () => {
  const roots = ['/private/tmp/sealed-ab-x', '/tmp/sealed-ab-x'];
  for (const p of ['/private/tmp/sealed-ab-x/work/r/solution.py', '/tmp/sealed-ab-x', '~/.zshrc', '/usr/bin/python3', '/dev/null', 'tests/x.py'])
    assert.ok(allowedPath(p, { roots }), p);
  for (const p of ['/Users/me/notes', '/private/tmp/other', '/var/folders/w_/x', '/Volumes/disk', '~root/x'])
    assert.ok(!allowedPath(p, { roots }), p);
});

test('auditRun reads Claude and Codex transcripts: outside paths, the host home and canaries', () => {
  const d = tmp('audit-');
  const claude = path.join(d, 'claude.jsonl');
  fs.writeFileSync(claude, [
    { type: 'system', subtype: 'init', cwd: '/private/tmp/sealed-ab-x/work/r' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/Users/owner/.claude/CLAUDE.md' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat /private/tmp/sealed-ab-x/work/r/solution.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'cat: /Users/owner/x: Operation not permitted' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'QUILLFERN' }] } },
  ].map((o) => JSON.stringify(o)).join('\n'));
  const a = auditRun({ files: [claude, path.join(d, 'missing')], roots: ['/private/tmp/sealed-ab-x'], canaries: ['QUILLFERN', 'NOTHERE'], hostHome: '/Users/owner' });
  assert.equal(a.tool_calls, 2);
  assert.deepEqual(a.outside.map((o) => o.path), ['/Users/owner/.claude/CLAUDE.md']);
  assert.equal(a.host_home, 2);
  assert.deepEqual(a.canaries, { QUILLFERN: 1 });
  assert.equal(a.denied, 1);
  assert.equal(a.breach, true);

  const codex = path.join(d, 'codex.jsonl');
  const session = path.join(d, 'session.jsonl');
  fs.writeFileSync(codex, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: "/bin/zsh -lc 'ls /Volumes'" } }));
  fs.writeFileSync(session, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat solution.py'], workdir: '/private/tmp/sealed-ab-x/work/r' }) } }));
  const b = auditRun({ files: [codex, session], roots: ['/private/tmp/sealed-ab-x'], hostHome: '/Users/owner' });
  assert.deepEqual(b.outside.map((o) => o.path), ['/Volumes']);
  assert.equal(b.host_home, 0);
  assert.equal(b.breach, false);
  assert.equal(toolCalls('not json\n{}').length, 0);
});

test('strayInstructions finds instruction files above a folder and managed-settings folders', () => {
  const t = tree();
  fs.writeFileSync(path.join(t, 'top', 'CLAUDE.md'), 'x');
  const managed = path.join(t, 'managed');
  fs.mkdirSync(managed);
  const found = strayInstructions(path.join(t, 'top/b/inner/root'), { managed: [managed, '/no/such'] });
  assert.ok(found.includes(path.join(t, 'top', 'CLAUDE.md')));
  assert.ok(found.includes(managed));
});

const counted = (extra) => runBatch({
  eval: 'E1a', arms: ['plain'], taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK, timeoutS: 60,
  batch: `seal-${Math.random().toString(36).slice(2)}`, phase: 'counted', results: tmp('e1res-'), harnessStatus: () => '',
  prereg: path.join(FIX, 'prereg_registered.md'), canaries: path.join(FIX, 'canaries_pass.py'), ...extra,
});

test('--phase counted is refused when the seal is off, or with concurrency > 1', async () => {
  const bin = path.join(tmp(), 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\necho "codex-cli 0.0.0"\n', { mode: 0o755 });
  await assert.rejects(counted({ agents: ['codex'], agentOptions: { codex: { bin } }, seal: 'off', box: 'off' }), (e) => e instanceof Refusal && /in the box|must run sealed/.test(e.message));
  await assert.rejects(counted({ agents: ['codex'], agentOptions: { codex: { bin } }, box: 'off' }), (e) => e instanceof Refusal && /in the box/.test(e.message), 'counted real agents need the box');
  await assert.rejects(counted({ agents: ['codex'], agentOptions: { codex: { bin } }, box: 'off', concurrency: 2 }), (e) => e instanceof Refusal && /concurrency must be 1/.test(e.message));
});

test('a sealed batch with real agents is refused when a CLI would load instructions from outside the seal', async () => {
  const parent = tmp('sealparent-');
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), 'stray');
  const bin = path.join(tmp(), 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\necho "codex-cli 0.0.0"\n', { mode: 0o755 });
  await assert.rejects(runBatch({
    eval: 'E1a', agents: ['codex'], agentOptions: { codex: { bin } }, arms: ['plain'], taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK,
    timeoutS: 60, batch: 'stray', phase: 'pilot', results: tmp('e1res-'), canaries: path.join(FIX, 'canaries_pass.py'), sealParent: parent, managedLocations: [], box: 'off',
  }), (e) => e instanceof Refusal && /CLAUDE\.md/.test(e.message));
  assert.deepEqual(fs.readdirSync(parent), ['CLAUDE.md'], 'the refused seal root was removed');
});

test('a fake-agent batch records a seal audit for every run', async () => {
  const res = await runBatch({
    eval: 'E1a', agents: [fake('honest')], arms: ['plain', 'pocp-ci'], taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK,
    timeoutS: 60, batch: 'audit', phase: 'pilot', results: tmp('e1res-'), canaries: path.join(FIX, 'canaries_pass.py'),
  });
  assert.equal(res.records.length, 2);
  for (const r of res.records) {
    assert.equal(typeof r.outcome.seal_audit?.tool_calls, 'number');
    assert.equal(r.outcome.seal_breach, false);
  }
});

test('auditRun: a sandbox that refuses to start commands, and the owner\'s login name, are reported', () => {
  const d = tmp('audit2-');
  const f = path.join(d, 't.jsonl');
  const user = os.userInfo().username;
  fs.writeFileSync(f, [
    { type: 'user', message: { content: [{ type: 'tool_result', content: "E2BIG: argument list too long, posix_spawn '/bin/zsh'" }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Exit code 1\nhello\nzsh:1: operation not permitted: /tmp/claude-501/cwd-3bf3' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: `deny ${user}` }] } },
  ].map((o) => JSON.stringify(o)).join('\n'));
  const a = auditRun({ files: [f], roots: ['/private/var/tmp/sealed-ab-x'], hostHome: '/nonexistent-home' });
  assert.equal(a.sandbox_broken, 2, 'E2BIG and a refused cwd file both count');
  assert.equal(a.denied, 1, 'lower-case refusals are counted');
  if (user.length >= 6) {
    assert.equal(a.host_user, 1);
    assert.equal(a.breach, false, 'the login name alone is reported, not a breach (ls -l shows it)');
  }
});

test('a pocp-ci repo names neither the owner nor the harness checkout, and says nothing about an evaluation', async () => {
  const { materialize, pocpCopy } = await import('../materialize.js');
  const { loadTasks, frozenFile } = await import('../lib/tasks.js');
  const { POCP_ROOT } = await import('../lib/proc.js');
  const { forbiddenStrings } = await import('../lib/seal.js');
  const { createSealRoot } = await import('../lib/seal.js');
  const { removeTree } = await import('../lib/proc.js');
  const root = createSealRoot();
  const parent = path.join(root, 'work');
  const copy = pocpCopy(path.join(parent, 'tools'));
  const task = loadTasks(frozenFile('conflicting', FROZEN))[0];
  const m = await materialize({ task, condition: 'E1a', arm: 'pocp-ci', parent, agentBin: copy.bin });
  const user = os.userInfo().username;
  const bad = [...forbiddenStrings([POCP_ROOT]), 'eval', 'Eval', 'EVAL', 'benchmark', 'harness'];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'objects' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const hits = [];
  for (const f of walk(m.repo).filter((x) => !x.endsWith('.sample'))) {
    // POCP's public repo slug is in its own hook text (the install hint): not a host leak.
    const t = fs.readFileSync(f, 'utf8').split(`${user}/pocp`).join('');
    for (const b of bad) if (t.includes(b)) hits.push(`${path.relative(m.repo, f)}: ${b}`);
  }
  assert.deepEqual(hits, []);
  assert.ok(fs.readFileSync(path.join(m.repo, '.git', 'hooks', 'pre-commit'), 'utf8').includes(copy.bin), 'the hooks fall back to the agent\'s copy');
  const log = spawnSync('git', ['log', '--format=%an %ae %s'], { cwd: m.repo, encoding: 'utf8' }).stdout.trim();
  assert.equal(log, 'Developer dev@localhost.invalid Initial commit');
  removeTree(root);
});

test('nextAttempt: a plain harness error is re-run exactly once; limits and login failures up to twice', async () => {
  const { nextAttempt, unitRunId } = await import('../run.js');
  const parts = { batch: 'b', eval: 'E1a', split: 'conflicting', task: 't', agent: 'claude', arm: 'plain', seed: 1 };
  const rec = (rerun, extra) => [unitRunId(parts, rerun), { run_id: unitRunId(parts, rerun), ...extra }];
  assert.deepEqual(nextAttempt(parts, new Map([rec(0, { status: 'harness-error', outcome: {} })])), { rerun: 1, supersedes: unitRunId(parts, 0) });
  assert.equal(nextAttempt(parts, new Map([rec(0, { status: 'harness-error', outcome: {} }), rec(1, { status: 'harness-error', outcome: {} })])), null);
  assert.equal(nextAttempt(parts, new Map([rec(0, { status: 'completed', outcome: {} })])), null);
  const lim = { status: 'harness-error', outcome: { infra: 'auth-failure' } };
  assert.equal(nextAttempt(parts, new Map([rec(0, lim), rec(1, lim)])).rerun, 2);
  assert.equal(nextAttempt(parts, new Map([rec(0, lim), rec(1, lim), rec(2, lim)])), null);
});

test('a void batch is refused on resume and reported as invalid', async () => {
  const { applyVoid } = await import('../report.js');
  const results = tmp('e1res-');
  fs.mkdirSync(path.join(results, 'runs', 'vb'), { recursive: true });
  fs.writeFileSync(path.join(results, 'runs', 'vb', 'batch.json'), JSON.stringify({ batch: 'vb', eval: 'E1a', starts: [], void: { kind: 'seal-breach', reason: 'x', at: 't' } }));
  await assert.rejects(runBatch({
    eval: 'E1a', agents: [fake('honest')], arms: ['plain'], taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK,
    timeoutS: 60, batch: 'vb', phase: 'pilot', results, canaries: path.join(FIX, 'canaries_pass.py'),
  }), (e) => e instanceof Refusal && /void/.test(e.message));
  const [r] = applyVoid(results, [{ batch: 'vb', phase: 'counted', run_id: 'x' }]);
  assert.equal(r.phase, 'invalid');
  assert.match(r.invalid_reason, /seal-breach/);
});
