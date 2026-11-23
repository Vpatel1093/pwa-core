// Everything an app knows is an append-only list of events. Events are
// never edited or deleted; state is rebuilt from them by the app.
// Stored events are never migrated either: if a body's shape changes, the
// app bumps its event version and reads the old shape when it builds state.
//
// This file owns the envelope (the fields every event has) and the limits
// the server shares. What goes in `data` for each type belongs to the app,
// which passes its body checks to createEventChecks.

import { uuidv7 } from './uuid.js';

// Same limits as server/server.py (a test checks they match). Checking them
// here means an event the server would refuse is never made or imported.
export const MAX_ID_LEN = 100;
export const MAX_EVENT_BYTES = 64 * 1024;

const MAX_TS = Number.MAX_SAFE_INTEGER;
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const isId = (v) => isNonEmptyString(v) && v.length <= MAX_ID_LEN;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// A lone surrogate (half an emoji) survives JSON in JS but can't be stored
// as UTF-8, so the server refuses it.
function hasLoneSurrogate(v) {
  if (typeof v === 'string') return LONE_SURROGATE.test(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => LONE_SURROGATE.test(k) || hasLoneSurrogate(x));
  return false;
}

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

export function makeEvent(ctx, { type, scope_id, fields = {}, data = {}, after = 0 }) {
  for (const name of Object.keys(fields)) {
    if (ENVELOPE.has(name)) throw new Error(`makeEvent: ${name} is an envelope field, not an app field`);
  }
  const ts = Math.max(ctx.clock.tick(), Math.min(after + 1, MAX_TS));
  const e = { id: uuidv7(ctx.now ? ctx.now() : Date.now()), v: ctx.eventVersion ?? 1, type };
  if (scope_id !== undefined) e.scope_id = scope_id;
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) e[name] = value;
  Object.assign(e, { ts, tz: ctx.tz, device_id: ctx.deviceId, app_version: ctx.appVersion, data: structuredClone(data) });
  return e;
}

// The fields every event needs, whatever its type or version. Sync and
// import keep any event that passes this, even one whose body this version
// can't read: a later version may read it, and skipping it would move the
// pull cursor past it for good. Returns null, or a short reason.
export function validateEnvelope(e) {
  if (!isPlainObject(e)) return 'event must be an object';
  if (!isId(e.id)) return 'id';
  if (!Number.isInteger(e.v) || e.v < 1) return 'v';
  if (!isNonEmptyString(e.type)) return 'type';
  if (e.scope_id !== undefined && !isId(e.scope_id)) return 'scope_id';
  if (!Number.isSafeInteger(e.ts) || e.ts < 0) return 'ts';
  if (!isId(e.device_id)) return 'device_id';
  if (!isPlainObject(e.data)) return 'data';
  if (hasLoneSurrogate(e)) return 'text';
  if (eventBytes(e) > MAX_EVENT_BYTES) return 'size';
  return null;
}

// The app's validateEvent: the envelope, then the body check for its type.
// bodies: { [type]: (event) => null | reason }. Unknown types and events
// from a newer version pass as long as the envelope is sound, so a newer
// app's events still sync through this one. State code uses this to decide
// what it reads; sync and import only use validateEnvelope.
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
      return `${e.type}: ${err?.message ?? err}`;
    }
  };
}

export function maxTs(events) {
  let m = 0;
  for (const e of events) if (typeof e.ts === 'number' && e.ts > m) m = e.ts;
  return m;
}
