import test from 'node:test';
import assert from 'node:assert/strict';
import { both, isAdult, isNone } from '../src/bench/flags.js';

test('bench fixture: isAdult at the boundary', () => {
  assert.equal(isAdult(18), true);
});

test('bench fixture: isNone', () => {
  assert.equal(isNone(null), true);
});

test('bench fixture: both', () => {
  assert.equal(both(true, false), false);
});
