// The runtime is the wiring every app's main.js needs between the store,
// the clock, sync, and other tabs. It has no DOM, so it runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../app/core/memstore.js';
import { makeEvent } from '../app/core/events.js';
import { startRuntime } from '../app/core/runtime.js';
import { fakeServer } from './helpers/fake-server.js';

let channelCount = 0;

async function boot({ store = createMemoryStore(), srv = fakeServer(), t = { now: 1000 }, ...opts } = {}) {
  const seen = [];
  const statuses = [];
  const rt = await startRuntime({
    store,
    appVersion: '0.1.0',
    fetch: srv.fetch,
    now: () => t.now,
    tz: 'UTC',
    debounceMs: 60 * 1000, // tests call runSync themselves unless they say otherwise
    onEvents: (events, source) => seen.push({ source, ids: events.map((e) => e.id) }),
    onStatus: (s) => statuses.push({ ...s }),
    ...opts,
  });
  return { rt, store, srv, t, seen, statuses };
}

const note = (rt, text = 'hi') => makeEvent(rt.ctx(), { type: 'note.added', data: { text } });

test('a device id is made once and kept across restarts', async () => {
  const store = createMemoryStore();
  const first = await boot({ store });
  const second = await boot({ store });
  assert.ok(first.rt.deviceId);
  assert.equal(second.rt.deviceId, first.rt.deviceId);
  first.rt.close();
  second.rt.close();
});

test('ctx carries what makeEvent needs', async () => {
  const { rt } = await boot({ eventVersion: 2 });
  const ctx = rt.ctx();
  assert.equal(ctx.deviceId, rt.deviceId);
  assert.equal(ctx.appVersion, '0.1.0');
  assert.equal(ctx.eventVersion, 2);
  assert.equal(ctx.tz, 'UTC');
  assert.equal(ctx.clock, rt.clock);
  rt.close();
});

test('startup hands the stored events to the app', async () => {
  const store = createMemoryStore();
  const a = await boot({ store });
  const e = await a.rt.record(note(a.rt));
  a.rt.close();
  const b = await boot({ store });
  assert.deepEqual(b.seen, [{ source: 'load', ids: [e.id] }]);
  b.rt.close();
});

test('record stores an event, queues it for sync, and tells the app', async () => {
  const { rt, store, seen, statuses } = await boot();
  const e = await rt.record(note(rt));
  assert.deepEqual((await store.allEvents()).map((x) => x.id), [e.id]);
  assert.equal(await store.outboxCount(), 1);
  assert.deepEqual(seen.at(-1), { source: 'local', ids: [e.id] });
  assert.equal(statuses.at(-1).pending, 1);
  assert.equal(await store.getMeta('clockLast'), rt.clock.last);
  rt.close();
});

test('record refuses an event the server would refuse, and stores nothing', async () => {
  const { rt, store } = await boot();
  await assert.rejects(rt.record({ ...note(rt), device_id: '' }), /device_id/);
  assert.equal((await store.allEvents()).length, 0);
  rt.close();
});

test('records run one at a time, in the order they were asked for', async () => {
  const { rt, seen } = await boot();
  const a = note(rt, 'a');
  const b = note(rt, 'b');
  await Promise.all([rt.record(a), rt.record(b)]);
  assert.deepEqual(seen.filter((s) => s.source === 'local').map((s) => s.ids[0]), [a.id, b.id]);
  rt.close();
});

test('a failed record does not block the next one', async () => {
  const store = createMemoryStore();
  const real = store.addEvents.bind(store);
  let fail = true;
  store.addEvents = async (...args) => {
    if (fail) { fail = false; throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); }
    return real(...args);
  };
  const { rt } = await boot({ store });
  await assert.rejects(rt.record(note(rt)), { name: 'QuotaExceededError' });
  await rt.record(note(rt));
  assert.equal((await store.allEvents()).length, 1);
  rt.close();
});

test('the clock resumes past everything stored, even after a device clock jump back', async () => {
  const store = createMemoryStore();
  const t = { now: 50_000 };
  const a = await boot({ store, t });
  const e = await a.rt.record(note(a.rt));
  a.rt.close();
  t.now = 1000; // the device clock went back
  const b = await boot({ store, t });
  assert.ok(note(b.rt).ts > e.ts);
  b.rt.close();
});

test('runSync pushes, pulls, and reports ok', async () => {
  const srv = fakeServer();
  const a = await boot({ srv });
  const b = await boot({ srv });
  const e = await a.rt.record(note(a.rt));
  const sa = await a.rt.runSync();
  assert.equal(sa.status, 'ok');
  assert.equal(sa.pending, 0);
  assert.equal(sa.lastSyncAt, 1000);
  await b.rt.runSync();
  assert.deepEqual(b.seen.at(-1), { source: 'sync', ids: [e.id] });
  a.rt.close();
  b.rt.close();
});

test('runSync says offline when the server cannot be reached, and keeps the outbox', async () => {
  const srv = fakeServer();
  const { rt } = await boot({ srv });
  await rt.record(note(rt));
  srv.down = true;
  const s = await rt.runSync();
  assert.equal(s.status, 'offline');
  assert.equal(s.pending, 1);
  srv.down = false;
  assert.equal((await rt.runSync()).status, 'ok');
  rt.close();
});

test('runSync says error, with the reason, when the server answers with a failure', async () => {
  const fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'server error' }) });
  const { rt } = await boot({ fetch });
  await rt.record(note(rt));
  const s = await rt.runSync();
  assert.equal(s.status, 'error');
  assert.match(s.error, /HTTP 500: server error/);
  rt.close();
});

test('runSync({ manual: true }) shows that it is syncing while it runs', async () => {
  const { rt, statuses } = await boot();
  await rt.runSync({ manual: true });
  assert.ok(statuses.some((s) => s.manual === true));
  assert.equal(statuses.at(-1).manual, false);
  rt.close();
});

test('importEvents adds new events as local ones and skips what is already here', async () => {
  const other = await boot();
  const events = [await other.rt.record(note(other.rt, 'x')), await other.rt.record(note(other.rt, 'y'))];
  const { rt, store, seen } = await boot();
  const added = await rt.importEvents(events);
  assert.equal(added.length, 2);
  assert.equal(await store.outboxCount(), 2, 'imported events are pushed on next sync');
  assert.deepEqual(seen.at(-1), { source: 'import', ids: events.map((e) => e.id) });
  assert.equal((await rt.importEvents(events)).length, 0);
  assert.ok(note(rt).ts > Math.max(...events.map((e) => e.ts)), 'the clock moved past them');
  other.rt.close();
  rt.close();
});

test('a record schedules a sync after the debounce', async () => {
  const srv = fakeServer();
  const { rt } = await boot({ srv, debounceMs: 5 });
  await rt.record(note(rt));
  await rt.record(note(rt));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(srv.rows.length, 2);
  assert.equal(srv.posts, 1, 'a burst of records is one push');
  rt.close();
});

test('close cancels a scheduled sync', async () => {
  const srv = fakeServer();
  const { rt } = await boot({ srv, debounceMs: 5 });
  await rt.record(note(rt));
  rt.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(srv.posts, 0);
});

test('other tabs on the same device get recorded, synced, and imported events', async () => {
  const name = `rt-tabs-${++channelCount}`;
  const store = createMemoryStore(); // two tabs share one database
  const a = await boot({ store, channel: new BroadcastChannel(name) });
  const b = await boot({ store, channel: new BroadcastChannel(name) });
  const e = await a.rt.record(note(a.rt));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(b.seen.at(-1), { source: 'tab', ids: [e.id] });
  assert.ok(note(b.rt).ts > e.ts, 'the other tab\'s clock moved past it');
  a.rt.close();
  b.rt.close();
});
