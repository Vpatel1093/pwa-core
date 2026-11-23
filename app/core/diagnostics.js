// Text for Settings > About > Copy diagnostics, to paste into a bug report.
// Only counts, versions, and sync state: never event bodies or scope ids
// (those would tie a report to someone's data). `extra` is the app's own
// [label, value] lines; keep them to counts and settings too.

import { MAX_SKEW_MS } from './clock.js';

const KNOWN_TYPE = /^[a-z]+(\.[a-z]+)*$/;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : 'never');
const tail = (s) => (typeof s === 'string' && s ? `…${s.slice(-6)}` : 'none');
const clip = (s, n) => String(s ?? '').slice(0, n);

export function diagnosticsText({
  now, version, deviceId, storeKind, persisted, events, outboxCount, meta = {}, sync = {}, extra = [], userAgent, tz,
}) {
  const types = new Map();
  let ahead = 0;
  for (const e of events) {
    const type = KNOWN_TYPE.test(e.type) && e.type.length <= 40 ? e.type : 'other';
    types.set(type, (types.get(type) ?? 0) + 1);
    if (e.ts > now + MAX_SKEW_MS) ahead++;
  }
  const byType = [...types].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${t} ${n}`).join(', ');
  const rejected = Array.isArray(meta.rejected) ? meta.rejected : [];

  return [
    `Version: ${version}`,
    `Generated: ${iso(now)}`,
    `Device: ${tail(deviceId)}`,
    `Storage: ${storeKind}, ${persisted ? 'persistent' : 'not persistent'}`,
    `Events: ${events.length}${byType ? ` (${byType})` : ''}`,
    `Waiting to sync: ${outboxCount}`,
    `Last sync: ${iso(meta.lastSyncAt)}`,
    `Sync status: ${sync.status ?? 'unknown'}${sync.error ? ` (${clip(sync.error, 200)})` : ''}`,
    `Server: ${tail(meta.serverId)}, cursor ${meta.pullCursor ?? 0}`,
    `Clock: ${Number.isFinite(meta.clockLast) ? `${meta.clockLast - now} ms from device time` : 'unset'}`,
    `Events stamped more than a day ahead: ${ahead}`,
    `Last export: ${iso(meta.lastExportAt)}`,
    ...(extra ?? []).map(([label, value]) => `${clip(label, 40)}: ${clip(value, 200)}`),
    `Time zone: ${clip(tz, 60)}`,
    `Browser: ${clip(userAgent, 300)}`,
    `Refused by server: ${rejected.length}`,
    ...rejected.map((r) => `  ${clip(r?.id, 40)} ${clip(r?.reason, 80)}`),
  ].join('\n');
}
