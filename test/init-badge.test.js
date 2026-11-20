// pocp init offers a README badge once, on a first setup, at a terminal, defaulting to no.
// It is only printed for a person to paste: init never writes it into a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BADGE_MARKDOWN, BADGE_QUESTION, badgeInteractive, offerBadge } from '../src/badge.js';
import { pocp, tmpRepo, write } from './helpers.js';

// A person at a terminal whose answer is `answer`; records what was asked and said.
function terminal(answer) {
  const asked = [];
  const said = [];
  return {
    asked,
    said,
    io: {
      interactive: true,
      ask: async (q) => {
        asked.push(q);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      say: (line) => said.push(line),
    },
  };
}

test('the badge is a plain static shields.io badge linking to the POCP repository', () => {
  assert.equal(BADGE_MARKDOWN, '[![uses POCP](https://img.shields.io/badge/uses-POCP-lightgrey)](https://github.com/harriswekselblatt/pocp)');
  assert.doesNotMatch(BADGE_MARKDOWN, /logo|labelColor|style=/, 'no logo, no colours of its own');
});

test('interactive yes: asks once and prints the markdown to paste', async () => {
  for (const answer of ['y', 'Y', 'yes', ' YES ']) {
    const t = terminal(answer);
    assert.equal(await offerBadge(t.io), true, answer);
    assert.deepEqual(t.asked, [BADGE_QUESTION]);
    assert.match(t.said.join('\n'), /README/);
    assert.ok(t.said.join('\n').includes(BADGE_MARKDOWN));
  }
});

test('interactive default is no: Enter, anything but yes, or a closed terminal prints nothing', async () => {
  assert.match(BADGE_QUESTION, /\[y\/N\] $/, 'the question shows that no is the default');
  for (const answer of ['', '\n', 'n', 'no', 'sure', 'yy', new Error('closed')]) {
    const t = terminal(answer);
    assert.equal(await offerBadge(t.io), false, String(answer));
    assert.equal(t.asked.length, 1);
    assert.deepEqual(t.said, []);
  }
});

test('non-interactive: never asks', async () => {
  const t = terminal('y');
  assert.equal(await offerBadge({ ...t.io, interactive: false }), false);
  assert.deepEqual(t.asked, []);
  assert.deepEqual(t.said, []);
});

test('only a first setup, at a terminal, outside CI, without --json or --badge, is offered the badge', () => {
  const tty = { isTTY: true };
  const base = { json: false, flags: {}, configCreated: true, stdin: tty, stdout: tty, env: {} };
  assert.equal(badgeInteractive(base), true);
  assert.equal(badgeInteractive({ ...base, configCreated: false }), false, 're-running init asks nothing again');
  assert.equal(badgeInteractive({ ...base, json: true }), false);
  assert.equal(badgeInteractive({ ...base, flags: { badge: true } }), false, '--badge already answered');
  assert.equal(badgeInteractive({ ...base, stdin: {} }), false, 'stdin not a terminal');
  assert.equal(badgeInteractive({ ...base, stdout: {} }), false, 'stdout not a terminal');
  assert.equal(badgeInteractive({ ...base, env: { CI: 'true' } }), false);
});

test('pocp init without a terminal sets up without asking, and writes no badge anywhere', () => {
  const dir = tmpRepo();
  write(dir, 'README.md', '# x\n');
  const r = pocp(dir, ['init']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /badge|shields|\[y\/N\]/i);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# x\n');
});

test('pocp init --badge prints the badge, and --json carries it; README is untouched', () => {
  const dir = tmpRepo();
  write(dir, 'README.md', '# x\n');
  const r = pocp(dir, ['init', '--badge']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(BADGE_MARKDOWN), r.stdout);
  assert.doesNotMatch(r.stdout, /\[y\/N\]/);
  const j = pocp(dir, ['init', '--badge', '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.equal(j.json.badge, BADGE_MARKDOWN);
  assert.equal(pocp(dir, ['init', '--json']).json.badge, undefined, 'no badge unless asked for');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# x\n');
});
