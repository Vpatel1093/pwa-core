// The app's identity. A new app edits this file first, then the matching
// values in sw.js, manifest.webmanifest and the <title> in index.html
// (test/shell.test.js checks they agree; tools/new-app.mjs sets them all).

// Shown to people. Safe to change any time.
export const APP_NAME = 'PWA Core Demo';

// Storage id: the IndexedDB name, the service worker cache prefix, the tab
// channel and the backup format all come from it. Changing it after people
// have data starts them on an empty database, so pick it once and keep it
// even if APP_NAME changes. Lowercase letters, digits and dashes.
export const APP_ID = 'pwacore-demo';

// Bump on every release, with VERSION in sw.js.
export const APP_VERSION = '0.1.0';

// The version of this app's event bodies (the `v` field). Bump it only when
// a body's shape changes, and teach state code to read the old shape.
export const EVENT_VERSION = 1;

export const BACKUP_FORMAT = `${APP_ID}-events`;
