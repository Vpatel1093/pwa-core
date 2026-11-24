import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../../app/core/clock.js';
import {
  makeEvent, validateEnvelope, createEventChecks, maxTs, MAX_EVENT_BYTES, MAX_DEPTH,
} from '../../app/core/events.js';
import { uuidv7Time } from '../../app/core/uuid.js';
import { readFileSync } from 'node:fs';

const ctx = (t = 1000, extra = {}) => ({
  clock: createClock({ now: () => t }),
  deviceId: 'dev-a',
  appVersion: '0.1.0',
  tz: 'America/Chicago',
  now: () => t,
  ...extra,
});

test('makeEvent fills in every envelope field', () => {
  const e = makeEvent(ctx(1234), { type: 'x.test', scope_id: 'trip1', data: { a: 1 } });
  assert.equal(e.v, 1);
  assert.equal(e.type, 'x.test');
  assert.equal(e.scope_id, 'trip1');
  assert.equal(e.ts, 1234);
  assert.equal(e.tz, 'America/Chicago');
  assert.equal(e.device_id, 'dev-a');
  assert.equal(e.app_version, '0.1.0');
  assert.deepEqual(e.data, { a: 1 });
  assert.equal(uuidv7Time(e.id), 1234);
  assert.equal(validateEnvelope(e), null);
});

test('makeEvent leaves scope_id out when there is none', () => {
  const e = makeEvent(ctx(), { type: 'settings.set', data: {} });
  assert.ok(!('scope_id' in e));
  assert.equal(validateEnvelope(e), null);
});

test('makeEvent puts app fields at the top level, after scope_id and before ts', () => {
  const e = makeEvent(ctx(1234), { type: 'tick.set', scope_id: 'c1', fields: { chart_id: 'c1', cell_id: 'a1', day: '2026-11-23' }, data: { count: 1 } });
  assert.deepEqual(Object.keys(e), ['id', 'v', 'type', 'scope_id', 'chart_id', 'cell_id', 'day', 'ts', 'tz', 'device_id', 'app_version', 'data']);
  assert.equal(validateEnvelope(e), null);
});

test('makeEvent leaves out app fields that are undefined', () => {
  const e = makeEvent(ctx(), { type: 'x', fields: { cell_id: undefined, day: '2026-11-23' } });
  assert.ok(!('cell_id' in e));
  assert.equal(e.day, '2026-11-23');
});

test('makeEvent refuses app fields that would replace an envelope field', () => {
  for (const name of ['id', 'v', 'type', 'scope_id', 'ts', 'tz', 'device_id', 'app_version', 'data']) {
    assert.throws(() => makeEvent(ctx(), { type: 'x', fields: { [name]: 'y' } }), new RegExp(name), name);
  }
});

// Pinned: an app that moves onto the core (Mandalart first) must keep
// writing events byte for byte as before, or its older installed copies
// and its stored log would disagree on the shape.
test('makeEvent output is pinned for a Mandalart-shaped tick', () => {
  const e = makeEvent(ctx(1763900000000), {
    type: 'tick.set', scope_id: 'c1', fields: { chart_id: 'c1', cell_id: 'p1a1', day: '2026-11-23' }, data: { count: 1 },
  });
  const { id, ...rest } = e;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(rest),
    '{"v":1,"type":"tick.set","scope_id":"c1","chart_id":"c1","cell_id":"p1a1","day":"2026-11-23",'
    + '"ts":1763900000000,"tz":"America/Chicago","device_id":"dev-a","app_version":"0.1.0","data":{"count":1}}');
});

test('makeEvent uses the app event version from ctx', () => {
  assert.equal(makeEvent(ctx(1000, { eventVersion: 3 }), { type: 'x' }).v, 3);
});

test('makeEvent advances the hybrid clock', () => {
  const c = ctx(1000);
  const a = makeEvent(c, { type: 'x' });
  const b = makeEvent(c, { type: 'x' });
  assert.ok(b.ts > a.ts);
});

test('makeEvent with `after` stamps past the event it replaces without moving the clock', () => {
  const c = ctx(1000);
  assert.equal(makeEvent(c, { type: 'x', after: 9e12 }).ts, 9e12 + 1);
  assert.equal(c.clock.last, 1000); // a far-future event doesn't drag the clock along
  assert.equal(makeEvent(c, { type: 'x', after: 5 }).ts, 1001);
});

test('makeEvent copies data so later changes to the caller object do not leak in', () => {
  const data = { list: [1] };
  const e = makeEvent(ctx(), { type: 'x', data });
  data.list.push(2);
  assert.deepEqual(e.data, { list: [1] });
});

test('validateEnvelope rejects broken envelopes', () => {
  const good = makeEvent(ctx(), { type: 'x', scope_id: 's1' });
  const broken = [
    null,
    'str',
    [],
    { ...good, id: '' },
    { ...good, id: 5 },
    { ...good, v: '1' },
    { ...good, v: 0 },
    { ...good, type: '' },
    { ...good, scope_id: '' },
    { ...good, scope_id: 7 },
    { ...good, scope_id: 'x'.repeat(101) },
    { ...good, ts: '1000' },
    { ...good, ts: -1 },
    { ...good, device_id: '' },
    { ...good, data: [] },
    { ...good, data: null },
  ];
  for (const e of broken) assert.notEqual(validateEnvelope(e), null, JSON.stringify(e));
});

test('validateEnvelope refuses what the server would refuse', () => {
  const good = makeEvent(ctx(), { type: 'x', data: {} });
  const bad = [
    { ...good, id: 'x'.repeat(101) },
    { ...good, ts: 1.5 },
    { ...good, ts: 1e300 },
    { ...good, ts: NaN },
    { ...good, data: { note: '\ud800' } }, // half an emoji
    { ...good, data: { ['\udc00']: 1 } }, // in a key too
    { ...good, data: { note: 'x'.repeat(MAX_EVENT_BYTES) } },
  ];
  for (const e of bad) assert.notEqual(validateEnvelope(e), null, JSON.stringify(e).slice(0, 80));
  assert.equal(validateEnvelope({ ...good, data: { note: 'whole emoji \u{1F600} ok' } }), null);
});

const checks = createEventChecks({
  version: 2,
  bodies: {
    'note.added': (e) => (typeof e.data.text === 'string' ? null : 'data.text'),
    'trip.made': (e) => (e.scope_id ? null : 'scope_id'),
  },
});

test('createEventChecks runs the body check for a known type', () => {
  const c = ctx(1000, { eventVersion: 2 });
  assert.equal(checks(makeEvent(c, { type: 'note.added', data: { text: 'hi' } })), null);
  assert.equal(checks(makeEvent(c, { type: 'note.added', data: {} })), 'data.text');
  assert.equal(checks(makeEvent(c, { type: 'trip.made' })), 'scope_id', 'an app can require a scope');
});

test('createEventChecks checks the envelope first', () => {
  const e = makeEvent(ctx(1000, { eventVersion: 2 }), { type: 'note.added', data: { text: 'hi' } });
  assert.equal(checks({ ...e, device_id: '' }), 'device_id');
});

test('createEventChecks lets unknown types and future versions through', () => {
  // A newer app's events must still sync and import through this one.
  const c = ctx(1000, { eventVersion: 2 });
  assert.equal(checks(makeEvent(c, { type: 'target.set', data: { per_week: 3 } })), null);
  const future = makeEvent(ctx(1000, { eventVersion: 3 }), { type: 'note.added', data: {} });
  assert.equal(checks(future), null);
});

test('createEventChecks turns a throwing body check into a reason', () => {
  const strict = createEventChecks({ bodies: { boom: (e) => e.data.missing.deep } });
  assert.match(strict(makeEvent(ctx(), { type: 'boom' })) ?? '', /^boom: /);
});

test('maxTs finds the newest timestamp or 0', () => {
  assert.equal(maxTs([]), 0);
  assert.equal(maxTs([{ ts: 3 }, { ts: 9 }, { ts: 4 }]), 9);
});

// data nested so the whole event is `depth` containers deep (the event is 1, data is 2).
/** @param {number} depth */
function nested(depth) {
  /** @type {any} */
  let inner = {};
  // One level per step, some of them arrays; the outermost (data) stays an object.
  for (let i = 2; i < depth; i++) inner = i < depth - 1 && i % 2 ? [inner] : { x: inner };
  return { id: 'e1', v: 1, type: 't', ts: 1, device_id: 'd1', data: inner };
}

test('a deeply nested event gets a reason, not a stack overflow, so sync can skip it', () => {
  assert.equal(validateEnvelope(nested(MAX_DEPTH)), null);
  assert.equal(validateEnvelope(nested(MAX_DEPTH + 1)), 'depth');
  assert.equal(validateEnvelope(nested(20000)), 'depth');
  assert.equal(createEventChecks()(nested(20000)), 'depth');
});

test('a lone surrogate deep inside still counts', () => {
  const e = nested(MAX_DEPTH - 1);
  e.data.bad = ['ok', { ['\uD800']: 1 }];
  assert.equal(validateEnvelope(e), 'text');
});

// The same cases run against the server's check_event
// (server/pwacore/test_server.py): an event the server stores must never be
// one a device skips, or that device loses it for good when its pull cursor
// moves past it.
const CASES = JSON.parse(readFileSync(new URL('./envelope-cases.json', import.meta.url), 'utf8'));

/** @param {any} c */
function caseEvent(c) {
  if (c.whole) return c.event;
  /** @type {Record<string, any>} */
  const e = { ...CASES.base, ...c.event };
  for (const f of c.drop ?? []) delete e[f];
  if (c.nest) {
    let x = {};
    for (let i = 0; i < c.nest - 2; i++) x = { n: x };
    e.data = x;
  }
  if (c.pad) e.pad = 'x'.repeat(c.pad);
  return e;
}

test('validateEnvelope judges the shared cases as the server does', () => {
  assert.ok(CASES.cases.length > 40);
  for (const c of CASES.cases) {
    assert.equal(validateEnvelope(caseEvent(c)) === null, c.ok, c.name);
  }
});
