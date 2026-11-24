// In an app, app/core, server/pwacore and tools/pwacore are a vendored copy
// of pwa-core and must match core.lock.json. Never edit them in the app:
// make the fix in pwa-core and install it again
// (in pwa-core: npm run install-into -- <the app's folder>).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLock } from '../../tools/pwacore/lock.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('the vendored core matches core.lock.json', (t) => {
  // pwa-core itself is the source, not a copy (only it has install.mjs).
  if (existsSync(join(root, 'tools/install.mjs'))) return t.skip('this is pwa-core itself');
  assert.deepEqual(checkLock(root), []);
});
