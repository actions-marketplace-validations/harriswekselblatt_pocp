#!/usr/bin/env node
// PreToolUse hook for Claude's Bash tool, in repositories that use POCP (.proof/rules.json).
// It refuses the commands that go around POCP rather than through it, and says what to do
// instead. It guards against an agent cutting corners, not one set on hiding what it does: a
// command built at run time (eval, a script file, a variable) isn't read.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RULES = {
  noVerify: {
    why: '`git commit --no-verify` skips POCP\'s gate, and CI then fails the commit as uncovered.',
    instead: 'Run `pocp fix --intent "<what the change does>"`, then commit normally.',
  },
  hooksPath: {
    why: 'Changing core.hooksPath turns off POCP\'s git hooks.',
    instead: 'Commit through the hooks: `pocp fix --intent "<what the change does>"`, then `git commit`.',
  },
  force: {
    why: 'A force-push rewrites proven commits, which invalidates their proofs.',
    instead: 'Push new commits on top. To bring in the base branch, merge it rather than rebasing.',
  },
  label: {
    why: 'POCP approval labels are a person\'s decision; an agent adding one approves its own change.',
    instead: 'Push the change and tell the user which label it needs and why. They add it.',
  },
  approve: {
    why: '`pocp approve` is for a person at a terminal, not an agent.',
    instead: 'Run `pocp approvals` to list what is waiting, and ask the user to approve.',
  },
  accept: {
    why: 'The --accept-* flags record a maintainer\'s approval; an agent passing them approves its own change.',
    instead: 'Run verify without them and report what it says is waiting for a person.',
  },
  admin: {
    why: '`gh pr merge --admin` merges past the required checks, POCP\'s included.',
    instead: 'Use `gh pr merge --auto` so it merges once the checks pass.',
  },
  uninstall: {
    why: 'Uninstalling POCP\'s hooks turns off its gate.',
    instead: 'Leave the hooks in place; ask the user if they want them removed.',
  },
  // Switches on GitHub's side that take effect at once, with no pull request for anyone to review:
  // a workflow disabled while billing blocks it stays disabled, and its checks silently stop.
  local: {
    why: 'Switching to local mode turns off POCP\'s checks on GitHub at once, with no pull request to review.',
    instead: 'Ask the user to run it themselves if they want local mode.',
  },
  workflow: {
    why: 'Disabling a GitHub workflow stops its checks at once, with no pull request to review, and it stays off after the cause is fixed.',
    instead: 'Tell the user which workflows fail and why, and ask them to run the command themselves (`pocp doctor` lists them).',
  },
};

// Splits a shell command into simple commands (split at ; & | && || newlines and parentheses),
// each a list of words with their quotes removed. The commands inside $(…), `…` and <(…) become
// commands of their own; heredoc bodies and redirection targets are dropped, as they are data.
function parse(src) {
  const commands = [];
  const heredocs = [];
  let i = 0;
  const readUntil = (stop) => { list(stop); return '$()'; };
  function dquote() {
    let s = '';
    while (i < src.length && src[i] !== '"') {
      const c = src[i];
      if (c === '\\') { if (src[i + 1] !== '\n') s += '"\\$`'.includes(src[i + 1]) ? src[i + 1] : c + (src[i + 1] ?? ''); i += 2; }
      else if (c === '$' && src[i + 1] === '(') { i += 2; s += readUntil(')'); }
      else if (c === '`') { i++; s += readUntil('`'); }
      else { s += c; i++; }
    }
    i++;
    return s;
  }
  function list(stop) {
    let words = [];
    let word = null;
    let redirect = false;
    let depth = 0;
    const add = (s) => { word = (word ?? '') + s; };
    const endWord = () => {
      if (word !== null) { if (redirect) redirect = false; else words.push(word); }
      word = null;
    };
    const endCommand = () => {
      endWord();
      redirect = false;
      if (words.length) commands.push(words);
      words = [];
    };
    while (i < src.length) {
      const c = src[i];
      if (c === stop && !(stop === ')' && depth > 0)) { i++; break; }
      if (c === '\\') { if (src[i + 1] !== '\n') add(src[i + 1] ?? ''); i += 2; }
      else if (c === "'") { const j = src.indexOf("'", i + 1); const end = j < 0 ? src.length : j; add(src.slice(i + 1, end)); i = end + 1; }
      else if (c === '"') { i++; add(dquote()); }
      else if (c === '$' && src[i + 1] === '(') { i += 2; add(readUntil(')')); }
      else if (c === '`') { i++; add(readUntil('`')); }
      else if ((c === '<' || c === '>') && src[i + 1] === '(') { i += 2; add(readUntil(')')); }
      else if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; }
      else if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; }
      else if (c === '\n') {
        endCommand();
        i++;
        while (heredocs.length) {
          const { delim, tabs } = heredocs.shift();
          while (i < src.length) {
            const nl = src.indexOf('\n', i);
            const line = src.slice(i, nl < 0 ? src.length : nl);
            i = nl < 0 ? src.length : nl + 1;
            if ((tabs ? line.replace(/^\t+/, '') : line) === delim) break;
          }
        }
      } else if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
        if (word !== null && /^\d+$/.test(word)) word = null;
        else endWord();
        if (c === '&') i++;
        if (src.startsWith('<<', i) && src[i + 2] !== '<') {
          i += 2;
          const tabs = src[i] === '-';
          if (tabs) i++;
          while (src[i] === ' ' || src[i] === '\t') i++;
          let delim = '';
          while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
            const q = src[i];
            if (q === "'" || q === '"') { const j = src.indexOf(q, i + 1); const end = j < 0 ? src.length : j; delim += src.slice(i + 1, end); i = end + 1; }
            else if (q === '\\') { delim += src[i + 1] ?? ''; i += 2; }
            else { delim += q; i++; }
          }
          heredocs.push({ delim, tabs });
          continue;
        }
        while (src[i] === '<' || src[i] === '>') i++;
        if (src[i] === '&') {
          i++;
          if (/[\d-]/.test(src[i] ?? '')) { while (/[\d-]/.test(src[i] ?? '')) i++; continue; }
        } else if (src[i] === '|') i++;
        redirect = true;
      } else if (c === '(' || c === ')') {
        if (stop === ')') depth += c === '(' ? 1 : -1;
        endCommand();
        i++;
      } else if (c === ';' || c === '&' || c === '|') { endCommand(); i++; }
      else { add(c); i++; }
    }
    endCommand();
  }
  while (i < src.length) list(null);
  return commands;
}

const base = (w) => w.split('/').pop();
const isPocp = (w) => /^(pocp|proof-of-change)(@[^/]*)?$/.test(base(w)) || /^pocp\.[cm]?js$/.test(base(w));
const HOOKS_PATH = /^core\.hookspath$/i;
// Words that can come before the command itself: `sudo git …`, `then cd …`.
const PREFIX = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'command', 'builtin', 'exec', 'nohup', 'sudo']);

// git's options before its subcommand, the -C folders and -c settings among them.
function gitCall(words, at) {
  const dirs = [];
  const configs = [];
  let i = at + 1;
  while (i < words.length) {
    const w = words[i];
    if (w === '-C') { dirs.push(words[i + 1] ?? '.'); i += 2; }
    else if (w === '-c' || w === '--config-env') { configs.push(words[i + 1] ?? ''); i += 2; }
    else if (w.startsWith('--config-env=')) { configs.push(w.slice(13)); i++; }
    else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix'].includes(w)) i += 2;
    else if (w.startsWith('-')) i++;
    else break;
  }
  return { dirs, configs, sub: words[i], args: words.slice(i + 1) };
}

const COMMIT_VALUE = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file']);
function commitNoVerify(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (/^--no-veri(fy?)?$/.test(a)) return true;
      if (COMMIT_VALUE.has(a)) i++;
    } else if (a.startsWith('-')) {
      // A cluster such as -anm: -n is --no-verify; after -m, -F, -C, -c or -t the rest is its value.
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'n') return true;
        if ('mFCct'.includes(a[k])) { if (k === a.length - 1) i++; break; }
        if ('Su'.includes(a[k])) break;
      }
    }
  }
  return false;
}

const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
function pushForce(args) {
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === '--') { options = false; continue; }
    if (options && a.startsWith('--')) {
      if (a.startsWith('--force')) return true;
      if (PUSH_VALUE.has(a)) i++;
    } else if (options && a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'f') return true;
        if (a[k] === 'o') { if (k === a.length - 1) i++; break; }
      }
    } else if (a.startsWith('+')) return true;
  }
  return false;
}

// `git config` that writes or removes core.hooksPath; reading it is fine.
const CONFIG_READ = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--get-color', '--get-colorbool']);
const CONFIG_WRITE = new Set(['--unset', '--unset-all', '--add', '--replace-all']);
const CONFIG_VALUE = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
function configWritesHooksPath(args) {
  const pos = [];
  let read = false;
  let write = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (CONFIG_READ.has(a)) read = true;
    else if (CONFIG_WRITE.has(a)) write = true;
    else if (CONFIG_VALUE.has(a)) i++;
    else if (!a.startsWith('-')) pos.push(a);
  }
  if (pos[0] === 'set' || pos[0] === 'unset') return HOOKS_PATH.test(pos[1] ?? '');
  if (!HOOKS_PATH.test(pos[0] ?? '')) return false;
  return write || (!read && pos.length >= 2);
}

// The value of a label flag of `gh pr|issue create|edit`, for each one given.
const GH_VALUE = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '-B', '--base', '-H', '--head', '-a', '--assignee', '--add-assignee', '--remove-assignee', '-m', '--milestone', '-p', '--project', '--add-project', '--remove-project', '-r', '--reviewer', '--add-reviewer', '--remove-reviewer', '--remove-label', '-T', '--template']);
function labelsAdded(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l' || a === '--label' || a === '--add-label') out.push(args[++i] ?? '');
    else if (GH_VALUE.has(a)) i++;
    else {
      const m = /^(?:--label=|--add-label=|-l)(\S+)$/.exec(a);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

function ghApi(args) {
  let method = null;
  let fields = false;
  let input = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') method = args[++i] ?? '';
    else if (a.startsWith('--method=')) method = a.slice(9);
    else if (/^-X./.test(a)) method = a.slice(2);
    else if (['-f', '-F', '--field', '--raw-field'].includes(a)) { fields = true; i++; }
    else if (/^(-[fF].|--field=|--raw-field=)/.test(a)) fields = true;
    else if (a === '--input' || a.startsWith('--input=')) { fields = true; input = true; }
  }
  method = (method || (fields ? 'POST' : 'GET')).toUpperCase();
  return { write: ['POST', 'PUT', 'PATCH'].includes(method), input };
}

// The rules one simple command breaks, each with the folder it acts on.
function check(words, dir, raw) {
  const hits = [];
  const hit = (rule, at = dir) => hits.push({ rule, dir: at });
  for (const w of words) {
    if (/^GIT_CONFIG\w*=.*core\.hookspath/i.test(w)) hit('hooksPath');
    if (/^--accept-(test-change|policy-change|uncovered|inconclusive)(=|$)/.test(w)) hit('accept');
    if (/^--disable-billing-failed(=|$)/.test(w)) hit('workflow');
  }
  const approvals = words.indexOf('approvals');
  if (approvals >= 0 && words.slice(approvals + 1).some((w) => /^--approve(=|$)/.test(w))) hit('approve');

  const g = words.findIndex((w) => base(w) === 'git');
  if (g >= 0) {
    const { dirs, configs, sub, args } = gitCall(words, g);
    const at = dirs.reduce((d, c) => resolveDir(d, c) ?? d, dir);
    if (configs.some((c) => /^core\.hookspath(=|$)/i.test(c))) hit('hooksPath', at);
    if (sub === 'config' && configWritesHooksPath(args)) hit('hooksPath', at);
    if (sub === 'commit' && commitNoVerify(args)) hit('noVerify', at);
    if (sub === 'push' && pushForce(args)) hit('force', at);
  }

  const h = words.findIndex((w) => base(w) === 'gh');
  if (h >= 0) {
    const args = words.slice(h + 1);
    const pos = [];
    for (let i = 0; i < args.length && pos.length < 2; i++) {
      if (['-R', '--repo', '--hostname'].includes(args[i])) i++;
      else if (!args[i].startsWith('-')) pos.push(args[i]);
    }
    const [group, action] = pos;
    if ((group === 'pr' || group === 'issue') && ['create', 'new', 'edit'].includes(action)
      && labelsAdded(args).some((v) => v.includes('pocp-approve-'))) hit('label');
    if (group === 'pr' && action === 'merge' && args.includes('--admin')) hit('admin');
    if (group === 'workflow' && action === 'disable') hit('workflow');
    if (group === 'api') {
      const { write, input } = ghApi(args);
      // A write that adds labels: a labels field naming one, or a labels endpoint given one.
      const approval = (a) => a.includes('pocp-approve-');
      if (write && (args.some((a) => /^labels(\[\])?=/.test(a) && approval(a))
        || (args.some((a) => /\/labels\b/.test(a)) && (args.some(approval) || (input && approval(raw)))))) hit('label');
      if (args.some((a) => /actions\/workflows\/[^\s]+\/disable$/.test(a))) hit('workflow');
    }
  }

  const p = words.findIndex(isPocp);
  if (p >= 0) {
    let args = words.slice(p + 1);
    while (args.length && (args[0] === '--' || isPocp(args[0]))) args = args.slice(1);
    const pos = args.filter((a) => !a.startsWith('-'));
    // Options may come before the subcommand, some with a value: `pocp --repo o/r ci off`.
    const pair = (a, b) => pos.some((w, k) => w === a && pos[k + 1] === b);
    if (pos.slice(0, 2).includes('approve')) hit('approve');
    if (pair('hooks', 'uninstall')) hit('uninstall');
    if (pair('ci', 'off')) hit('local');
    if (pos.slice(0, 2).includes('init') && args.includes('--local')) hit('local');
  }
  return hits;
}

// The folder `cd <target>` moves to from `dir`, or null when it can't be known before running.
function resolveDir(dir, target) {
  if (target === '-' || /[$`*?]/.test(target)) return null;
  if (target === '~' || target.startsWith('~/')) return path.join(os.homedir(), target.slice(1));
  if (target.startsWith('~')) return null;
  return path.resolve(dir, target);
}

// Whether `dir` (or, if it doesn't exist yet, its nearest existing parent) is in a POCP repository.
const pocpRepos = new Map();
function usesPocp(dir) {
  let d = dir;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  if (!pocpRepos.has(d)) {
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: d, encoding: 'utf8' }).stdout?.trim();
    pocpRepos.set(d, Boolean(root) && fs.existsSync(path.join(root, '.proof', 'rules.json')));
  }
  return pocpRepos.get(d);
}

function decide(raw, cwd) {
  let dir = cwd;
  for (const words of parse(raw)) {
    const at = words.findIndex((w) => !/^\w+=/.test(w) && !PREFIX.has(w));
    if (words[at] === 'cd' || words[at] === 'pushd') {
      const target = words.slice(at + 1).find((w) => w === '-' || !w.startsWith('-'));
      dir = (target === undefined ? os.homedir() : resolveDir(dir, target)) ?? dir;
    }
    for (const { rule, dir: target } of check(words, dir, raw)) {
      if (usesPocp(cwd) || usesPocp(target)) return RULES[rule];
    }
  }
  return null;
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event = {};
try {
  event = JSON.parse(input || '{}');
} catch {
  process.exit(0);
}
if (event.tool_name !== 'Bash') process.exit(0);
const cwd = event.cwd || process.cwd();
let hit;
try {
  hit = decide(String(event.tool_input?.command || ''), cwd);
} catch {
  // A command this check can't read (nesting deep enough to exhaust the stack) is refused in a
  // POCP repository rather than let through unread.
  hit = usesPocp(cwd) ? { why: 'this command is nested too deeply for the plugin\'s check to read.', instead: 'Split it into simpler commands.' } : null;
}
if (hit) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `POCP: ${hit.why} ${hit.instead}`,
    },
  }));
}
process.exit(0);
