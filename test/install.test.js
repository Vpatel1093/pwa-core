import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCore, coreFiles, VENDORED } from '../tools/install.mjs';
import { checkLock, LOCK_FILE } from '../tools/pwacore/lock.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pwacore-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// A small stand-in for the core, so a test can add and remove core files.
function fakeCore(t, extra = {}) {
  const core = scratch(t);
  put(core, {
    'app/core/version.js': "export const CORE_VERSION = '0.3.0';\n",
    'app/core/a.js': 'export const a = 1;\n',
    'server/pwacore/__init__.py': '',
    'server/pwacore/server.py': 'VERSION = "0.3.0"\n',
    'server/pwacore/__pycache__/server.cpython-313.pyc': 'junk',
    'tools/pwacore/lock.mjs': '// lock\n',
    'app/js/main.js': '// the core example app, not vendored\n',
    ...extra,
  });
  return core;
}

function fakeApp(t) {
  const app = scratch(t);
  put(app, { 'app/js/main.js': '// the app\n', 'server/server.py': '# launcher\n', 'package.json': '{}\n' });
  return app;
}

test('the vendored folders are the core, the core server and the core tools', () => {
  assert.deepEqual(VENDORED, ['app/core', 'server/pwacore', 'tools/pwacore']);
});

test('installCore copies only the vendored folders and leaves the app alone', (t) => {
  const core = fakeCore(t);
  const app = fakeApp(t);
  installCore({ from: core, to: app, source: { commit: null, uncommitted: true } });
  assert.equal(readFileSync(join(app, 'app/core/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.ok(existsSync(join(app, 'server/pwacore/server.py')));
  assert.ok(existsSync(join(app, 'tools/pwacore/lock.mjs')));
  assert.ok(!existsSync(join(app, 'server/pwacore/__pycache__')), 'no bytecode');
  assert.equal(readFileSync(join(app, 'app/js/main.js'), 'utf8'), '// the app\n');
  assert.equal(readFileSync(join(app, 'server/server.py'), 'utf8'), '# launcher\n');
});

test('the lock records the core version, its source state and a hash per file', (t) => {
  const core = fakeCore(t);
  const app = fakeApp(t);
  installCore({ from: core, to: app, source: { commit: null, uncommitted: true } });
  const lock = JSON.parse(readFileSync(join(app, LOCK_FILE), 'utf8'));
  assert.equal(lock.core_version, '0.3.0');
  assert.deepEqual(lock.source, { repo: 'pwa-core', commit: null, uncommitted: true });
  assert.deepEqual(Object.keys(lock.files), [
    'app/core/a.js', 'app/core/version.js', 'server/pwacore/__init__.py', 'server/pwacore/server.py', 'tools/pwacore/lock.mjs',
  ]);
  for (const h of Object.values(lock.files)) assert.match(h, /^[0-9a-f]{64}$/);
  assert.match(lock.tree_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(checkLock(app), []);
});

test('checkLock catches a hand edit, a missing file and an added file', (t) => {
  const app = fakeApp(t);
  installCore({ from: fakeCore(t), to: app, source: { commit: 'abc' } });
  writeFileSync(join(app, 'app/core/a.js'), 'export const a = 2;\n');
  rmSync(join(app, 'tools/pwacore/lock.mjs'));
  put(app, { 'server/pwacore/mine.py': '' });
  assert.deepEqual(checkLock(app), [
    'app/core/a.js was edited by hand: change it in pwa-core and install again',
    'tools/pwacore/lock.mjs is missing',
    'server/pwacore/mine.py is not part of the core: app code goes outside app/core, server/pwacore and tools/pwacore',
  ]);
});

test('checkLock ignores bytecode and dotfiles', (t) => {
  const app = fakeApp(t);
  installCore({ from: fakeCore(t), to: app, source: { commit: 'abc' } });
  put(app, { 'server/pwacore/__pycache__/server.cpython-313.pyc': 'x', 'app/core/.DS_Store': 'x' });
  assert.deepEqual(checkLock(app), []);
});

test('checkLock says so when there is no lock', (t) => {
  assert.deepEqual(checkLock(fakeApp(t)), [`${LOCK_FILE} is missing: install the core with pwa-core's tools/install.mjs`]);
});

test('installing a newer core removes files the core dropped', (t) => {
  const app = fakeApp(t);
  installCore({ from: fakeCore(t, { 'app/core/old.js': '' }), to: app, source: { commit: 'abc' } });
  assert.ok(existsSync(join(app, 'app/core/old.js')));
  installCore({ from: fakeCore(t), to: app, source: { commit: 'def' } });
  assert.ok(!existsSync(join(app, 'app/core/old.js')));
  assert.deepEqual(checkLock(app), []);
});

test('installCore refuses to overwrite hand edits or unknown files', (t) => {
  const app = fakeApp(t);
  const core = fakeCore(t);
  installCore({ from: core, to: app, source: { commit: 'abc' } });
  writeFileSync(join(app, 'app/core/a.js'), 'edited');
  assert.throws(() => installCore({ from: core, to: app, source: { commit: 'abc' } }), /edited by hand/);
  assert.equal(readFileSync(join(app, 'app/core/a.js'), 'utf8'), 'edited', 'nothing changed');
  installCore({ from: core, to: app, source: { commit: 'abc' }, force: true });
  assert.deepEqual(checkLock(app), []);
});

test('installCore refuses vendored folders that hold files and no lock', (t) => {
  const app = fakeApp(t);
  put(app, { 'app/core/mine.js': '' });
  assert.throws(() => installCore({ from: fakeCore(t), to: app, source: {} }), /not part of the core/);
});

test('installCore refuses to install the core into itself', (t) => {
  const core = fakeCore(t);
  assert.throws(() => installCore({ from: core, to: core, source: {} }), /itself/);
});

test('the real core lists every vendored file and no test or example file', () => {
  const files = coreFiles(CORE);
  assert.ok(files.includes('app/core/events.js'));
  assert.ok(files.includes('server/pwacore/server.py'));
  assert.ok(files.includes('tools/pwacore/lock.mjs'));
  assert.ok(files.every((f) => VENDORED.some((d) => f.startsWith(`${d}/`))));
  assert.ok(!files.some((f) => f.includes('__pycache__') || f.includes('test')));
});
