// A database restored from a backup without --new-server-id, against the
// real server (this app's server/server.py): a device whose cursor now
// names another event must notice and start over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../app/core/clock.js';
import { makeEvent } from '../../app/core/events.js';
import { createMemoryStore } from '../../app/core/memstore.js';
import { createSync } from '../../app/core/sync.js';

const SERVER = fileURLToPath(new URL('../../server/server.py', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'pwacore-restore-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** @typedef {{ proc: import('node:child_process').ChildProcess, base: string }} Server */

/** @param {string} db @returns {Promise<Server>} */
function startServer(db) {
  const proc = spawn('python3', [SERVER, '--port', '0', '--db', db], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${buf}`)), 10 * 1000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ proc, base: `http://127.0.0.1:${m[1]}` }); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${buf}`)); });
  });
}

/** @param {Server} s @returns {Promise<void>} */
function stopServer(s) {
  if (s.proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => { s.proc.once('exit', () => resolve()); s.proc.kill(); });
}

// A file copy with its -wal and -shm, as the server was stopped.
/** @param {string} from @param {string} to */
function copyDb(from, to) {
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(from + ext)) copyFileSync(from + ext, to + ext);
    else rmSync(to + ext, { force: true });
  }
}

test('a device catches a backup restored without --new-server-id, after new events pass its cursor', async () => {
  /** @type {Server} */
  let server;
  /** @param {string} id */
  const device = (id) => {
    const clock = createClock();
    const ctx = { clock, deviceId: id, appVersion: 'test', tz: 'UTC' };
    const store = createMemoryStore();
    /** @type {import('../../app/core/sync.js').FetchLike} */
    const fetchVia = (url, opts) => fetch(server.base + url, opts);
    /** @param {string} key */
    const add = (key) => store.addEvents([makeEvent(ctx, { type: 'x.add', data: { key } })], { local: true });
    return { store, add, sync: createSync({ store, clock, fetch: fetchVia }) };
  };
  const db = join(dir, 'live.db');
  const backup = join(dir, 'backup.db');
  const a = device('a');
  const b = device('b');
  const c = device('c');

  server = await startServer(db);
  await a.add('k1');
  await a.sync.syncOnce();
  await stopServer(server);
  copyDb(db, backup); // the backup holds k1

  server = await startServer(db);
  await a.add('k2');
  await a.add('k3');
  await a.sync.syncOnce();
  await b.sync.syncOnce(); // b's cursor: 3
  await stopServer(server);

  copyDb(backup, db); // restored, same server id
  server = await startServer(db);
  try {
    for (const k of ['k5', 'k6', 'k7']) await c.add(k);
    await c.sync.syncOnce(); // head is 4, past b's cursor
    const r = await b.sync.syncOnce();
    assert.equal(r.pushError, null);
    const keys = (await b.store.allEvents()).map((e) => e.data.key).sort();
    assert.deepEqual(keys, ['k1', 'k2', 'k3', 'k5', 'k6', 'k7'], 'b has the events stored after the restore');
    const fresh = device('fresh');
    await fresh.sync.syncOnce();
    const onServer = (await fresh.store.allEvents()).map((e) => e.data.key).sort();
    assert.deepEqual(onServer, ['k1', 'k2', 'k3', 'k5', 'k6', 'k7'], 'b pushed back what the backup lost');
  } finally {
    await stopServer(server);
  }
});
