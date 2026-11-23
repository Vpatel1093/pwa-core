// UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, then random bits.
// Sorts by creation time as a plain string, which keeps logs and indexes tidy.

/** @param {Uint8Array} bytes */
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function uuidv7(ms = Date.now()) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = Math.floor(ms);
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** @param {string} id */
export function uuidv7Time(id) {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

// Short random ids for things inside the data (a note, a stop, a slot).
// Never derive an id from a label: ids are copied into every event and
// events are never rewritten, so a readable id would leak what it names and
// couldn't be taken back. It also lets a rename keep its history.
/** @param {string} prefix */
export function randomId(prefix, length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return `${prefix}_${Array.from(bytes, (b) => ID_CHARS[b % 36]).join('')}`;
}
