// The JS sync client against the real Python server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../app/core/clock.js';
import { createMemoryStore } from '../app/core/memstore.js';
import { createSync } from '../app/core/sync.js';
import { makeBackup, parseImport } from '../app/core/backup.js';
import { noteAdded, noteDone, buildNotes, listNotes } from '../app/js/notes.js';

const SERVER = fileURLToPath(new URL('../server/server.py', import.meta.url));
// The core's server with an authorize hook that knows one login.
const WITH_HOOK = `
import sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('../server', import.meta.url)))})
from pwacore.server import main
main(sys.argv[1:], authorize=lambda h: {"alice@example.com": "alice"}.get(h.get("Tailscale-User-Login")))
`;
const STARTUP_TIMEOUT_MS = 10 * 1000;

/** @typedef {{ proc: import('node:child_process').ChildProcess, base: string }} Server */

/** @type {string} */
let dir;
/** @type {Server} */
let server;

// Start the real server on a free port.
/** @param {string} db @param {{ hook?: boolean }} [opts] @returns {Promise<Server>} */
function startServer(db, { hook = false } = {}) {
  const script = hook ? ['-c', WITH_HOOK] : [SERVER];
  const proc = spawn('python3', [...script, '--port', '0', '--db', db], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${buf}`)), STARTUP_TIMEOUT_MS);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ proc, base: `http://127.0.0.1:${m[1]}` }); }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`couldn't run python3: ${err.message}`)); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${buf}`)); });
  });
  return ready;
}

/** @param {Server | undefined} s */
function stopServer(s) {
  if (!s || s.proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => { s.proc.once('exit', resolve); s.proc.kill(); });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pwacore-it-'));
  server = await startServer(join(dir, 'it.db'));
});

after(async () => {
  await stopServer(server);
  rmSync(dir, { recursive: true, force: true });
});

// base is looked up per request so a test can swap the server underneath.
/** @param {string} id */
function device(id) {
  const clock = createClock();
  const ctx = { clock, deviceId: id, appVersion: 'test', tz: 'UTC' };
  const store = createMemoryStore();
  /** @type {import('../app/core/sync.js').FetchLike} */
  const fetchVia = (url, opts) => fetch(server.base + url, opts);
  return { ctx, store, sync: createSync({ store, clock, fetch: fetchVia }) };
}

test('two devices sync notes through the real server', async () => {
  const phone = device('phone');
  const laptop = device('laptop');
  const added = noteAdded(phone.ctx, 'Book the ferry');
  await phone.store.addEvents([added], { local: true });
  await phone.store.addEvents([noteDone(phone.ctx, added.data.note_id, true)], { local: true });
  await phone.sync.syncOnce();

  const r = await laptop.sync.syncOnce();
  assert.equal(r.pulled.length, 2);
  let [n] = listNotes(buildNotes(await laptop.store.allEvents()));
  assert.equal(n.text, 'Book the ferry');
  assert.equal(n.done, true);

  await laptop.store.addEvents([noteDone(laptop.ctx, n.noteId, false, { after: n.doneTs })], { local: true });
  await laptop.sync.syncOnce();
  await phone.sync.syncOnce();
  [n] = listNotes(buildNotes(await phone.store.allEvents()));
  assert.equal(n.done, false);
  assert.equal((await phone.store.allEvents()).length, 3);
});

test('more than a page of events pushes and pulls in several requests', async () => {
  const a = device('bulk-a');
  const b = device('bulk-b');
  const events = [];
  for (let i = 0; i < 1234; i++) events.push(noteAdded(a.ctx, `bulk ${i}`));
  await a.store.addEvents(events, { local: true });
  const pushed = await a.sync.syncOnce();
  assert.equal(pushed.pushed, 1234);
  assert.equal(pushed.pushError, null);
  const pulled = await b.sync.syncOnce();
  assert.equal(pulled.pulled.filter((e) => e.data.text?.startsWith('bulk ')).length, 1234);
});

test('a replaced server database is repopulated from a device', async () => {
  const phone = device('restart-phone');
  await phone.store.addEvents([noteAdded(phone.ctx, 'restart')], { local: true });
  await phone.sync.syncOnce();
  const countBefore = (await phone.store.allEvents()).length;

  await stopServer(server);
  server = await startServer(join(dir, 'fresh.db')); // new, empty database
  await phone.sync.syncOnce();

  const laptop = device('restart-laptop');
  await laptop.sync.syncOnce();
  assert.equal((await laptop.store.allEvents()).length, countBefore);
});

test('the server serves the app shell', async () => {
  const res = await fetch(`${server.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

test('with an authorize hook, pulls say who sent each event, and devices keep the events as sent', async () => {
  const hooked = await startServer(join(dir, 'hooked.db'), { hook: true });
  try {
    const clock = createClock();
    const store = createMemoryStore();
    const sync = createSync({ store, clock, fetch: (url, opts) => fetch(hooked.base + url, opts) });
    const ctx = { clock, deviceId: 'mac', appVersion: 'test', tz: 'UTC' };
    const fromMac = noteAdded(ctx, 'from this machine');
    await store.addEvents([fromMac], { local: true });
    await sync.syncOnce(); // a local client: no login, no proxy header

    // A tailnet user's push, as tailscale serve passes it on. The event has
    // a field of the same name: an app field, which the server leaves alone.
    const fromAlice = { ...noteAdded({ ...ctx, deviceId: 'phone' }, 'from alice'), received_by: 'owner' };
    const serve = { 'X-Forwarded-For': '100.64.0.7', 'Tailscale-User-Login': 'alice@example.com', 'Content-Type': 'application/json' };
    const pushed = await fetch(`${hooked.base}/api/events`, { method: 'POST', headers: serve, body: JSON.stringify({ events: [fromAlice] }) });
    assert.equal(pushed.status, 200);
    const refused = await fetch(`${hooked.base}/api/events?after=0`, { headers: { ...serve, 'Tailscale-User-Login': 'eve@example.com' } });
    assert.equal(refused.status, 403);

    const page = await (await fetch(`${hooked.base}/api/events?after=0`, { headers: serve })).json();
    assert.deepEqual(page.events, [fromMac, fromAlice]);
    assert.deepEqual(page.received_by, ['local', 'alice']);

    // A second device: sync and a backup round trip keep each event exactly as sent.
    const other = createMemoryStore();
    const r = await createSync({ store: other, clock: createClock(), fetch: (url, opts) => fetch(hooked.base + url, opts) }).syncOnce();
    assert.equal(r.skipped, 0);
    const kept = await other.allEvents();
    assert.deepEqual(kept, [fromMac, fromAlice]);
    const backup = JSON.stringify(makeBackup(kept, { format: 'it-events' }));
    assert.deepEqual(/** @type {any} */ (parseImport(backup, { format: 'it-events' })).events, [fromMac, fromAlice]);
  } finally {
    await stopServer(hooked);
  }
});
