// Tests for the example app. A new app replaces js/notes.js and this file
// with its own state code and tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../app/core/clock.js';
import { noteAdded, noteDone, validateEvent, buildNotes, applyEvent, listNotes, MAX_NOTE_CHARS } from '../app/js/notes.js';

const ctx = (deviceId = 'dev-a', t = 1000) => ({ clock: createClock({ now: () => t }), deviceId, appVersion: 't', tz: 'UTC', now: () => t });

test('noteAdded makes a valid event with a trimmed text and its own note id', () => {
  const e = noteAdded(ctx(), '  Pack the charger  ');
  assert.equal(e.type, 'note.added');
  assert.equal(e.data.text, 'Pack the charger');
  assert.match(e.data.note_id, /^n_[0-9a-z]{8}$/);
  assert.equal(validateEvent(e), null);
});

test('validateEvent checks note bodies', () => {
  const add = noteAdded(ctx(), 'x');
  assert.equal(validateEvent({ ...add, data: { ...add.data, text: '' } }), 'data.text');
  assert.equal(validateEvent({ ...add, data: { ...add.data, text: 'x'.repeat(MAX_NOTE_CHARS + 1) } }), 'data.text');
  assert.equal(validateEvent({ ...add, data: { ...add.data, note_id: 'bad id' } }), 'data.note_id');
  const done = noteDone(ctx(), add.data.note_id, true);
  assert.equal(validateEvent(done), null);
  assert.equal(validateEvent({ ...done, data: { ...done.data, done: 'yes' } }), 'data.done');
});

test('notes list newest first, and done is last writer wins', () => {
  const c = ctx();
  const a = noteAdded(c, 'first');
  const b = noteAdded(c, 'second');
  const on = noteDone(c, a.data.note_id, true);
  const off = noteDone(c, a.data.note_id, false);
  const s = buildNotes([off, b, on, a]); // any order
  assert.deepEqual(listNotes(s).map((n) => [n.text, n.done]), [['second', false], ['first', false]]);
});

test('an edit stamped `after` wins over a note marked done from a clock far ahead', () => {
  const fast = ctx('dev-fast', 9e12);
  const slow = ctx('dev-slow', 1000);
  const a = noteAdded(slow, 'x');
  const ahead = noteDone(fast, a.data.note_id, true);
  let s = buildNotes([a, ahead]);
  const undo = noteDone(slow, a.data.note_id, false, { after: listNotes(s)[0].doneTs });
  s = applyEvent(s, undo);
  assert.equal(listNotes(s)[0].done, false);
});

test('applying the same event twice changes nothing; bad and unknown events are ignored', () => {
  const c = ctx();
  const a = noteAdded(c, 'x');
  const s = buildNotes([a, a, { ...a, id: 'z', data: { text: '' } }, { ...a, id: 'y', type: 'note.pinned' }]);
  assert.equal(listNotes(s).length, 1);
});

test('done for a note this device has not seen yet waits for the note', () => {
  const c = ctx();
  const a = noteAdded(c, 'x');
  const s = buildNotes([noteDone(c, a.data.note_id, true)]);
  assert.equal(listNotes(s).length, 0);
  applyEvent(s, a);
  assert.equal(listNotes(s)[0].done, true);
});
