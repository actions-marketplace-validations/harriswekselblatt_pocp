import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv } from '../src/runner.js';

// Runs fn with these variables set in process.env (undefined removes one), then restores it.
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  for (const [k, v] of Object.entries(vars)) set(k, v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) set(k, v);
  }
}

// What `npx pocp verify` sees in a checkout whose .npmrc says node-options=--test-skip-pattern=add.
const npxFromCheckout = {
  npm_command: 'exec',
  npm_config_node_options: '--test-skip-pattern=add',
  NODE_OPTIONS: '--test-skip-pattern=add',
  npm_config_user_agent: 'npm/10.9.2 node/v22.13.1 darwin arm64',
  npm_config_script_shell: '/tmp/evil-shell',
};

test('under npx, checks get none of the config npm read from the checkout (.npmrc node-options, script-shell)', () => {
  withEnv(npxFromCheckout, () => {
    for (const env of [buildEnv({}), buildEnv({ mode: 'minimal', allow: ['NODE_OPTIONS', 'npm_config_script_shell'] })]) {
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.npm_config_node_options, undefined);
      assert.equal(env.npm_config_script_shell, undefined);
    }
  });
});

test("under npx, checks don't get the checkout's node_modules/.bin in front of PATH; the caller's PATH stays", () => {
  const caller = '/usr/local/bin:/opt/tools/node_modules/.bin:/usr/bin';
  const npx = `/home/u/.npm/_npx/abc/node_modules/.bin:/work/pr/node_modules/.bin:/work/node_modules/.bin:/node_modules/.bin:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:${caller}`;
  withEnv({ npm_command: 'exec', PATH: npx }, () => {
    assert.equal(buildEnv({}).PATH, caller);
    assert.equal(buildEnv({ mode: 'minimal' }).PATH, caller);
  });
  withEnv({ npm_command: undefined, PATH: npx }, () => {
    assert.equal(buildEnv({}).PATH, npx, 'not launched by npm: PATH is left alone');
  });
});

test('under pnpm exec, which sets NODE_OPTIONS from .npmrc without npm_config_node_options, it goes too', () => {
  withEnv({ npm_command: 'exec', npm_config_user_agent: 'pnpm/10.30.0 npm/? node/v22.13.1 darwin arm64', npm_config_node_options: undefined, NODE_OPTIONS: '--test-skip-pattern=add', NODE_PATH: '/work/pr/node_modules/.pnpm/node_modules', pnpm_config_verify_deps_before_run: 'false', PATH: './node_modules/.bin:/usr/bin' }, () => {
    const env = buildEnv({});
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_PATH, undefined);
    assert.equal(env.pnpm_config_verify_deps_before_run, undefined);
    assert.equal(env.PATH, '/usr/bin');
  });
});

test("under npx, the caller's own NODE_OPTIONS and NPM_CONFIG_* stay", () => {
  withEnv({ npm_command: 'exec', npm_config_user_agent: 'npm/10.9.2 node/v22.13.1 darwin arm64', npm_config_node_options: undefined, NODE_OPTIONS: '--max-old-space-size=4096', NPM_CONFIG_REGISTRY: 'https://registry.example/' }, () => {
    const env = buildEnv({});
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.example/');
  });
});

test('not launched by npm, npm_config_* the caller set stay', () => {
  withEnv({ npm_command: undefined, npm_config_registry: 'https://registry.example/', npm_config_node_options: '--x', NODE_OPTIONS: '--x' }, () => {
    const env = buildEnv({});
    assert.equal(env.npm_config_registry, 'https://registry.example/');
    assert.equal(env.NODE_OPTIONS, '--x');
  });
});
