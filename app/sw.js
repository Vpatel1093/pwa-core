// Offline app shell. Bump VERSION (and APP_VERSION in js/config.js) on
// every release: the new worker installs alongside the old one and the page
// offers a reload, so an update never swaps code under an open page.
// The API is never cached; sync handles being offline.

// Same as APP_ID in js/config.js (a test checks). Never change it once
// people have the app installed: caches are named after it.
const APP_ID = 'pwacore-demo';
const VERSION = '0.1.0';
const CACHE = `${APP_ID}-${VERSION}`;
// Every file under app/ except this one (a test checks).
const ASSETS = [
  './',
  'core/backup.js',
  'core/clock.js',
  'core/days.js',
  'core/diagnostics.js',
  'core/dom.js',
  'core/events.js',
  'core/format.js',
  'core/idbstore.js',
  'core/lww.js',
  'core/memstore.js',
  'core/runtime.js',
  'core/shell.js',
  'core/sync.js',
  'core/uuid.js',
  'core/version.js',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'index.html',
  'js/config.js',
  'js/main.js',
  'js/notes.js',
  'manifest.webmanifest',
];

// The worker's global, typed for tsconfig.sw.json (the WebWorker lib types
// `self` as a plain worker).
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(`${APP_ID}-`) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== sw.location.origin) return;
  if (url.pathname.includes('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
