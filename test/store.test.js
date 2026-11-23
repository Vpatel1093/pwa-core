// One contract for both stores: the in-memory one (tests, fallback) and the
// IndexedDB one (real devices), which runs here on fake-indexeddb.
// The contract doesn't assert order: IndexedDB returns keys sorted by id,
// the memory store in insertion order, and nothing relies on either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB as fakeIndexedDB, forceCloseDatabase } from 'fake-indexeddb';
import { createMemoryStore } from '../app/core/memstore.js';
import { openIdbStore } from '../app/core/idbstore.js';

// idbstore uses the global, as in a browser. Record every connection it
// opens so tests can close them underneath it.
const connections = [];
globalThis.indexedDB = {
  open(...args) {
    const req = fakeIndexedDB.open(...args);
    req.addEventListener('success', () => connections.push(req.result));
    return req;
  },
};

let dbCount = 0;
const freshIdb = (opts) => openIdbStore(`test-${++dbCount}`, opts);

const e = (id) => ({ id, v: 1, type: 'x', scope_id: 's', ts: 1, device_id: 'd', data: {} });
const ids = (list) => list.map((x) => x.id).sort();

function contract(name, makeStore) {
  describe(`${name} store`, () => {
    test('addEvents returns only the new ones and keeps the first copy', async () => {
      const s = await makeStore();
      assert.deepEqual(ids(await s.addEvents([e('a'), e('b')])), ['a', 'b']);
      assert.deepEqual(ids(await s.addEvents([e('b'), e('c'), e('c')])), ['c']);
      assert.deepEqual(ids(await s.allEvents()), ['a', 'b', 'c']);
    });

    test('only local events enter the outbox; limit and markSynced work', async () => {
      const s = await makeStore();
      await s.addEvents([e('r1')]);
      await s.addEvents([e('l1'), e('l2')], { local: true });
      assert.deepEqual(ids(await s.outbox()), ['l1', 'l2']);
      assert.equal((await s.outbox(1)).length, 1);
      await s.markSynced(['l1']);
      assert.equal(await s.outboxCount(), 1);
      assert.deepEqual(ids(await s.outbox()), ['l2']);
    });

    test('an event pulled before it was made locally does not enter the outbox', async () => {
      const s = await makeStore();
      await s.addEvents([e('a')]);
      assert.deepEqual(await s.addEvents([e('a')], { local: true }), []);
      assert.equal(await s.outboxCount(), 0);
    });

    test('requeueAll puts every event back in the outbox', async () => {
      const s = await makeStore();
      await s.addEvents([e('r1')]);
      await s.addEvents([e('l1')], { local: true });
      await s.markSynced(['l1']);
      await s.requeueAll();
      assert.equal(await s.outboxCount(), 2);
      assert.deepEqual(ids(await s.outbox()), ['l1', 'r1']);
    });

    test('meta values round-trip with a fallback', async () => {
      const s = await makeStore();
      assert.equal(await s.getMeta('k', 7), 7);
      await s.setMeta('k', { a: 1 });
      assert.deepEqual(await s.getMeta('k'), { a: 1 });
      await s.setMeta('k', 0);
      assert.equal(await s.getMeta('k', 7), 0);
    });

    test('stored events and meta are copies, not shared references', async () => {
      const s = await makeStore();
      const x = e('a');
      await s.addEvents([x]);
      x.ts = 999;
      assert.equal((await s.allEvents())[0].ts, 1);
      const m = { n: 1 };
      await s.setMeta('m', m);
      m.n = 2;
      assert.equal((await s.getMeta('m')).n, 1);
    });
  });
}

contract('memory', createMemoryStore);
contract('indexeddb', freshIdb);

describe('indexeddb store only', () => {
  test('two stores on the same database see each other (like two tabs)', async () => {
    const a = await openIdbStore('shared');
    const b = await openIdbStore('shared');
    await a.addEvents([e('x')], { local: true });
    assert.deepEqual(ids(await b.allEvents()), ['x']);
    assert.equal(await b.outboxCount(), 1);
  });

  test('reconnects after the browser drops the connection', async () => {
    const s = await freshIdb();
    await s.addEvents([e('a')], { local: true });
    forceCloseDatabase(connections.at(-1)); // like iOS closing it in the background
    await s.addEvents([e('b')], { local: true });
    assert.deepEqual(ids(await s.allEvents()), ['a', 'b']);
    assert.equal(await s.outboxCount(), 2);
  });

  test('reconnects when a closed connection throws InvalidStateError', async () => {
    const s = await freshIdb();
    await s.setMeta('k', 1);
    connections.at(-1).close(); // closed without a close event
    assert.equal(await s.getMeta('k'), 1);
  });

  test('outbox drops ids with no event behind them', async () => {
    const name = `test-${++dbCount}`;
    const s = await openIdbStore(name);
    await s.addEvents([e('a')], { local: true });
    // Write an orphan straight into the outbox, as a half-finished old write could.
    const db = connections.at(-1);
    await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put({ id: 'ghost' });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    assert.equal(await s.outboxCount(), 2);
    assert.deepEqual(ids(await s.outbox()), ['a']);
    assert.equal(await s.outboxCount(), 1);
  });

  test('a newer schema in another tab closes this connection and says so', async () => {
    const name = `test-${++dbCount}`;
    let told = 0;
    await openIdbStore(name, { onVersionChange: () => told++ });
    await new Promise((resolve, reject) => {
      const req = fakeIndexedDB.open(name, 2);
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    assert.equal(told, 1);
  });
});

test('openIdbStore needs the app\'s storage id', async () => {
  await assert.rejects(openIdbStore(), /name/);
});
