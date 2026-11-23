// Export is the full event log. Import takes a backup, a bare event list,
// or JSON lines. Any other file goes to the app's `recognize` hook (for
// example a starter file the app can turn into events).

import { validateEnvelope } from './events.js';

export const BACKUP_VERSION = 1;

/** @typedef {import('./events.js').PwaEvent} PwaEvent */
/** What parseImport returns for a list of events. An app's recognize hook
 * can return its own kinds.
 * @typedef {{ kind: 'events', events: PwaEvent[], skipped: number }} EventsImport */

// format: the app's own name for its backups, such as "trips-events". It
// keeps one app from importing another app's file as its own.
/** @param {unknown} format @returns {asserts format is string} */
function needFormat(format) {
  if (typeof format !== 'string' || !format) throw new Error('A backup format name is required.');
}

/**
 * @param {PwaEvent[]} events
 * @param {{ format?: string, appVersion?: string, now?: Date }} [opts]
 */
export function makeBackup(events, { format, appVersion, now = new Date() } = {}) {
  needFormat(format);
  return {
    format,
    format_version: BACKUP_VERSION,
    exported_at: now.toISOString(),
    app_version: appVersion,
    events,
  };
}

/** @param {string} prefix @param {string} today */
export function backupFilename(prefix, today) {
  return `${prefix}-backup-${today}.json`;
}

/** @param {unknown[]} list @returns {EventsImport} */
function eventsResult(list) {
  /** @type {PwaEvent[]} */
  const events = [];
  let skipped = 0;
  for (const e of list) {
    if (validateEnvelope(e) === null) events.push(/** @type {PwaEvent} */ (e)); // the envelope checks passed
    else skipped++;
  }
  return { kind: 'events', events, skipped };
}

// recognize(data): return a result for a file the app knows, or null.
// expected: what the error names when nothing fits ("a backup or a chart").
/**
 * @template [R=never]
 * @param {unknown} text
 * @param {{ format?: string, recognize?: (data: any) => R | null, expected?: string }} [opts]
 * @returns {EventsImport | R}
 */
export function parseImport(text, { format, recognize = () => null, expected = 'a backup' } = {}) {
  needFormat(format);
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('The file is empty.');
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Maybe JSON lines: one event per line.
    try {
      data = trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      throw new Error("Couldn't read the file as JSON.");
    }
  }
  if (Array.isArray(data)) return eventsResult(data);
  if (data && data.format === format) {
    if (data.format_version > BACKUP_VERSION) throw new Error('This backup is from a newer version of the app.');
    return eventsResult(Array.isArray(data.events) ? data.events : []);
  }
  if (data && typeof data.format === 'string' && data.format.endsWith('-events')) {
    throw new Error('This backup is from another app.');
  }
  const known = recognize(data);
  if (known) return known;
  throw new Error(`Didn't recognize this file. Expected ${expected}.`);
}
