// Browser-only helpers every app's main.js uses: opening storage, the
// service worker update banner, syncing on the right triggers, export.
// The logic they call lives in runtime.js and is tested there.

import { openIdbStore } from './idbstore.js';
import { createMemoryStore } from './memstore.js';
import { makeBackup, backupFilename } from './backup.js';

// IndexedDB, or memory when the browser won't allow storage (some private
// modes). Check store.kind === 'memory' and warn: data is lost on close.
/** @typedef {import('./runtime.js').Runtime} Runtime */

/**
 * @param {string} appId
 * @param {{ onVersionChange?: () => void }} [opts]
 * @returns {Promise<import('./memstore.js').Store>}
 */
export async function openStore(appId, { onVersionChange = () => {} } = {}) {
  try {
    return await openIdbStore(appId, { onVersionChange });
  } catch {
    return createMemoryStore();
  }
}

// Ask the browser not to clear this site's storage when space runs low.
/** @param {import('./memstore.js').Store} store */
export function askPersist(store) {
  if (store.kind !== 'memory') navigator.storage?.persist?.().catch(() => {});
}

// banner: an element with a <button>, shown when a new version is ready.
// The new worker waits until the person taps it, so an update never swaps
// code under an open page.
/** @param {HTMLElement} banner */
export function registerServiceWorker(banner, url = './sw.js') {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let reloading = false;
  // The first install also fires controllerchange; only reload for updates.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register(url).then((reg) => {
    /** @param {ServiceWorker} worker */
    const offer = (worker) => {
      banner.hidden = false;
      /** @type {HTMLButtonElement} */ (banner.querySelector('button')).onclick = () => worker.postMessage('skipWaiting');
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker?.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// Sync when the app comes back to the front, when the network returns, and
// every `everyMs` while visible. The first sync runs right away.
/** @param {Runtime} rt */
export function keepSyncing(rt, { everyMs = 60 * 1000 } = {}) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') rt.runSync();
  });
  window.addEventListener('online', () => rt.runSync());
  setInterval(() => { if (document.visibilityState === 'visible') rt.runSync(); }, everyMs);
  rt.runSync();
}

// Share sheet on phones, a download elsewhere. Returns false if cancelled.
// events: pass them in when the export runs from a tap. iOS only opens the
// share sheet right after a tap, and an await before it can use that up, so
// read the events before (when the menu opens, say).
/**
 * @param {Runtime} rt
 * @param {{ format: string, prefix: string, appVersion?: string, today: string, events?: import('./events.js').PwaEvent[] | null }} opts
 */
export async function exportBackup(rt, { format, prefix, appVersion, today, events = null }) {
  events ??= await rt.store.allEvents();
  const blob = new Blob([JSON.stringify(makeBackup(events, { format, appVersion }), null, 1)], { type: 'application/json' });
  const name = backupFilename(prefix, today);
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: name });
      await rt.store.setMeta('lastExportAt', Date.now());
      return true;
    } catch (err) {
      if (/** @type {Error} */ (err).name === 'AbortError') return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  await rt.store.setMeta('lastExportAt', Date.now());
  return true;
}

/** @param {Element} root @param {unknown} err */
export function showFatal(root, err) {
  const section = document.createElement('section');
  section.className = 'fatal';
  section.innerHTML = "<h1>The app couldn't start</h1><p>Nothing has been deleted. Try reloading.</p>"
    + '<button class="primary">Reload</button><details><summary>Details for a bug report</summary><pre></pre></details>';
  /** @type {HTMLButtonElement} */ (section.querySelector('button')).onclick = () => location.reload();
  /** @type {HTMLPreElement} */ (section.querySelector('pre')).textContent = String(/** @type {Error | undefined} */ (err)?.stack || err);
  root.replaceChildren(section);
}
