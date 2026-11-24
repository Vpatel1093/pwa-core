import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, syncLabel } from '../../app/core/format.js';

test('ago: coarse, human, never negative', () => {
  const now = 1_000_000_000;
  assert.equal(ago(now - 5_000, now), 'just now');
  assert.equal(ago(now + 5_000, now), 'just now');
  assert.equal(ago(now - 60_000, now), '1m ago');
  assert.equal(ago(now - 59 * 60_000, now), '59m ago');
  assert.equal(ago(now - 2 * 3600_000, now), '2h ago');
  assert.equal(ago(now - 3 * 86400_000, now), '3d ago');
  assert.equal(ago(null, now), 'never');
});

test('syncLabel: what the header says about sync', () => {
  const now = 10 * 86400_000;
  const base = { status: 'idle', lastSyncAt: now - 2 * 3600_000, pending: 0, error: null, manual: false };
  /** @param {Partial<Parameters<typeof syncLabel>[0]>} s */
  const label = (s) => syncLabel({ ...base, ...s }, now);
  assert.equal(label({ manual: true, status: 'offline' }).text, 'Syncing…');
  assert.equal(label({}).text, 'Synced 2h ago');
  assert.equal(label({ lastSyncAt: null }).text, 'Not synced yet');
  assert.equal(label({ status: 'error' }).text, 'Sync problem · see Settings');
  // A failed request says what happened, not that the device is offline.
  assert.equal(label({ status: 'offline' }).text, "Can't reach server · synced 2h ago");
  assert.equal(label({ status: 'offline', pending: 3 }).text, "3 not synced · can't reach server");
});

test('syncLabel: changes waiting over a day get a quiet cue with words for screen readers', () => {
  const now = 10 * 86400_000;
  const s = { status: 'offline', pending: 2, lastSyncAt: now - 25 * 3600_000, error: null, manual: false };
  const r = syncLabel(s, now);
  assert.equal(r.stale, true);
  assert.equal(r.label, "2 not synced · can't reach server. Waiting more than a day. Sync now");
  assert.equal(syncLabel({ ...s, lastSyncAt: null }, now).stale, true, 'never synced counts');
  assert.equal(syncLabel({ ...s, pending: 0 }, now).stale, false, 'nothing waiting');
  assert.equal(syncLabel({ ...s, lastSyncAt: now - 3600_000 }, now).stale, false, 'recent sync');
  assert.equal(syncLabel({ ...s, lastSyncAt: now - 3600_000 }, now).label, "2 not synced · can't reach server. Sync now");
});
