// The wiring every app needs between the store, the clock, sync, and other
// tabs. No DOM here (see shell.js for that), so it runs under node:test.
//
//   const rt = await startRuntime({ store, appVersion, onEvents, onStatus });
//   await rt.record(makeEvent(rt.ctx(), { type: 'note.added', data }));
//
// onEvents(events, source) is how the app hears about events, to fold them
// into its state. source is 'load' (stored, at startup), 'local' (recorded
// here), 'tab' (another tab of the app), 'sync' or 'import'. The same event
// can arrive more than once (a tab and a sync, say), so applying an event
// must be idempotent; the event log design already needs that.

import { createClock } from './clock.js';
import { validateEnvelope } from './events.js';
import { createSync } from './sync.js';
import { uuidv7 } from './uuid.js';

const SYNC_DEBOUNCE_MS = 1500; // after a write, so a burst of writes is one push

/** @typedef {import('./events.js').PwaEvent} PwaEvent */
/** @typedef {'load' | 'local' | 'tab' | 'sync' | 'import'} EventSource */
/**
 * status: 'idle' until the first sync, then 'ok', 'offline' or 'error'.
 * @typedef {{
 *   status: 'idle' | 'ok' | 'offline' | 'error',
 *   error: string | null,
 *   manual: boolean,
 *   lastSyncAt: number | null,
 *   pending: number,
 * }} SyncStatus
 */
/** @typedef {Awaited<ReturnType<typeof startRuntime>>} Runtime */

/**
 * @param {{
 *   store: import('./memstore.js').Store,
 *   appVersion?: string,
 *   eventVersion?: number,
 *   fetch?: import('./sync.js').FetchLike,
 *   base?: string,
 *   appId?: string,
 *   now?: () => number,
 *   tz?: string,
 *   channel?: BroadcastChannel | null,
 *   debounceMs?: number,
 *   onEvents?: (events: PwaEvent[], source: EventSource) => void,
 *   onStatus?: (status: SyncStatus) => void,
 * }} opts
 */
export async function startRuntime({
  store,
  appVersion,
  eventVersion = 1,
  fetch,
  base = '',
  appId, // named on every sync request, so another app's server refuses this one
  now = () => Date.now(),
  tz = Intl.DateTimeFormat().resolvedOptions().timeZone,
  channel = null, // a BroadcastChannel shared by this app's tabs
  debounceMs = SYNC_DEBOUNCE_MS,
  onEvents = () => {},
  onStatus = () => {},
}) {
  let deviceId = await store.getMeta('deviceId', null);
  if (!deviceId) {
    deviceId = uuidv7(now());
    await store.setMeta('deviceId', deviceId);
  }
  const clock = createClock({ now, last: await store.getMeta('clockLast', 0) });
  const loaded = await store.allEvents();
  for (const e of loaded) clock.observe(e.ts);
  const sync = createSync({ store, clock, now, base, appId, ...(fetch ? { fetch } : {}) });

  /** @type {SyncStatus} */
  const status = {
    status: 'idle', error: null, manual: false,
    lastSyncAt: await store.getMeta('lastSyncAt', null),
    pending: await store.outboxCount(),
  };
  const tell = () => onStatus({ ...status });
  let closed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @returns {import('./events.js').EventContext} */
  const ctx = () => ({ clock, deviceId, appVersion, eventVersion, tz, now });

  // Writes run one at a time, so a quick second tap sees the first one's
  // result. A failed write must not jam the queue for the next one.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function saveClock() {
    await store.setMeta('clockLast', clock.last);
  }

  /** @param {PwaEvent[]} events @param {EventSource} source */
  async function addLocal(events, source) {
    const added = await store.addEvents(events, { local: true });
    for (const e of added) clock.observe(e.ts);
    await saveClock();
    if (added.length) {
      onEvents(added, source);
      channel?.postMessage(added);
    }
    status.pending = await store.outboxCount();
    tell();
    if (added.length) scheduleSync();
    return added;
  }

  /** @param {PwaEvent} event */
  function record(event) {
    return serial(async () => {
      const bad = validateEnvelope(event);
      if (bad !== null) throw new Error(`refused to record an event with a bad ${bad}`);
      await addLocal([event], 'local');
      return event;
    });
  }

  /** @param {PwaEvent[]} events */
  function importEvents(events) {
    return serial(() => addLocal(events.filter((e) => validateEnvelope(e) === null), 'import'));
  }

  function scheduleSync(delay = debounceMs) {
    clearTimeout(timer);
    if (!closed) timer = setTimeout(() => runSync(), delay);
  }

  // manual: the person asked, so the UI can show "Syncing…".
  /** @param {{ manual?: boolean }} [opts] @returns {Promise<SyncStatus>} */
  async function runSync({ manual = false } = {}) {
    clearTimeout(timer);
    if (manual) {
      status.manual = true;
      tell();
    }
    try {
      const r = await sync.syncOnce();
      await saveClock();
      // received, not pulled: another tab may have stored some of them first.
      if (r.received.length) onEvents(r.received, 'sync');
      if (r.pulled.length) channel?.postMessage(r.pulled);
      if (r.pushError) throw r.pushError;
      status.status = 'ok';
      status.error = null;
    } catch (err) {
      // No response at all means we're away from the server; anything else
      // is a real problem worth telling apart.
      const message = /** @type {Error | undefined} */ (err)?.message;
      status.status = err instanceof TypeError || message === 'timed out' ? 'offline' : 'error';
      status.error = message || String(err);
    }
    status.manual = false;
    status.lastSyncAt = await store.getMeta('lastSyncAt', null);
    status.pending = await store.outboxCount();
    tell();
    return { ...status };
  }

  // Other tabs share their events right away. Without this a second tab
  // keeps stale state and its edits are made on top of the wrong value.
  /** @param {MessageEvent} msg */
  const onMessage = (msg) => {
    const events = (Array.isArray(msg.data) ? msg.data : [msg.data]).filter((e) => validateEnvelope(e) === null);
    for (const e of events) clock.observe(e.ts);
    if (events.length) onEvents(events, 'tab');
  };
  channel?.addEventListener('message', onMessage);

  if (loaded.length) onEvents(loaded, 'load');

  return {
    store,
    clock,
    deviceId,
    ctx,
    record,
    importEvents,
    runSync,
    scheduleSync,
    get status() { return { ...status }; },
    close() {
      closed = true;
      clearTimeout(timer);
      channel?.removeEventListener('message', onMessage);
      channel?.close?.();
    },
  };
}
