// Text for Settings > About > Copy diagnostics, to paste into a bug report.
// Only counts, versions, and sync state: never event bodies or scope ids
// (those would tie a report to someone's data). `extra` is the app's own
// [label, value] lines; keep them to counts and settings too.

import { MAX_SKEW_MS } from './clock.js';

const MAX_REJECTED_SHOWN = 20; // the list is kept whole; the report shows the first ones
const KNOWN_TYPE = /^[a-z]+(\.[a-z]+)*$/;
/** @param {unknown} ms */
const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : 'never');
/** @param {unknown} s */
const tail = (s) => (typeof s === 'string' && s ? `…${s.slice(-6)}` : 'none');
/** @param {unknown} s @param {number} n */
const clip = (s, n) => String(s ?? '').slice(0, n);

/**
 * meta: the store's meta values (lastSyncAt, serverId, pullCursor,
 * clockLast, lastExportAt, rejected). sync: the runtime's status.
 * @param {{
 *   now: number,
 *   version: string,
 *   deviceId?: string | null,
 *   storeKind: string,
 *   persisted?: boolean,
 *   events: { type: string, ts: number }[],
 *   outboxCount: number,
 *   meta?: Record<string, any>,
 *   sync?: { status?: string, error?: string | null },
 *   extra?: [string, unknown][] | null,
 *   userAgent?: string,
 *   tz?: string,
 * }} info
 */
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
    ...rejected.slice(0, MAX_REJECTED_SHOWN).map((r) => `  ${clip(r?.id, 40)} ${clip(r?.reason, 80)}`),
    ...(rejected.length > MAX_REJECTED_SHOWN ? [`  and ${rejected.length - MAX_REJECTED_SHOWN} more`] : []),
  ].join('\n');
}
