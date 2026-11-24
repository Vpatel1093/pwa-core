// Guards for the offline shell: the service worker must cache every app
// file, and the app's name, storage id and versions must agree everywhere
// they are written down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { APP_NAME, APP_ID, APP_VERSION } from '../app/js/config.js';

const APP = new URL('../app/', import.meta.url).pathname;
const sw = readFileSync(join(APP, 'sw.js'), 'utf8');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [relative(APP, p)];
  });
}

test('service worker version matches the app version', () => {
  const m = /const VERSION = '([^']+)'/.exec(sw);
  assert.equal(m?.[1], APP_VERSION);
});

test('service worker storage id matches the app', () => {
  assert.equal(/const APP_ID = '([^']+)'/.exec(sw)?.[1], APP_ID);
});

test("the app's server launcher names the same app id, so its database refuses another app", () => {
  const py = readFileSync(new URL('../server/server.py', import.meta.url), 'utf8');
  assert.equal(/^APP_ID = "([^"]+)"/m.exec(py)?.[1], APP_ID);
  assert.match(py, /app_id=APP_ID/);
});

test("the app's server launcher names its port and passes it to the core", () => {
  const py = readFileSync(new URL('../server/server.py', import.meta.url), 'utf8');
  assert.match(py, /^PORT = \d+\b/m);
  assert.match(py, /port=PORT/);
});

test("the app's server launcher reports the app version", () => {
  const py = readFileSync(new URL('../server/server.py', import.meta.url), 'utf8');
  assert.equal(/^APP_VERSION = "([^"]+)"/m.exec(py)?.[1], APP_VERSION);
});

test('storage id is a safe, stable name', () => {
  assert.match(APP_ID, /^[a-z][a-z0-9-]{1,39}$/);
});

test('manifest and page use the app name and storage id', () => {
  const manifest = JSON.parse(readFileSync(join(APP, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, APP_ID, 'an explicit id keeps installs the same app if start_url moves');
  assert.equal(manifest.name, APP_NAME);
  const html = readFileSync(join(APP, 'index.html'), 'utf8');
  /** @param {string | undefined} s */
  const text = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(text(/<title>([^<]*)<\/title>/.exec(html)?.[1]), APP_NAME);
  assert.equal(text(/name="apple-mobile-web-app-title" content="([^"]*)"/.exec(html)?.[1]), APP_NAME);
});

test('service worker caches every app file', () => {
  const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
  const files = walk(APP).filter((f) => f !== 'sw.js' && !f.startsWith('.') && !f.includes('/.'));
  const missing = files.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `add these to ASSETS in sw.js: ${missing.join(', ')}`);
  const stale = [...listed].filter((f) => f !== './' && !files.includes(f));
  assert.deepEqual(stale, [], `remove these from ASSETS in sw.js: ${stale.join(', ')}`);
});

test('manifest icons exist', () => {
  const manifest = JSON.parse(readFileSync(join(APP, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(statSync(join(APP, icon.src)).isFile(), icon.src);
});
