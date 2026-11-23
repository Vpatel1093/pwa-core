// Last writer wins. "Newest" is ordered by (ts, device_id, id). That order
// is total, so every device reaches the same answer no matter what order
// events arrive in or how often they are replayed.

/** The stamp that orders events (an event, or a keepNewest entry).
 * @typedef {{ ts: number, device_id: string, id: string }} Stamp */

/** @param {Stamp} a @param {Stamp} b */
export function isNewer(a, b) {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.device_id !== b.device_id) return a.device_id > b.device_id;
  return a.id > b.id;
}

// Store `value` under `key` if event `e` beats what is there. The entry keeps
// the winner's stamp next to the value, which is also what an edit passes as
// `after` to makeEvent. Returns true if it stored the value.
/**
 * @template K, V
 * @param {Map<K, Stamp & { value: V }>} map
 * @param {K} key
 * @param {Stamp} e
 * @param {V} value
 */
export function keepNewest(map, key, e, value) {
  const prev = map.get(key);
  if (prev && !isNewer(e, prev)) return false;
  map.set(key, { value, ts: e.ts, device_id: e.device_id, id: e.id });
  return true;
}
