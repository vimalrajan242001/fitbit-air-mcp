import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRecord, pickNumbers, readFinite, readInt } from '../src/parse.js';

test('readInt accepts safe integers and integer strings only', () => {
  assert.equal(readInt(42), 42);
  assert.equal(readInt('-7'), -7);
  assert.equal(readInt('0'), 0);
  assert.equal(readInt(1.5), undefined);
  assert.equal(readInt('1.5'), undefined);
  assert.equal(readInt('9007199254740993'), undefined);
  assert.equal(readInt(null), undefined);
});

test('readFinite accepts finite numbers and decimal strings only', () => {
  assert.equal(readFinite(2100.5), 2100.5);
  assert.equal(readFinite('42.25'), 42.25);
  assert.equal(readFinite(Number.NaN), undefined);
  assert.equal(readFinite(Number.POSITIVE_INFINITY), undefined);
  assert.equal(readFinite('1e3'), undefined);
  assert.equal(readFinite(''), undefined);
});

test('isRecord is true only for plain objects', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord('x'), false);
});

test('pickNumbers copies only the allowlisted, readable fields', () => {
  const source = { a: '3', b: '2.5', c: 7, secret: 1, d: 'x' };
  assert.deepEqual(pickNumbers(source, { ints: ['a', 'd'], numbers: ['b', 'c'] }), { a: 3, b: 2.5, c: 7 });
  assert.deepEqual(pickNumbers({}, { ints: ['a'], numbers: [] }), {});
});
