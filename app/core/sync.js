// Push the outbox, then pull everything new. The server only stores events,
// so merging is just "add what we don't have yet" (dedupe by id); state.js
// makes the result the same on every device.

import { validateEnvelope, eventBytes } from './events.js';

const PUSH_BATCH = 200; // events per push; the server takes up to 1000
const PUSH_BYTES = 1024 * 1024; // the server takes bodies up to 2MB
const PULL_PAGE = 500;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_REJECTED_KEPT = 100;

/** @typedef {import('./events.js').PwaEvent} PwaEvent */
/**
 * The part of fetch that sync uses, so a test can pass a small fake.
 * @typedef {(url: string, init?: RequestInit) => Promise<{ ok: boolean, status: number, json(): Promise<any> }>} FetchLike
 */
/**
 * pulled: new to this device. received: every valid event the server sent.
 * @typedef {{ pushed: number, pulled: PwaEvent[], received: PwaEvent[], skipped: number, pushError: unknown }} SyncResult
 */

/**
 * @param {{
 *   store: import('./memstore.js').Store,
 *   clock: import('./clock.js').Clock,
 *   fetch?: FetchLike,
 *   base?: string,
 *   appId?: string,
 *   now?: () => number,
 *   timeoutMs?: number,
 * }} opts
 * appId names this app on every request, so a server of another app refuses
 * it (409) instead of mixing the two apps' events for good.
 */
export function createSync({
  store, clock, fetch: fetchFn = globalThis.fetch.bind(globalThis), base = '', appId, now = () => Date.now(),
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const app = appId ? `app=${encodeURIComponent(appId)}` : '';
  /** @type {Promise<SyncResult> | null} */
  let running = null;

  // A request that never settles (captive portal, half-up VPN) must not
  // leave sync stuck until the app is reloaded.
  /** @param {string} url @param {RequestInit} [opts] @returns {Promise<any>} */
  async function request(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(`HTTP ${res.status}${body.error ? `: ${body.error}` : ''}`), { status: res.status });
      }
      return await res.json();
    } catch (err) {
      if (/** @type {Error} */ (err).name === 'AbortError') throw new Error('timed out', { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Take events up to the count and size limits (always at least one).
  /** @param {PwaEvent[]} events */
  function fitBatch(events) {
    let bytes = 0;
    let n = 0;
    for (const e of events) {
      bytes += eventBytes(e) + 1;
      if (n > 0 && bytes > PUSH_BYTES) break;
      n++;
    }
    return events.slice(0, n);
  }

  async function push() {
    let pushed = 0;
    for (;;) {
      const batch = fitBatch(await store.outbox(PUSH_BATCH));
      if (!batch.length) return pushed;
      const reply = await request(`${base}/api/events${app ? `?${app}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      // Rejected events will never be accepted, so they leave the outbox
      // too (retrying would block everything behind them). They stay on this
      // device and are listed in meta for Settings to show.
      if (Array.isArray(reply.rejected) && reply.rejected.length) {
        const kept = await store.getMeta('rejected', []);
        const add = reply.rejected.map((/** @type {{ id?: string, index: number, reason?: unknown }} */ r) => ({ id: r.id ?? batch[r.index]?.id ?? null, reason: String(r.reason ?? '') }));
        await store.setMeta('rejected', [...kept, ...add].slice(-MAX_REJECTED_KEPT));
      }
      await store.markSynced(batch.map((e) => e.id));
      pushed += batch.length;
    }
  }

  /** @param {any} page */
  function checkPage(page) {
    if (!page || !Array.isArray(page.events) || !Number.isSafeInteger(page.next) || typeof page.more !== 'boolean') {
      throw new Error('unexpected reply from the server');
    }
  }

  async function pull() {
    /** @type {PwaEvent[]} */
    const pulled = []; // new to this device
    /** @type {PwaEvent[]} */
    const received = []; // every valid event seen (another tab may have stored some already)
    let skipped = 0;
    let after = await store.getMeta('pullCursor', 0);
    const knownServer = await store.getMeta('serverId', null);
    for (;;) {
      const page = await request(`${base}/api/events?after=${after}&limit=${PULL_PAGE}${app ? `&${app}` : ''}`);
      checkPage(page);
      const replaced = page.server_id && knownServer !== null && page.server_id !== knownServer;
      // Cursor past the end: the server is an older copy (restored backup).
      const behind = Number.isSafeInteger(page.head) && after > page.head;
      if (replaced || behind) {
        // Our cursor means nothing there, and it may be missing our events.
        // Order matters: if the app dies partway, the server id still
        // differs (or the cursor is still past head) and this runs again.
        await store.requeueAll();
        await store.setMeta('pullCursor', 0);
        if (page.server_id) await store.setMeta('serverId', page.server_id);
        return { pulled, received, skipped, restarted: true };
      }
      if (page.server_id && knownServer === null) await store.setMeta('serverId', page.server_id);
      /** @type {PwaEvent[]} */
      const valid = [];
      for (const e of page.events) {
        if (validateEnvelope(e) === null) valid.push(e);
        else skipped++;
      }
      const added = await store.addEvents(valid);
      for (const e of valid) clock.observe(e.ts); // each one: a page max past the skew limit would hide the rest
      pulled.push(...added);
      received.push(...valid);
      after = page.next;
      await store.setMeta('pullCursor', after);
      if (!page.more) return { pulled, received, skipped, restarted: false };
    }
  }

  /** @returns {Promise<SyncResult>} */
  async function run() {
    // A failed push must not stop us from pulling other devices' changes.
    let pushed = 0;
    /** @type {unknown} */
    let pushError = null;
    try {
      pushed = await push();
    } catch (err) {
      pushError = err;
    }
    /** @type {{ pulled: PwaEvent[], received: PwaEvent[], skipped: number, restarted?: boolean }} */
    let result = await pull();
    if (result.restarted) {
      // Server was replaced: push everything we have, then pull from the start.
      if (!pushError) pushed += await push();
      const again = await pull();
      result = {
        pulled: [...result.pulled, ...again.pulled],
        received: [...result.received, ...again.received],
        skipped: result.skipped + again.skipped,
      };
    }
    if (!pushError) await store.setMeta('lastSyncAt', now());
    return { pushed, pulled: result.pulled, received: result.received, skipped: result.skipped, pushError };
  }

  return {
    // Overlapping calls share the in-flight run.
    syncOnce() {
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
  };
}
