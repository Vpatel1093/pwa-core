// The example app: a shared list of notes you can tick off. It is here to
// show the whole loop (make an event, check its body, fold it into state,
// last writer wins for edits) and to prove sync works between two browsers.
// A new app deletes this file and its test, and writes its own.
//
//   note.added  { note_id, text }   a new note (append only)
//   note.done   { note_id, done }   ticked or not; newest wins per note

import { makeEvent, createEventChecks } from '../core/events.js';
import { keepNewest } from '../core/lww.js';
import { randomId } from '../core/uuid.js';
import { EVENT_VERSION } from './config.js';

export const MAX_NOTE_CHARS = 500;
const NOTE_ID = /^n_[0-9a-z]{8}$/;

/** @typedef {import('../core/events.js').PwaEvent} PwaEvent */
/** @typedef {import('../core/events.js').EventContext} EventContext */
/**
 * @typedef {{
 *   added: Map<string, { text: string, ts: number, id: string }>,
 *   done: Map<string, import('../core/lww.js').Stamp & { value: boolean }>,
 * }} Notes
 */

/** @param {unknown} t */
const isText = (t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_NOTE_CHARS && t === t.trim();

/** @type {Record<string, import('../core/events.js').EventCheck>} */
const BODIES = {
  'note.added': (e) => {
    if (!NOTE_ID.test(e.data.note_id ?? '')) return 'data.note_id';
    return isText(e.data.text) ? null : 'data.text';
  },
  'note.done': (e) => {
    if (!NOTE_ID.test(e.data.note_id ?? '')) return 'data.note_id';
    return typeof e.data.done === 'boolean' ? null : 'data.done';
  },
};

// The types this app makes: an imported bare event list must hold one of them.
export const NOTE_TYPES = Object.keys(BODIES);

export const validateEvent = createEventChecks({ version: EVENT_VERSION, bodies: BODIES });

/** @param {EventContext} ctx @param {string} text */
export function noteAdded(ctx, text) {
  return makeEvent(ctx, { type: 'note.added', data: { note_id: randomId('n'), text: String(text).trim() } });
}

// after: the ts of the done state being replaced (listNotes gives doneTs).
/**
 * @param {EventContext} ctx
 * @param {string} noteId
 * @param {boolean} done
 * @param {{ after?: number }} [opts]
 */
export function noteDone(ctx, noteId, done, { after } = {}) {
  return makeEvent(ctx, { type: 'note.done', data: { note_id: noteId, done }, after });
}

/** @returns {Notes} */
export function createNotes() {
  return { added: new Map(), done: new Map() };
}

// Mutates and returns `state`. Safe to call with the same event twice.
/** @param {Notes} state @param {PwaEvent} e */
export function applyEvent(state, e) {
  if (validateEvent(e) !== null || e.v > EVENT_VERSION) return state;
  if (e.type === 'note.added') {
    if (!state.added.has(e.data.note_id)) state.added.set(e.data.note_id, { text: e.data.text, ts: e.ts, id: e.id });
  } else if (e.type === 'note.done') {
    keepNewest(state.done, e.data.note_id, e, e.data.done);
  }
  return state;
}

/** @param {PwaEvent[]} events */
export function buildNotes(events) {
  const state = createNotes();
  for (const e of events) applyEvent(state, e);
  return state;
}

// Newest first. A note.done that arrived before its note waits in `done`.
/** @param {Notes} state */
export function listNotes(state) {
  return [...state.added]
    .map(([noteId, n]) => {
      const d = state.done.get(noteId);
      return { noteId, text: n.text, ts: n.ts, done: d?.value === true, doneTs: d?.ts ?? 0 };
    })
    .sort((a, b) => b.ts - a.ts || (a.noteId < b.noteId ? 1 : -1));
}
