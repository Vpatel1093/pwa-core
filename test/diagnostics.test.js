import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../app/core/clock.js';
import { makeEvent } from '../app/core/events.js';
import { diagnosticsText } from '../app/core/diagnostics.js';

const NOW = Date.UTC(2026, 8, 24, 12);
const ctx = { clock: createClock({ now: () => NOW }), deviceId: '0190aaaa-bbbb-7ccc-8ddd-eeeeee123456', appVersion: '0.2.1', tz: 'UTC', now: () => NOW };
const made = makeEvent(ctx, { type: 'trip.created', scope_id: 'trip-secret-id', data: { title: 'Secret trip' } });
const note = makeEvent(ctx, { type: 'note.added', scope_id: made.scope_id, data: { text: 'Private note' } });
const future = { ...makeEvent(ctx, { type: 'note.added', data: { text: 'x' } }), ts: NOW + 3 * 86400000 };

const info = {
  now: NOW,
  version: '0.2.1',
  deviceId: ctx.deviceId,
  storeKind: 'indexeddb',
  persisted: true,
  events: [made, note, future],
  outboxCount: 2,
  meta: {
    lastSyncAt: NOW - 60000,
    lastExportAt: null,
    serverId: 'srv-0123456789abcdef',
    pullCursor: 42,
    clockLast: NOW + 5,
    rejected: [{ id: note.id, reason: 'too large' }],
  },
  sync: { status: 'error', error: 'HTTP 500: server error' },
  extra: [['Trips', 1], ['Settings', 'compact']],
  userAgent: 'TestBrowser/1.0',
  tz: 'America/Chicago',
};

test('diagnostics carry what a sync bug report needs', () => {
  const text = diagnosticsText(info);
  for (const want of [
    'Version: 0.2.1',
    'Device: …123456',
    'Storage: indexeddb, persistent',
    'Events: 3 (note.added 2, trip.created 1)',
    'Waiting to sync: 2',
    'Last sync: 2026-09-24T11:59:00.000Z',
    'Sync status: error (HTTP 500: server error)',
    'Server: …abcdef, cursor 42',
    'Events stamped more than a day ahead: 1',
    `Refused by server: 1\n  ${note.id} too large`,
    'Browser: TestBrowser/1.0',
    'Time zone: America/Chicago',
  ]) assert.ok(text.includes(want), `missing ${JSON.stringify(want)} in:\n${text}`);
});

test('diagnostics add the app\'s own lines', () => {
  const text = diagnosticsText(info);
  assert.ok(text.includes('Trips: 1'));
  assert.ok(text.includes('Settings: compact'));
});

test('diagnostics never include event content or scope ids', () => {
  const text = diagnosticsText(info);
  for (const secret of ['Secret trip', 'Private note', made.scope_id]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test('diagnostics cope with a fresh device and odd event types', () => {
  const text = diagnosticsText({
    ...info,
    events: [{ ...note, type: 'Weird Type with a Label' }],
    storeKind: 'memory',
    persisted: false,
    meta: {},
    extra: undefined,
    sync: { status: 'idle', error: null },
  });
  assert.ok(text.includes('Events: 1 (other 1)'));
  assert.ok(text.includes('Storage: memory, not persistent'));
  assert.ok(text.includes('Last sync: never'));
  assert.ok(text.includes('Refused by server: 0'));
  assert.ok(!text.includes('Weird'));
});
