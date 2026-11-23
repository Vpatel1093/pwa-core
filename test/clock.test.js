import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, MAX_SKEW_MS } from '../app/core/clock.js';

test('tick uses the device time when it is ahead', () => {
  const clock = createClock({ now: () => 1000 });
  assert.equal(clock.tick(), 1000);
});

test('tick never goes backwards when the device clock does', () => {
  let t = 1000;
  const clock = createClock({ now: () => t });
  assert.equal(clock.tick(), 1000);
  t = 500;
  assert.equal(clock.tick(), 1001);
  assert.equal(clock.tick(), 1002);
});

test('tick is strictly increasing within the same millisecond', () => {
  const clock = createClock({ now: () => 42 });
  assert.equal(clock.tick(), 42);
  assert.equal(clock.tick(), 43);
});

test('observe moves the clock past timestamps seen from other devices', () => {
  const clock = createClock({ now: () => 1000 });
  clock.observe(5000);
  assert.equal(clock.tick(), 5001);
});

test('observe ignores older timestamps', () => {
  const clock = createClock({ now: () => 1000, last: 2000 });
  clock.observe(10);
  assert.equal(clock.last, 2000);
  assert.equal(clock.tick(), 2001);
});

test('observe ignores timestamps far ahead of this device, so one bad clock cannot poison the rest', () => {
  const clock = createClock({ now: () => 1000 });
  clock.observe(1e300);
  clock.observe(2 ** 53);
  clock.observe(1000 + MAX_SKEW_MS + 1);
  assert.equal(clock.tick(), 1000);
  clock.observe(1000 + MAX_SKEW_MS);
  assert.equal(clock.tick(), 1001 + MAX_SKEW_MS);
});

test('a saved clock that is absurdly far ahead is dropped on load', () => {
  const clock = createClock({ now: () => 1000, last: 1e300 });
  assert.equal(clock.tick(), 1000);
});

test('observe ignores values that are not finite numbers', () => {
  const clock = createClock({ now: () => 1000 });
  clock.observe(NaN);
  clock.observe(undefined);
  clock.observe('9999');
  assert.equal(clock.tick(), 1000);
});
