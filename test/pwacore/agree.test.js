// The browser core and the Python server state some things twice (the
// version, the event limits). These tests keep the two copies in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_VERSION } from '../../app/core/version.js';
import { MAX_ID_LEN, MAX_EVENT_BYTES, MAX_DEPTH } from '../../app/core/events.js';

test('server version matches the core version', () => {
  const py = readFileSync(new URL('../../server/pwacore/server.py', import.meta.url), 'utf8');
  assert.equal(/^VERSION = "([^"]+)"/m.exec(py)?.[1], CORE_VERSION);
});

test('client and server agree on event limits', () => {
  const py = readFileSync(new URL('../../server/pwacore/server.py', import.meta.url), 'utf8');
  /** @param {string} name */
  const num = (name) => {
    const expr = String(new RegExp(`^${name} = ([0-9* ]+)`, 'm').exec(py)?.[1]);
    return expr.split('*').reduce((a, b) => a * Number(b.trim()), 1);
  };
  assert.equal(num('MAX_ID_LEN'), MAX_ID_LEN);
  assert.equal(num('MAX_EVENT_BYTES'), MAX_EVENT_BYTES);
  assert.equal(num('MAX_DEPTH'), MAX_DEPTH);
});
