// Everything an app knows is an append-only list of events. Events are
// never edited or deleted; state is rebuilt from them by the app.
// Stored events are never migrated either: if a body's shape changes, the
// app bumps its event version and reads the old shape when it builds state.
//
// This file owns the envelope (the fields every event has) and the limits
// the server shares. What goes in `data` for each type belongs to the app,
// which passes its body checks to createEventChecks.

import { uuidv7 } from './uuid.js';

/**
 * An event as stored and synced. `data` is the app's body for its type, so
 * its shape is the app's to check (createEventChecks). Other top-level
 * fields are the app's own (Mandalart's cell_id and day): unknown here, so
 * an app narrows them before use.
 * @typedef {{
 *   id: string,
 *   v: number,
 *   type: string,
 *   scope_id?: string,
 *   ts: number,
 *   tz?: string,
 *   device_id: string,
 *   app_version?: string,
 *   data: Record<string, any>,
 *   [field: string]: unknown,
 * }} PwaEvent
 */

/**
 * What makeEvent needs from the runtime (rt.ctx()).
 * @typedef {{
 *   clock: import('./clock.js').Clock,
 *   deviceId: string,
 *   appVersion?: string,
 *   tz?: string,
 *   now?: () => number,
 *   eventVersion?: number,
 * }} EventContext
 */

/** Returns null when the event is fine, or a short reason.
 * @typedef {(e: any) => string | null} EventCheck */

// Same limits as server/server.py (a test checks they match). Checking them
// here means an event the server would refuse is never made or imported.
export const MAX_ID_LEN = 100;
export const MAX_EVENT_BYTES = 64 * 1024;

const MAX_TS = Number.MAX_SAFE_INTEGER;
/** @param {unknown} v @returns {v is string} */
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
/** @param {unknown} v @returns {v is string} */
const isId = (v) => isNonEmptyString(v) && v.length <= MAX_ID_LEN;
/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// How many objects and arrays deep an event may go (the event itself is 1,
// data is 2). The server has the same limit.
export const MAX_DEPTH = 32;

// 'depth' if the event nests too deep, 'text' if it holds a lone surrogate
// (half an emoji: it survives JSON in JS but can't be stored as UTF-8, so the
// server refuses it), else null. A loop, not recursion: a deeply nested event
// from the server must get a reason (sync skips it), not a stack overflow
// that stops every pull at that page.
/** @param {unknown} root @returns {'depth' | 'text' | null} */
function checkShape(root) {
  /** @type {[unknown, number][]} */
  const todo = [[root, 1]];
  while (todo.length) {
    const [v, depth] = /** @type {[unknown, number]} */ (todo.pop());
    if (typeof v === 'string') {
      if (LONE_SURROGATE.test(v)) return 'text';
    } else if (v !== null && typeof v === 'object') {
      if (depth > MAX_DEPTH) return 'depth';
      const isArray = Array.isArray(v);
      for (const [k, x] of Object.entries(v)) {
        if (!isArray && LONE_SURROGATE.test(k)) return 'text';
        todo.push([x, depth + 1]);
      }
    }
  }
  return null;
}

/** @param {unknown} e */
export function eventBytes(e) {
  return new TextEncoder().encode(JSON.stringify(e)).length;
}

// ctx: { clock, deviceId, appVersion, tz, now?, eventVersion? }
// scope_id: optional. The thing an event belongs to (a trip, a chart), when
// the app has one. Leave it out rather than invent one.
// fields: optional top-level fields the app owns (Mandalart's cell_id and
// day). Undefined ones are left out. They can't replace an envelope field.
// after: ts of the event this one replaces. The new event is stamped past it
// so an edit made on top of what you see wins, even when that event came
// from a device whose clock was days ahead (which the clock won't follow).
const ENVELOPE = new Set(['id', 'v', 'type', 'scope_id', 'ts', 'tz', 'device_id', 'app_version', 'data']);

/**
 * @param {EventContext} ctx
 * @param {{ type: string, scope_id?: string, fields?: Record<string, unknown>, data?: Record<string, any>, after?: number }} spec
 * @returns {PwaEvent}
 */
export function makeEvent(ctx, { type, scope_id, fields = {}, data = {}, after = 0 }) {
  for (const name of Object.keys(fields)) {
    if (ENVELOPE.has(name)) throw new Error(`makeEvent: ${name} is an envelope field, not an app field`);
  }
  const ts = Math.max(ctx.clock.tick(), Math.min(after + 1, MAX_TS));
  /** @type {Record<string, unknown>} */
  const e = { id: uuidv7(ctx.now ? ctx.now() : Date.now()), v: ctx.eventVersion ?? 1, type };
  if (scope_id !== undefined) e.scope_id = scope_id;
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) e[name] = value;
  Object.assign(e, { ts, tz: ctx.tz, device_id: ctx.deviceId, app_version: ctx.appVersion, data: structuredClone(data) });
  return /** @type {PwaEvent} */ (e);
}

// The fields every event needs, whatever its type or version. Sync and
// import keep any event that passes this, even one whose body this version
// can't read: a later version may read it, and skipping it would move the
// pull cursor past it for good. Returns null, or a short reason.
/** @param {any} e @returns {string | null} */
export function validateEnvelope(e) {
  if (!isPlainObject(e)) return 'event must be an object';
  if (!isId(e.id)) return 'id';
  if (!Number.isInteger(e.v) || e.v < 1) return 'v';
  if (!isNonEmptyString(e.type)) return 'type';
  if (e.scope_id !== undefined && !isId(e.scope_id)) return 'scope_id';
  if (!Number.isSafeInteger(e.ts) || e.ts < 0) return 'ts';
  if (!isId(e.device_id)) return 'device_id';
  if (!isPlainObject(e.data)) return 'data';
  const shape = checkShape(e);
  if (shape !== null) return shape;
  if (eventBytes(e) > MAX_EVENT_BYTES) return 'size';
  return null;
}

// The app's validateEvent: the envelope, then the body check for its type.
// bodies: { [type]: (event) => null | reason }. Unknown types and events
// from a newer version pass as long as the envelope is sound, so a newer
// app's events still sync through this one. State code uses this to decide
// what it reads; sync and import only use validateEnvelope.
/**
 * @param {{ version?: number, bodies?: Record<string, EventCheck> }} [opts]
 * @returns {EventCheck}
 */
export function createEventChecks({ version = 1, bodies = {} } = {}) {
  return function validateEvent(e) {
    const bad = validateEnvelope(e);
    if (bad !== null) return bad;
    if (e.v > version) return null; // from the future; keep it, don't judge the body
    const check = Object.hasOwn(bodies, e.type) ? bodies[e.type] : null;
    if (!check) return null;
    try {
      return check(e);
    } catch (err) {
      return `${e.type}: ${/** @type {any} */ (err)?.message ?? err}`;
    }
  };
}

/** @param {Iterable<{ ts?: unknown }>} events */
export function maxTs(events) {
  let m = 0;
  for (const e of events) if (typeof e.ts === 'number' && e.ts > m) m = e.ts;
  return m;
}
