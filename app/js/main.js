// The example app's page. A new app keeps the startup shape below (open the
// store, start the runtime, fold events into state, render) and replaces
// the notes parts with its own.

import { h } from '../core/dom.js';
import { startRuntime } from '../core/runtime.js';
import { openStore, askPersist, registerServiceWorker, keepSyncing, exportBackup, showFatal } from '../core/shell.js';
import { parseImport } from '../core/backup.js';
import { diagnosticsText } from '../core/diagnostics.js';
import { syncLabel } from '../core/format.js';
import { logicalDay } from '../core/days.js';
import { APP_NAME, APP_ID, APP_VERSION, EVENT_VERSION, BACKUP_FORMAT } from './config.js';
import { applyEvent, createNotes, listNotes, noteAdded, noteDone } from './notes.js';

/** @typedef {import('../core/runtime.js').Runtime} Runtime */

// Every id this file looks up is in index.html.
/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @type {{ rt: Runtime | null, notes: import('./notes.js').Notes, status: import('../core/runtime.js').SyncStatus | null }} */
const app = { rt: null, notes: createNotes(), status: null };

// init sets app.rt before it renders or wires any button, so the handlers
// that call this always have it.
function runtime() {
  if (!app.rt) throw new Error('The runtime has not started.');
  return app.rt;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {string} text */
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- render ----------

function renderHeader() {
  const s = app.status ?? runtime().status;
  const { text, stale, label } = syncLabel(s);
  const btn = $('sync-status');
  btn.textContent = text;
  btn.classList.toggle('stale', stale);
  btn.setAttribute('aria-label', label);
}

function render() {
  const items = listNotes(app.notes);
  $('view').replaceChildren(
    h('form', { class: 'add', onsubmit: addNote },
      h('label', { for: 'note-text', class: 'sr-only' }, 'New note'),
      h('input', { id: 'note-text', name: 'text', maxlength: 500, autocomplete: 'off', placeholder: 'Add a note' }),
      h('button', { class: 'primary' }, 'Add')),
    items.length
      ? h('ul', { class: 'notes' }, items.map((n) => h('li', {},
        h('label', {},
          h('input', { type: 'checkbox', checked: n.done, onchange: () => toggle(n) }),
          h('span', { class: n.done ? 'done' : null }, n.text)))))
      : h('p', { class: 'muted' }, 'No notes yet. Add one here, then open this page on another device to see it sync.'),
  );
  renderHeader();
}

// ---------- actions ----------

/** @param {import('../core/events.js').PwaEvent} event */
async function save(event) {
  try {
    await runtime().record(event);
  } catch (err) {
    toast(/** @type {Error | undefined} */ (err)?.name === 'QuotaExceededError'
      ? "Couldn't save that: this device is out of storage space."
      : "Couldn't save that on this device. Try again, or export a backup.");
  }
}

/** @param {SubmitEvent} e */
async function addNote(e) {
  e.preventDefault();
  const form = /** @type {HTMLFormElement} */ (e.target);
  const text = /** @type {HTMLInputElement} */ (form.elements.namedItem('text')).value.trim();
  if (!text) return;
  await save(noteAdded(runtime().ctx(), text));
  $('note-text')?.focus();
}

/** @param {ReturnType<typeof listNotes>[number]} n */
const toggle = (n) => save(noteDone(runtime().ctx(), n.noteId, !n.done, { after: n.doneTs }));

/** @param {File} file */
async function importFile(file) {
  try {
    const parsed = parseImport(await file.text(), { format: BACKUP_FORMAT });
    const added = await runtime().importEvents(parsed.events);
    const dupes = parsed.events.length - added.length;
    toast(`Imported ${added.length} events${dupes ? `, ${dupes} already here` : ''}${parsed.skipped ? `, ${parsed.skipped} unreadable` : ''}.`);
  } catch (err) {
    toast(/** @type {Error} */ (err).message);
  }
}

async function copyDiagnostics() {
  const rt = runtime();
  const { store } = rt;
  /** @type {Record<string, unknown>} */
  const meta = {};
  for (const key of ['lastSyncAt', 'lastExportAt', 'serverId', 'pullCursor', 'clockLast', 'rejected']) meta[key] = await store.getMeta(key, null);
  const text = diagnosticsText({
    now: Date.now(), version: APP_VERSION, deviceId: rt.deviceId, storeKind: store.kind,
    persisted: await navigator.storage?.persisted?.(), events: await store.allEvents(),
    outboxCount: await store.outboxCount(), meta, sync: rt.status,
    extra: [['Notes', listNotes(app.notes).length]],
    userAgent: navigator.userAgent, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  try {
    await navigator.clipboard.writeText(text);
    toast('Diagnostics copied.');
  } catch {
    toast("Couldn't copy. Your browser blocked the clipboard.");
  }
}

// ---------- startup ----------

async function init() {
  document.title = APP_NAME;
  const store = await openStore(APP_ID, {
    onVersionChange: () => { $('update-banner').hidden = false; },
  });
  if (store.kind === 'memory') $('storage-warning').hidden = false;
  const rt = await startRuntime({
    store,
    appVersion: APP_VERSION,
    eventVersion: EVENT_VERSION,
    channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(`${APP_ID}-events`) : null,
    onEvents: (events) => {
      for (const e of events) applyEvent(app.notes, e);
      if (app.rt) render();
    },
    onStatus: (s) => {
      app.status = s;
      if (app.rt) renderHeader();
    },
  });
  app.rt = rt;

  $('sync-status').addEventListener('click', () => rt.runSync({ manual: true }));
  $('export-btn').addEventListener('click', () => exportBackup(rt, {
    format: BACKUP_FORMAT, prefix: APP_ID, appVersion: APP_VERSION, today: logicalDay(),
  }));
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    input.value = '';
    if (file) importFile(file);
  });
  $('diagnostics-btn').addEventListener('click', copyDiagnostics);
  setInterval(renderHeader, 30 * 1000); // keep "synced N ago" fresh

  render();
  registerServiceWorker($('update-banner'));
  askPersist(store);
  keepSyncing(rt);
}

init().catch((err) => showFatal($('view'), err));
