import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../../app/core/clock.js';
import { makeEvent } from '../../app/core/events.js';
import { makeBackup, parseImport, backupFilename } from '../../app/core/backup.js';

const FORMAT = 'demo-events';
const TYPES = ['note.added', 'note.done'];
const ctx = { clock: createClock(), deviceId: 'd', appVersion: '0.1.0', tz: 'UTC' };
const events = [makeEvent(ctx, { type: 'note.added', data: { text: 'a' } }), makeEvent(ctx, { type: 'note.added', data: { text: 'b' } })];
const NOW = new Date('2026-09-23T12:00:00Z');

test('a backup round-trips through parseImport', () => {
  const text = JSON.stringify(makeBackup(events, { format: FORMAT, appVersion: '0.1.0', now: NOW }));
  const parsed = parseImport(text, { format: FORMAT });
  assert.equal(parsed.kind, 'events');
  assert.deepEqual(parsed.events, events);
  assert.equal(parsed.skipped, 0);
});

test('makeBackup records format, version, and export time', () => {
  const b = makeBackup(events, { format: FORMAT, appVersion: '0.1.0', now: NOW });
  assert.equal(b.format, FORMAT);
  assert.equal(b.format_version, 1);
  assert.equal(b.exported_at, '2026-09-23T12:00:00.000Z');
  assert.equal(b.app_version, '0.1.0');
  assert.equal(b.events.length, 2);
});

test('makeBackup needs a format name, so apps cannot mix up each other\'s files', () => {
  assert.throws(() => makeBackup(events, { appVersion: '0.1.0' }), /format/);
  assert.throws(() => parseImport('[]', {}), /format/);
});

test('parseImport accepts a bare event array and JSON lines', () => {
  assert.equal(parseImport(JSON.stringify(events), { format: FORMAT, types: TYPES }).events.length, 2);
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  assert.equal(parseImport(jsonl, { format: FORMAT, types: TYPES }).events.length, 2);
});

test("a bare list carries no format name, so parseImport checks its event types are the app's", () => {
  const other = [makeEvent(ctx, { type: 'trip.stop_added', data: {} }), makeEvent(ctx, { type: 'trip.renamed', data: {} })];
  assert.throws(() => parseImport(JSON.stringify(other), { format: FORMAT, types: TYPES }), /another app/);
  assert.throws(() => parseImport(other.map((e) => JSON.stringify(e)).join('\n'), { format: FORMAT, types: TYPES }), /another app/);
  // A newer version's new type next to known ones is fine.
  const mixed = [...events, makeEvent(ctx, { type: 'note.pinned', data: {} })];
  assert.equal(parseImport(JSON.stringify(mixed), { format: FORMAT, types: TYPES }).events.length, 3);
  assert.equal(parseImport('[]', { format: FORMAT, types: TYPES }).events.length, 0, 'an empty list holds nothing to mix up');
  assert.throws(() => parseImport(JSON.stringify(events), { format: FORMAT }), /types/, 'an app that does not say its types cannot import a bare list');
});

test('parseImport skips invalid events and counts them', () => {
  const parsed = parseImport(JSON.stringify([...events, { id: 'x' }, 'junk']), { format: FORMAT, types: TYPES });
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.skipped, 2);
});

test('parseImport keeps events with a sound envelope even if this version can\'t read the body', () => {
  const odd = { ...events[0], id: 'odd-1', v: 9, data: { shape: 'from the future' } };
  const parsed = parseImport(JSON.stringify([odd]), { format: FORMAT, types: TYPES });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.skipped, 0);
});

test('parseImport hands other files to the app\'s recognize hook', () => {
  /** @param {any} data */
  const recognize = (data) => (Array.isArray(data?.stops) ? { kind: 'trip', trip: data } : null);
  const parsed = parseImport(JSON.stringify({ stops: ['Lisbon'] }), { format: FORMAT, recognize });
  assert.deepEqual(parsed, { kind: 'trip', trip: { stops: ['Lisbon'] } });
  assert.throws(() => parseImport('{"hello": 1}', { format: FORMAT, recognize }), /recognize/);
  assert.throws(() => parseImport('{"hello": 1}', { format: FORMAT, recognize, expected: 'a backup or a trip' }),
    /^Error: Didn't recognize this file\. Expected a backup or a trip\.$/);
});

test('parseImport refuses another app\'s backup', () => {
  const other = JSON.stringify(makeBackup(events, { format: 'other-events', appVersion: '1', now: NOW }));
  assert.throws(() => parseImport(other, { format: FORMAT }), /another app/);
});

test('parseImport rejects things it cannot read', () => {
  assert.throws(() => parseImport('not json at all {', { format: FORMAT }), /read/);
  assert.throws(() => parseImport('{"hello": 1}', { format: FORMAT }), /recognize/);
  assert.throws(() => parseImport(`{"format": "${FORMAT}", "format_version": 99, "events": []}`, { format: FORMAT }), /newer/);
  assert.throws(() => parseImport('', { format: FORMAT }), /empty/);
});

test('backupFilename uses the app prefix and the local date', () => {
  assert.equal(backupFilename('demo', '2026-09-23'), 'demo-backup-2026-09-23.json');
});
