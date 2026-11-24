import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../../app/core/clock.js';
import { makeEvent, createEventChecks } from '../../app/core/events.js';
import { keepNewest } from '../../app/core/lww.js';
import { createMemoryStore } from '../../app/core/memstore.js';
import { createSync } from '../../app/core/sync.js';
import { fakeServer } from './helpers/fake-server.js';

// A stand-in app: `flag.set` turns a flag on or off for a key, newest wins.
const validateEvent = createEventChecks({
  bodies: { 'flag.set': (e) => (typeof e.data.key === 'string' && typeof e.data.on === 'boolean' ? null : 'data') },
});
/** @typedef {import('../../app/core/events.js').PwaEvent} PwaEvent */
/** @typedef {import('../../app/core/events.js').EventContext} EventContext */

/** @param {EventContext} ctx @param {string} key @param {boolean} on */
const flagSet = (ctx, key, on) => makeEvent(ctx, { type: 'flag.set', scope_id: 'ch', data: { key, on } });
/** @param {PwaEvent[]} events */
function buildFlags(events) {
  /** @type {Map<string, import('../../app/core/lww.js').Stamp & { value: boolean }>} */
  const flags = new Map();
  for (const e of events) if (e.type === 'flag.set' && validateEvent(e) === null) keepNewest(flags, e.data.key, e, e.data.on);
  return flags;
}
/** @param {ReturnType<typeof buildFlags>} flags @param {string} key */
const isOn = (flags, key) => flags.get(key)?.value === true;

/** @param {string} id @param {ReturnType<typeof fakeServer>} srv @param {string} [appId] */
function device(id, srv, appId) {
  let t = 1000;
  const clock = createClock({ now: () => t });
  const ctx = { clock, deviceId: id, appVersion: 'test', tz: 'UTC', now: () => t };
  const store = createMemoryStore();
  const sync = createSync({ store, clock, fetch: srv.fetch, now: () => t, appId });
  return {
    ctx, clock, store, sync,
    /** @param {number} ms */
    at(ms) { t = ms; return ctx; },
    /** @param {string} key */
    async tick(key, on = true) {
      const e = flagSet(ctx, key, on);
      await store.addEvents([e], { local: true });
      return e;
    },
    async state() { return buildFlags(await store.allEvents()); },
  };
}

test('local events are pushed and leave the outbox', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await a.tick('c2');
  assert.equal(await a.store.outboxCount(), 2);
  const r = await a.sync.syncOnce();
  assert.equal(r.pushed, 2);
  assert.equal(await a.store.outboxCount(), 0);
  assert.equal(srv.rows.length, 2);
});

test('pulled events are stored but not queued to push back', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  const r = await b.sync.syncOnce();
  assert.equal(r.pulled.length, 1);
  assert.equal(await b.store.outboxCount(), 0);
  assert.ok(isOn(await b.state(), 'c1'));
});

test('own events coming back from the server are not duplicated', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  await a.sync.syncOnce();
  assert.equal((await a.store.allEvents()).length, 1);
});

test('pull pages through everything and remembers the cursor', async () => {
  const srv = fakeServer({ pageSize: 3 });
  const a = device('a', srv);
  const b = device('b', srv);
  for (let i = 0; i < 10; i++) await a.tick(`c${i}`);
  await a.sync.syncOnce();
  const first = await b.sync.syncOnce();
  assert.equal(first.pulled.length, 10);
  assert.equal(await b.store.getMeta('pullCursor'), 10);
  await a.tick('c99');
  await a.sync.syncOnce();
  const second = await b.sync.syncOnce();
  assert.equal(second.pulled.length, 1);
});

test('pushes big outboxes in several requests', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  for (let i = 0; i < 450; i++) await a.tick(`c${i}`);
  await a.sync.syncOnce();
  assert.equal(srv.rows.length, 450);
  assert.ok(srv.posts >= 3);
});

test('the clock moves past timestamps pulled from other devices', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  a.at(900000);
  await a.tick('c1');
  await a.sync.syncOnce();
  await b.sync.syncOnce();
  assert.ok(b.clock.last >= 900000);
  const later = await b.tick('c1', false);
  assert.ok(later.ts > 900000);
  // b's untick wins everywhere even though b's wall clock is behind.
  await b.sync.syncOnce();
  await a.sync.syncOnce();
  assert.ok(!isOn(await a.state(), 'c1'));
});

test('offline: sync fails, nothing is lost, and the next sync catches up', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  srv.down = true;
  await assert.rejects(a.sync.syncOnce());
  assert.equal(await a.store.outboxCount(), 1);
  srv.down = false;
  await a.sync.syncOnce();
  assert.equal(await a.store.outboxCount(), 0);
  assert.equal(srv.rows.length, 1);
});

test('a restored server backup (same id, fewer events) gets everything pushed again', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  await a.tick('c2');
  await a.tick('c3');
  await a.sync.syncOnce();
  await b.sync.syncOnce();
  srv.restore(1); // backup taken after the first sync
  await b.sync.syncOnce();
  assert.equal(srv.rows.length, 3, 'b re-pushed what the backup lost');
  await b.tick('c4');
  await b.sync.syncOnce();
  await a.sync.syncOnce();
  assert.ok(isOn(await a.state(), 'c4'), 'a sees events added after the restore');
});

test('a backup restored without a new server id is caught even after new events pass the old cursor', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  const c = device('c', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  await a.tick('c2');
  await a.tick('c3');
  await a.sync.syncOnce();
  await b.sync.syncOnce(); // b's cursor: 3
  srv.restore(1); // the backup holds only c1
  await c.tick('c5');
  await c.tick('c6');
  await c.tick('c7');
  await c.sync.syncOnce(); // head is 4 again, past b's cursor
  const r = await b.sync.syncOnce();
  assert.equal(r.pushError, null);
  const ids = new Set(srv.rows.map((e) => e.data.key));
  assert.deepEqual([...ids].sort(), ['c1', 'c2', 'c3', 'c5', 'c6', 'c7'], 'b pushed back what the backup lost');
  const state = await b.state();
  for (const key of ['c5', 'c6', 'c7']) assert.ok(isOn(state, key), `b has ${key}, stored where its old cursor pointed`);
});

test('a server from before after_id never makes a device start over', async () => {
  const srv = fakeServer({ afterIds: false });
  const a = device('a', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  await a.tick('c2');
  await a.sync.syncOnce();
  const posts = srv.posts;
  await a.sync.syncOnce();
  assert.equal(srv.posts, posts, 'nothing pushed again');
  assert.equal(await a.store.outboxCount(), 0);
});

test('the cursor and the id at it are saved together, so a sync killed between them starts no reset', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  assert.deepEqual(await a.store.getMeta('pullCursorId'), { cursor: 1, id: srv.rows[0].id });
  await a.sync.syncOnce();
  assert.equal(srv.posts, 1, 'a second sync with nothing new pushes nothing');
});

test('a reset interrupted before saving the new server id runs again next time', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  srv.reset('srv-2');
  const setMeta = a.store.setMeta;
  a.store.setMeta = async (k, v) => { if (k === 'serverId') throw new Error('app killed'); return setMeta(k, v); };
  await assert.rejects(a.sync.syncOnce());
  a.store.setMeta = setMeta;
  await a.sync.syncOnce();
  assert.equal(srv.rows.length, 1);
});

test('a restore reset interrupted before requeueing runs again next time', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await a.tick('c2');
  await a.sync.syncOnce();
  srv.restore(0); // same server id, older copy
  const requeueAll = a.store.requeueAll;
  a.store.requeueAll = async () => { throw new Error('app killed'); };
  await assert.rejects(a.sync.syncOnce());
  a.store.requeueAll = requeueAll;
  await a.sync.syncOnce();
  await a.sync.syncOnce();
  assert.equal(srv.rows.length, 2);
});

test('events the server rejects leave the outbox and are listed, and the rest still sync', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const bad = await a.tick('c1');
  await a.tick('c2');
  const rejectIds = [bad.id];
  const srv2 = fakeServer({ rejectIds });
  const sync = createSync({ store: a.store, clock: a.clock, fetch: srv2.fetch });
  const r = await sync.syncOnce();
  assert.equal(r.pushError, null);
  assert.equal(await a.store.outboxCount(), 0);
  assert.equal(srv2.rows.length, 1);
  assert.deepEqual((await a.store.getMeta('rejected')).map((/** @type {{ id: string }} */ x) => x.id), [bad.id]);
});

test('a rejected event is kept with the core version that sent it, and tried again by a newer core', async () => {
  const a = device('a', fakeServer());
  const bad = await a.tick('c1');
  const strict = fakeServer({ rejectIds: [bad.id] });
  await createSync({ store: a.store, clock: a.clock, fetch: strict.fetch, coreVersion: '0.1.4' }).syncOnce();
  assert.deepEqual(await a.store.getMeta('rejected'), [{ id: bad.id, reason: 'bad', core: '0.1.4' }]);
  assert.equal(await a.store.outboxCount(), 0, 'out of the outbox, so it cannot block the events behind it');

  const same = createSync({ store: a.store, clock: a.clock, fetch: strict.fetch, coreVersion: '0.1.4' });
  const posts = strict.posts;
  await same.syncOnce();
  assert.equal(strict.posts, posts, 'the same core does not send it again');

  const fixed = fakeServer(); // say the next server accepts it
  const newer = createSync({ store: a.store, clock: a.clock, fetch: fixed.fetch, coreVersion: '0.1.5' });
  const r = await newer.syncOnce();
  assert.equal(r.pushError, null);
  assert.deepEqual(fixed.rows.map((e) => e.id), [bad.id], 'a newer core sends it again');
  assert.deepEqual(await a.store.getMeta('rejected'), [], 'and it is off the list once stored');
});

test('a list from an older core (no version) is tried again, and is never cut short', async () => {
  const a = device('a', fakeServer());
  const events = [];
  for (let i = 0; i < 150; i++) events.push(await a.tick(`k${i}`));
  await a.store.setMeta('rejected', [{ id: events[0].id, reason: 'old' }]); // as 0.1.3 wrote it
  const srv = fakeServer({ rejectIds: events.map((e) => e.id) });
  await createSync({ store: a.store, clock: a.clock, fetch: srv.fetch, coreVersion: '0.1.4' }).syncOnce();
  const kept = await a.store.getMeta('rejected');
  assert.equal(kept.length, 150, 'every rejected event stays listed (no cap drops one)');
  assert.equal(new Set(kept.map((/** @type {{ id: string }} */ x) => x.id)).size, 150, 'each once');
  assert.ok(kept.every((/** @type {{ core: string }} */ x) => x.core === '0.1.4'));
});

test('a replaced server clears the list: every event is sent to it again', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const bad = await a.tick('c1');
  await a.store.setMeta('rejected', [{ id: bad.id, reason: 'bad', core: '9.9.9' }]);
  await a.store.markSynced([bad.id]);
  await a.sync.syncOnce();
  srv.reset('srv-2');
  await a.sync.syncOnce();
  assert.deepEqual(await a.store.getMeta('rejected'), []);
  assert.deepEqual(srv.rows.map((e) => e.id), [bad.id]);
});

test('a failing push still pulls other devices\' changes', async () => {
  const srv = fakeServer();
  const b = device('b', srv);
  await b.tick('c9');
  await b.sync.syncOnce();
  const a = device('a', srv);
  await a.tick('c1');
  const sync = createSync({
    store: a.store,
    clock: a.clock,
    fetch: async (url, opts = {}) => (opts.method === 'POST'
      ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      : srv.fetch(url, opts)),
  });
  const r = await sync.syncOnce();
  assert.match(/** @type {Error} */ (r.pushError).message, /500: boom/);
  assert.equal(r.pulled.length, 1);
  assert.equal(await a.store.outboxCount(), 1);
  assert.equal(await a.store.getMeta('lastSyncAt', null), null);
});

test('a request that never answers times out instead of hanging sync', async () => {
  const a = device('a', fakeServer());
  const sync = createSync({
    store: a.store,
    clock: a.clock,
    timeoutMs: 20,
    fetch: (url, { signal } = {}) => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
  });
  await assert.rejects(sync.syncOnce(), /timed out/);
});

test('a malformed pull reply does not corrupt the cursor', async () => {
  const a = device('a', fakeServer());
  const sync = createSync({ store: a.store, clock: a.clock, fetch: async () => ({ ok: true, status: 200, json: async () => ({ events: [] }) }) });
  await assert.rejects(sync.syncOnce(), /unexpected reply/);
  assert.equal(await a.store.getMeta('pullCursor', 0), 0);
});

test('pushes stay under the server body limit even with big events', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  for (let i = 0; i < 60; i++) {
    const e = flagSet(a.ctx, `c${i}`, true);
    e.data.note = 'x'.repeat(60 * 1024);
    await a.store.addEvents([e], { local: true });
  }
  const r = await a.sync.syncOnce();
  assert.equal(r.pushError, null);
  assert.equal(srv.rows.length, 60);
});

test('pull reports events another tab already stored, so every tab can apply them', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await a.sync.syncOnce();
  const b = device('b', srv);
  await b.store.addEvents([(await a.store.allEvents())[0]]); // the other tab got it first
  const r = await b.sync.syncOnce();
  assert.equal(r.pulled.length, 0);
  assert.equal(r.received.length, 1);
});

test('server errors reject and keep the outbox', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  const sync = createSync({
    store: a.store,
    clock: a.clock,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  });
  await assert.rejects(sync.syncOnce(), /500/);
  assert.equal(await a.store.outboxCount(), 1);
});

test('invalid events from the server are skipped', async () => {
  const srv = fakeServer();
  srv.rows.push(/** @type {PwaEvent} */ (/** @type {unknown} */ ({ id: 'junk', type: 'flag.set' }))); // invalid on purpose
  const a = device('a', srv);
  const r = await a.sync.syncOnce();
  assert.equal(r.pulled.length, 0);
  assert.equal(r.skipped, 1);
  assert.equal(await a.store.getMeta('pullCursor'), 1);
});

test('events whose body this version can\'t read are still kept, for a later version', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const e = flagSet(a.ctx, 'c1', true);
  e.data = { key: 'c1', on: 'maybe' }; // sound envelope, body this version rejects
  srv.rows.push(e);
  const r = await a.sync.syncOnce();
  assert.equal(r.skipped, 0);
  assert.deepEqual((await a.store.allEvents()).map((x) => x.id), [e.id]);
  assert.ok(!isOn(await a.state(), 'c1'));
});

test('a replaced server database gets everything pushed again', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  await a.tick('c1');
  await b.tick('c2');
  await a.sync.syncOnce();
  await b.sync.syncOnce();
  await a.sync.syncOnce();
  srv.reset('srv-2');
  await a.sync.syncOnce();
  assert.equal(srv.rows.length, 2, 'a re-pushed both events it knows');
  await b.sync.syncOnce();
  assert.equal(srv.rows.length, 2);
  assert.equal(await b.store.getMeta('serverId'), 'srv-2');
});

test('two devices converge to the same state', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  a.at(1000); await a.tick('c1');
  b.at(1500); await b.tick('c1', false);
  a.at(2000); await a.tick('c2');
  b.at(2000); await b.tick('c2', false); // same ts: device id breaks the tie
  for (let i = 0; i < 2; i++) { await a.sync.syncOnce(); await b.sync.syncOnce(); }
  const sa = await a.state();
  const sb = await b.state();
  assert.deepEqual([...sa.entries()].sort(), [...sb.entries()].sort());
  assert.equal(sa.size, 2);
});

test('overlapping sync calls share one run', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  await a.tick('c1');
  await Promise.all([a.sync.syncOnce(), a.sync.syncOnce()]);
  assert.equal(srv.posts, 1);
});

test('lastSyncAt is recorded after a successful sync', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  a.at(123456);
  await a.sync.syncOnce();
  assert.equal(await a.store.getMeta('lastSyncAt'), 123456);
});

test('a device of another app is refused, and nothing it has reaches that server', async () => {
  const srv = fakeServer({ appId: 'trips' });
  const a = device('a', srv, 'notes');
  await a.tick('k');
  await assert.rejects(a.sync.syncOnce(), /this server is for app 'trips', not 'notes'/);
  assert.equal(srv.rows.length, 0);
  assert.equal(await a.store.outboxCount(), 1, 'the event stays queued for the right server');
});

test('a device of the right app syncs, and every request names the app', async () => {
  const srv = fakeServer({ appId: 'trips' });
  /** @type {string[]} */
  const urls = [];
  const fetch = srv.fetch;
  srv.fetch = (url, opts) => { urls.push(url); return fetch(url, opts); };
  const a = device('a', srv, 'trips');
  await a.tick('k');
  const r = await a.sync.syncOnce();
  assert.equal(r.pushError, null);
  assert.equal(srv.rows.length, 1);
  assert.ok(urls.length >= 2 && urls.every((u) => new URL(u, 'http://x').searchParams.get('app') === 'trips'), urls.join(' '));
});

test('a deeply nested event on the server is skipped, and the events after it still arrive', async () => {
  const srv = fakeServer();
  const a = device('a', srv);
  const b = device('b', srv);
  /** @type {any} */
  let deep = {};
  for (let i = 0; i < 1000; i++) deep = { x: deep }; // events.test.js covers 20000 (structuredClone here can't)
  srv.rows.push(/** @type {PwaEvent} */ ({ id: 'deep', v: 1, type: 't', ts: 1, device_id: 'evil', data: deep }));
  await a.tick('k');
  await a.sync.syncOnce();
  const r = await b.sync.syncOnce();
  assert.equal(r.skipped, 1);
  assert.ok(isOn(buildFlags(await b.store.allEvents()), 'k'));
});

test('the clock follows every pulled event within the skew limit, even when the page holds one past it', async () => {
  const srv = fakeServer();
  const b = device('b', srv);
  const hour = 60 * 60 * 1000;
  const base = { v: 1, type: 'flag.set', device_id: 'far', data: { key: 'k', on: true } };
  srv.rows.push(/** @type {PwaEvent} */ ({ ...base, id: 'near', ts: 1000 + hour }), /** @type {PwaEvent} */ ({ ...base, id: 'far', ts: 1000 + 30 * hour }));
  await b.sync.syncOnce();
  assert.equal(b.clock.last, 1000 + hour, 'an edit made now is stamped after the event an hour ahead');
});
