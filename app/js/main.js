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

const $ = (id) => document.getElementById(id);
const app = { rt: null, notes: createNotes(), status: null };

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- render ----------

function renderHeader() {
  const s = app.status ?? app.rt.status;
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

async function save(event) {
  try {
    await app.rt.record(event);
  } catch (err) {
    toast(err?.name === 'QuotaExceededError'
      ? "Couldn't save that: this device is out of storage space."
      : "Couldn't save that on this device. Try again, or export a backup.");
  }
}

async function addNote(e) {
  e.preventDefault();
  const text = e.target.elements.text.value.trim();
  if (!text) return;
  await save(noteAdded(app.rt.ctx(), text));
  $('note-text')?.focus();
}

const toggle = (n) => save(noteDone(app.rt.ctx(), n.noteId, !n.done, { after: n.doneTs }));

async function importFile(file) {
  try {
    const parsed = parseImport(await file.text(), { format: BACKUP_FORMAT });
    const added = await app.rt.importEvents(parsed.events);
    const dupes = parsed.events.length - added.length;
    toast(`Imported ${added.length} events${dupes ? `, ${dupes} already here` : ''}${parsed.skipped ? `, ${parsed.skipped} unreadable` : ''}.`);
  } catch (err) {
    toast(err.message);
  }
}

async function copyDiagnostics() {
  const { store } = app.rt;
  const meta = {};
  for (const key of ['lastSyncAt', 'lastExportAt', 'serverId', 'pullCursor', 'clockLast', 'rejected']) meta[key] = await store.getMeta(key, null);
  const text = diagnosticsText({
    now: Date.now(), version: APP_VERSION, deviceId: app.rt.deviceId, storeKind: store.kind,
    persisted: await navigator.storage?.persisted?.(), events: await store.allEvents(),
    outboxCount: await store.outboxCount(), meta, sync: app.rt.status,
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
  app.rt = await startRuntime({
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

  $('sync-status').addEventListener('click', () => app.rt.runSync({ manual: true }));
  $('export-btn').addEventListener('click', () => exportBackup(app.rt, {
    format: BACKUP_FORMAT, prefix: APP_ID, appVersion: APP_VERSION, today: logicalDay(),
  }));
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });
  $('diagnostics-btn').addEventListener('click', copyDiagnostics);
  setInterval(renderHeader, 30 * 1000); // keep "synced N ago" fresh

  render();
  registerServiceWorker($('update-banner'));
  askPersist(store);
  keepSyncing(app.rt);
}

init().catch((err) => showFatal($('view'), err));
