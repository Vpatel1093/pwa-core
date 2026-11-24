import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, uuidv7Time } from '../../app/core/uuid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuidv7 has version 7 and RFC 9562 variant bits', () => {
  for (let i = 0; i < 100; i++) assert.match(uuidv7(), UUID_RE);
});

test('uuidv7 embeds the millisecond timestamp', () => {
  const ms = 1758650000123;
  assert.equal(uuidv7Time(uuidv7(ms)), ms);
});

test('uuidv7 sorts by time as a plain string', () => {
  const a = uuidv7(1000);
  const b = uuidv7(2000);
  assert.ok(a < b);
});

test('uuidv7 ids are unique', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(uuidv7(5));
  assert.equal(ids.size, 1000);
});

test('randomId makes short opaque ids with a prefix', async () => {
  const { randomId } = await import('../../app/core/uuid.js');
  const ids = new Set(Array.from({ length: 500 }, () => randomId('n')));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^n_[0-9a-z]{8}$/);
  assert.match(randomId('trip', 12), /^trip_[0-9a-z]{12}$/);
});
