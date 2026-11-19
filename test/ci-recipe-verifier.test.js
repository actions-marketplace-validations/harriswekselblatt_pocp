// The CI recipes users copy must load the verifier from outside the checkout. Run as `npx pocp`
// inside it, npx runs whatever pocp the change's package.json, .npmrc or node_modules supplies:
// a pull request that commits node_modules/.bin/pocp printing "verified" passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// The first fenced block after a heading or phrase.
const blockAfter = (text, marker) => text.slice(text.indexOf(marker)).match(/```[a-z]*\n([\s\S]*?)```/)[1];

test('every CI recipe installs the verifier outside the checkout and runs it with node', () => {
  const recipes = {
    'README.md': blockAfter(read('README.md'), '**On another CI**'),
    'docs/QUICKSTART.md': blockAfter(read('docs/QUICKSTART.md'), '### Another CI'),
    'examples/gitlab/.gitlab-ci.yml': read('examples/gitlab/.gitlab-ci.yml'),
    'examples/any-ci/pocp-ci.sh': read('examples/any-ci/pocp-ci.sh'),
  };
  for (const [file, text] of Object.entries(recipes)) {
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\bnpx\b/, `${file}: no npx`);
    assert.match(code, /npm install --prefix "\$HOME\/\.pocp"[^\n]*--ignore-scripts/, `${file}: installed outside the checkout`);
    assert.match(code, /node "\$HOME\/\.pocp\/node_modules\/proof-of-change\/bin\/pocp\.js"/, `${file}: run with node from there`);
  }
});
