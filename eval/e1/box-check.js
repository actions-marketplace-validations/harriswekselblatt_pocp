#!/usr/bin/env node
// What can an agent in the box see? A deterministic check, no model involved.
//
// Starts a container exactly as a POCP-arm agent run does (same image, network, mounts,
// environment; the agent's POCP copy mounted read-only), then runs a script inside it that:
//   - searches every readable file in the container for the given words (planted canaries)
//     and for the owner's home path and login name;
//   - lists the environment, mounts, hostname, user, and the folders a Mac would have;
//   - tries the network: an allowed API host through the proxy, a blocked host through it,
//     and direct connections to the internet and to the Mac (OrbStack's host names).
// Prints one JSON object; exit 0 when nothing leaks and the network is as designed.
//
//   node eval/e1/box-check.js --agent claude|codex [--words W1,W2] [--out file.json]
//
// --agent codex also gives the container a CODEX_HOME holding a copy of Codex's login, as a
// Codex run has it (the login file itself is never printed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BOX_NODE, BOX_PATH, PROXY_ENV, boxRun, copyLoginIn, ensureBox } from './lib/box.js';
import { POCP_ROOT, removeTree } from './lib/proc.js';
import { createSealRoot } from './lib/seal.js';
import { pocpCopy } from './materialize.js';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const words = (opt('--words') || '').split(',').filter(Boolean);
const user = os.userInfo().username;
const needles = [...words, os.homedir(), user, path.basename(POCP_ROOT) === 'pocp' ? null : POCP_ROOT].filter(Boolean);

const SCRIPT = String.raw`
set -u
out() { printf '%s\t%s\n' "$1" "$2"; }
for n in "$@"; do
  # POCP's public repository slug (<owner>/pocp) is in POCP's own source and hooks by design.
  hits=""
  for f in $(grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -F -i -- "$n" / 2>/dev/null | head -200); do
    # A home path (/Users/<owner>...) always counts; the bare repo slug <owner>/pocp doesn't.
    if sed -e "s#/Users/$n#HOME_PATH_LEAK#Ig" -e "s#$n/pocp##Ig" "$f" | grep -qiF -e "$n" -e HOME_PATH_LEAK; then hits="$hits $f"; fi
  done
  out "hit:$n" "$hits"
done
out env "$(env | sort | tr '\n' ' ')"
out id "$(id)"
out hostname "$(hostname)"
out mounts "$(grep -v ' /proc\| /sys\| /dev' /proc/self/mountinfo | awk '{print $5" "$6}' | tr '\n' ';')"
# /private exists only as the parent of the mounted run folder (/private/var/tmp/...): list what else is in it.
out mac_folders "$(ls -d /Users /Volumes /Applications /System /Library 2>/dev/null | tr '\n' ' ')"
out private_tree "$(find /private -maxdepth 4 2>/dev/null | tr '\n' ' ')"
out instructions "$(find / -xdev \( -name CLAUDE.md -o -name AGENTS.md -o -name AGENTS.override.md -o -name CLAUDE.local.md \) 2>/dev/null | grep -v node_modules | tr '\n' ' ')"
probe() { node -e "
const [u, proxy] = process.argv.slice(1);
const http = require('http'); const net = require('net');
const done = (r) => { console.log(r); process.exit(0); };
setTimeout(() => done('timeout'), 6000);
if (proxy) {
  const p = new URL(proxy); const t = new URL(u);
  const req = http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: t.hostname + ':443' });
  req.on('connect', (res) => done('connect ' + res.statusCode)); req.on('error', (e) => done('error ' + e.code)); req.end();
} else {
  const t = new URL(u); const s = net.connect({ host: t.hostname, port: t.port || 443 }, () => done('open')); s.on('error', (e) => done('error ' + e.code));
}" "$1" "$2"; }
out net_api_via_proxy "$(probe https://api.anthropic.com/ "$HTTPS_PROXY")"
out net_blocked_via_proxy "$(probe https://example.com/ "$HTTPS_PROXY")"
out net_direct_internet "$(probe https://example.com/ '')"
out net_direct_mac_orb "$(probe http://host.orb.internal:7331/ '')"
out net_direct_mac_docker "$(probe http://host.docker.internal:3000/ '')"
`;

const agent = opt('--agent') || 'claude';
const box = await ensureBox({ needCodexLogin: agent === 'codex' });
const root = createSealRoot();
const report = { agent, image_id: box.imageId, needles: needles.map((n) => (n === os.homedir() || n === user ? '<owner>' : n)) };
try {
  const copy = pocpCopy(path.join(root, 'work', 'tools'), { node: BOX_NODE });
  const top = fs.mkdtempSync(path.join(root, 'work', 'proj-'));
  fs.mkdirSync(path.join(top, 'repo'));
  const env = { ...PROXY_ENV, PATH: `${copy.binDir}:${BOX_PATH}`, POCP_BIN: `${BOX_NODE} ${copy.bin}`, GIT_CONFIG_GLOBAL: '/dev/null' };
  const mounts = [{ src: top }, { src: path.dirname(copy.root), ro: true }];
  if (agent === 'codex') {
    const home = fs.mkdtempSync(path.join(root, 'homes', 'codex-'));
    fs.mkdirSync(path.join(home, '.codex'));
    await copyLoginIn(box.image, path.join(home, '.codex'));
    mounts.push({ src: home });
    env.CODEX_HOME = path.join(home, '.codex');
  }
  const r = await boxRun({ image: box.image, network: box.net, mounts, env, workdir: path.join(top, 'repo'), cmd: ['sh', '-c', SCRIPT, 'check', ...needles], timeoutMs: 15 * 60_000, prefix: 'check' });
  const rows = Object.fromEntries(r.out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
  const leaks = needles.map((n, i) => ({ needle: report.needles[i], files: rows[`hit:${n}`] || '' })).filter((x) => x.files);
  Object.assign(report, {
    leaks,
    env: rows.env, id: rows.id, hostname: rows.hostname, mounts: rows.mounts, mac_folders: rows.mac_folders, private_tree: rows.private_tree, instruction_files: rows.instructions,
    network: { api_via_proxy: rows.net_api_via_proxy, blocked_via_proxy: rows.net_blocked_via_proxy, direct_internet: rows.net_direct_internet, direct_mac_orb: rows.net_direct_mac_orb, direct_mac_docker: rows.net_direct_mac_docker },
  });
  const netOk = /connect 200/.test(rows.net_api_via_proxy || '') && !/connect 200/.test(rows.net_blocked_via_proxy || '') && !/open/.test(rows.net_direct_internet || '') && !/open/.test(rows.net_direct_mac_orb || '') && !/open/.test(rows.net_direct_mac_docker || '');
  report.ok = leaks.length === 0 && !rows.mac_folders && !rows.instructions && netOk;
} finally {
  removeTree(root);
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (opt('--out')) fs.writeFileSync(opt('--out'), text);
process.stdout.write(text);
process.exit(report.ok ? 0 : 1);
