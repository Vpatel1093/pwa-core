// IndexedDB store. Same interface as memstore.js.
//   events  keyPath id    the full log
//   outbox  keyPath id    ids of local events not yet pushed
//   meta    out-of-line   device id, clock, cursor, settings

const DB_VERSION = 1;

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function openDb(name) {
  const open = indexedDB.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  };
  return promisify(open);
}

// name: the app's storage id (see js/config.js). Keep it stable: a new name
// is a new, empty database.
// onVersionChange: another tab wants a newer schema; this tab's connection
// is closed and the page should reload.
export async function openIdbStore(name, { onVersionChange = () => {} } = {}) {
  if (typeof name !== 'string' || !name) throw new Error('openIdbStore needs a database name');
  let db = null;
  let closed = true;

  async function connect() {
    db = await openDb(name);
    closed = false;
    db.onclose = () => { closed = true; }; // e.g. iOS drops it while backgrounded
    db.onversionchange = () => {
      db.close();
      closed = true;
      onVersionChange();
    };
  }

  // Start a transaction, reconnecting once if the connection was lost.
  // (Awaiting here is fine: no transaction is open yet.)
  async function txn(stores, mode = 'readonly') {
    if (closed) await connect();
    try {
      return db.transaction(stores, mode);
    } catch (err) {
      if (err.name !== 'InvalidStateError') throw err;
      await connect();
      return db.transaction(stores, mode);
    }
  }

  await connect();

  return {
    kind: 'indexeddb',
    async getMeta(key, fallback) {
      const v = await promisify((await txn('meta')).objectStore('meta').get(key));
      return v === undefined ? fallback : v;
    },
    async setMeta(key, value) {
      const tx = await txn('meta', 'readwrite');
      tx.objectStore('meta').put(value, key);
      await done(tx);
    },
    async allEvents() {
      return promisify((await txn('events')).objectStore('events').getAll());
    },
    async addEvents(list, { local = false } = {}) {
      const tx = await txn(['events', 'outbox'], 'readwrite');
      const events = tx.objectStore('events');
      const outbox = tx.objectStore('outbox');
      const added = [];
      const seen = new Set();
      for (const e of list) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        events.count(e.id).onsuccess = (ev) => {
          if (ev.target.result > 0) return;
          events.add(e);
          if (local) outbox.put({ id: e.id });
          added.push(e);
        };
      }
      await done(tx);
      return added;
    },
    async outbox(limit = Infinity) {
      // Callbacks, not awaits, inside the transaction: some Safari versions
      // auto-commit a transaction across a promise boundary.
      const tx = await txn(['outbox', 'events'], 'readwrite');
      const events = tx.objectStore('events');
      const outbox = tx.objectStore('outbox');
      const out = [];
      outbox.getAllKeys(null, Number.isFinite(limit) ? limit : undefined).onsuccess = (ev) => {
        for (const id of ev.target.result) {
          events.get(id).onsuccess = (g) => {
            if (g.target.result) out.push(g.target.result);
            else outbox.delete(id); // no event behind it; drop so it can't stall pushes
          };
        }
      };
      await done(tx);
      return out;
    },
    async outboxCount() {
      return promisify((await txn('outbox')).objectStore('outbox').count());
    },
    async markSynced(ids) {
      const tx = await txn('outbox', 'readwrite');
      const outbox = tx.objectStore('outbox');
      for (const id of ids) outbox.delete(id);
      await done(tx);
    },
    async requeueAll() {
      const tx = await txn(['events', 'outbox'], 'readwrite');
      const outbox = tx.objectStore('outbox');
      tx.objectStore('events').getAllKeys().onsuccess = (ev) => {
        for (const id of ev.target.result) outbox.put({ id });
      };
      await done(tx);
    },
  };
}
