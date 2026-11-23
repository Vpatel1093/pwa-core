// In-memory store with the same interface as idbstore.js. Used by tests and
// as a fallback when IndexedDB is unavailable (e.g. some private modes).

/** @typedef {import('./events.js').PwaEvent} PwaEvent */

/**
 * The store interface both stores share. Meta values are whatever the app
 * stored under that key, so getMeta returns any.
 * @typedef {{
 *   kind: 'memory' | 'indexeddb',
 *   getMeta(key: string, fallback?: any): Promise<any>,
 *   setMeta(key: string, value: unknown): Promise<void>,
 *   allEvents(): Promise<PwaEvent[]>,
 *   addEvents(list: PwaEvent[], opts?: { local?: boolean }): Promise<PwaEvent[]>,
 *   outbox(limit?: number): Promise<PwaEvent[]>,
 *   outboxCount(): Promise<number>,
 *   markSynced(ids: string[]): Promise<void>,
 *   requeueAll(): Promise<void>,
 * }} Store
 */

/** @returns {Store} */
export function createMemoryStore() {
  /** @type {Map<string, PwaEvent>} */
  const events = new Map(); // id -> event, insertion ordered
  /** @type {Set<string>} */
  const outbox = new Set(); // ids not yet pushed
  /** @type {Map<string, unknown>} */
  const meta = new Map();

  return {
    kind: 'memory',
    async getMeta(key, fallback) {
      return meta.has(key) ? structuredClone(meta.get(key)) : fallback;
    },
    async setMeta(key, value) {
      meta.set(key, structuredClone(value));
    },
    async allEvents() {
      return [...events.values()].map((e) => structuredClone(e));
    },
    async addEvents(list, { local = false } = {}) {
      const added = [];
      for (const e of list) {
        if (events.has(e.id)) continue;
        const copy = structuredClone(e);
        events.set(e.id, copy);
        if (local) outbox.add(e.id);
        added.push(structuredClone(copy));
      }
      return added;
    },
    async outbox(limit = Infinity) {
      const out = [];
      for (const id of outbox) {
        if (out.length >= limit) break;
        out.push(structuredClone(/** @type {PwaEvent} */ (events.get(id))));
      }
      return out;
    },
    async outboxCount() {
      return outbox.size;
    },
    async markSynced(ids) {
      for (const id of ids) outbox.delete(id);
    },
    async requeueAll() {
      for (const id of events.keys()) outbox.add(id);
    },
  };
}
