import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  logicalDay, isValidDay, addDays, weekday, weekStart, weekDays, windowDays, dayLabel,
} from '../app/core/days.js';

// Dates built with the local-time constructor, so these tests hold in any TZ.
/** @param {number} y @param {number} mo @param {number} d */
const local = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('logicalDay returns the local calendar date after rollover', () => {
  assert.equal(logicalDay(local(2026, 9, 23, 12), 4), '2026-09-23');
  assert.equal(logicalDay(local(2026, 9, 23, 4, 0), 4), '2026-09-23');
});

test('logicalDay counts the hours before rollover as the previous day', () => {
  assert.equal(logicalDay(local(2026, 9, 23, 1, 30), 4), '2026-09-22');
  assert.equal(logicalDay(local(2026, 9, 23, 3, 59), 4), '2026-09-22');
});

test('logicalDay crosses month and year boundaries', () => {
  assert.equal(logicalDay(local(2026, 1, 1, 2), 4), '2025-12-31');
  assert.equal(logicalDay(local(2024, 3, 1, 0), 4), '2024-02-29');
});

test('logicalDay with rollover 0 is the plain calendar date', () => {
  assert.equal(logicalDay(local(2026, 9, 23, 0, 1), 0), '2026-09-23');
});

test('isValidDay accepts real dates only', () => {
  assert.ok(isValidDay('2024-02-29'));
  assert.ok(!isValidDay('2025-02-29'));
  assert.ok(!isValidDay('2026-13-01'));
  assert.ok(!isValidDay('2026-9-1'));
  assert.ok(!isValidDay(20260901));
  assert.ok(!isValidDay(undefined));
});

test('addDays works across months, years, leap days, and DST dates', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-03-07', 2), '2026-03-09'); // US DST start
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // US DST end
  assert.equal(addDays('2026-09-23', 0), '2026-09-23');
});

test('weekday is Monday-based', () => {
  assert.equal(weekday('2026-09-21'), 0); // Monday
  assert.equal(weekday('2026-09-23'), 2); // Wednesday
  assert.equal(weekday('2026-09-27'), 6); // Sunday
});

test('weekStart returns the Monday of the week', () => {
  assert.equal(weekStart('2026-09-23'), '2026-09-21');
  assert.equal(weekStart('2026-09-21'), '2026-09-21');
  assert.equal(weekStart('2026-09-27'), '2026-09-21');
  assert.equal(weekStart('2026-10-01'), '2026-09-28');
});

test('weekDays lists Monday through Sunday', () => {
  assert.deepEqual(weekDays('2026-09-23'), [
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
  ]);
});

test('windowDays rolling7 is the last 7 days ending today', () => {
  assert.deepEqual(windowDays('2026-09-23', 'rolling7'), [
    '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23',
  ]);
});

test('windowDays week is Monday through today, never the future', () => {
  assert.deepEqual(windowDays('2026-09-23', 'week'), ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.deepEqual(windowDays('2026-09-21', 'week'), ['2026-09-21']);
});

// Same convention as iOS Messages: Today, Yesterday, weekday names within
// the last week, dates beyond.
test('dayLabel: Today, Yesterday, weekday names for the last 6 days, dates beyond', () => {
  const today = '2026-09-23'; // Wednesday
  assert.equal(dayLabel('2026-09-23', today), 'Today');
  assert.equal(dayLabel('2026-09-22', today), 'Yesterday');
  assert.equal(dayLabel('2026-09-21', today), 'Monday');
  assert.equal(dayLabel('2026-09-17', today), 'Thursday');
  assert.equal(dayLabel('2026-09-16', today), 'Wed 9/16');
  assert.equal(dayLabel('2025-12-30', today), 'Tue 12/30/25');
});
