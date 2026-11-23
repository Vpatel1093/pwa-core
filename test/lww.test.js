import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, keepNewest } from '../app/core/lww.js';

const ev = (ts, device_id = 'd1', id = `e${ts}`) => ({ id, ts, device_id });

test('isNewer orders by ts, then device id, then event id', () => {
  assert.equal(isNewer(ev(2), ev(1)), true);
  assert.equal(isNewer(ev(1), ev(2)), false);
  assert.equal(isNewer(ev(1, 'b'), ev(1, 'a')), true);
  assert.equal(isNewer(ev(1, 'a', 'y'), ev(1, 'a', 'x')), true);
  assert.equal(isNewer(ev(1, 'a', 'x'), ev(1, 'a', 'x')), false, 'an event is not newer than itself');
});

test('keepNewest keeps the winner whatever order events arrive in', () => {
  const events = [ev(5, 'a'), ev(9, 'a'), ev(9, 'b'), ev(1, 'z')];
  const orders = [events, [...events].reverse(), [events[2], events[0], events[3], events[1]]];
  for (const order of orders) {
    const map = new Map();
    for (const e of order) keepNewest(map, 'k', e, e.device_id);
    assert.equal(map.get('k').value, 'b');
    assert.equal(map.get('k').id, events[2].id);
  }
});

test('keepNewest says whether it stored the event, and replays are no-ops', () => {
  const map = new Map();
  const a = ev(5);
  assert.equal(keepNewest(map, 'k', a, 1), true);
  assert.equal(keepNewest(map, 'k', a, 1), false);
  assert.equal(keepNewest(map, 'k', ev(4), 2), false);
  assert.equal(map.get('k').value, 1);
  assert.deepEqual(map.get('k'), { value: 1, ts: 5, device_id: 'd1', id: 'e5' });
});

test('keepNewest keeps separate keys apart', () => {
  const map = new Map();
  keepNewest(map, 'a', ev(1), 'x');
  keepNewest(map, 'b', ev(2), 'y');
  assert.equal(map.get('a').value, 'x');
  assert.equal(map.get('b').value, 'y');
});
