// Days are local calendar dates as "YYYY-MM-DD" strings. The UI picks the
// day when an event is made and it is stored as-is, so time zones and DST
// never change which day a tick belongs to. Date math on these strings is
// done in UTC, where every day is exactly 24 hours.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MS_PER_DAY = 86400000;

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');

/** @param {string} day */
function parts(day) {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return m;
}

/** @param {string} day */
function toUtc(day) {
  const [, y, m, d] = parts(day);
  return Date.UTC(+y, +m - 1, +d);
}

/** @param {number} ms */
function fromUtc(ms) {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** @param {unknown} day @returns {day is string} */
export function isValidDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  return fromUtc(toUtc(day)) === day;
}

// Before `rolloverHour` (local time) still counts as the previous day,
// so a 1am check-in lands on the day you were living.
export function logicalDay(date = new Date(), rolloverHour = 4) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (date.getHours() < rolloverHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @param {string} day @param {number} n */
export function addDays(day, n) {
  return fromUtc(toUtc(day) + n * MS_PER_DAY);
}

/** @param {string} a @param {string} b */
export function daysBetween(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / MS_PER_DAY);
}

// 0 = Monday ... 6 = Sunday
/** @param {string} day */
export function weekday(day) {
  return (new Date(toUtc(day)).getUTCDay() + 6) % 7;
}

/** @param {string} day */
export function weekStart(day) {
  return addDays(day, -weekday(day));
}

/** @param {string} day */
export function weekDays(day) {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// The days the heatmap and star counts look at.
/** @param {string} today @param {'rolling7' | 'week'} [mode] */
export function windowDays(today, mode = 'rolling7') {
  if (mode === 'week') {
    return weekDays(today).filter((d) => d <= today);
  }
  return Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
}

/** @param {string} day */
export function weekdayName(day, short = false) {
  const name = WEEKDAYS[weekday(day)];
  return short ? name.slice(0, 3) : name;
}

/** @param {string} day @param {string} [today] */
export function shortDate(day, today) {
  const [, y, m, d] = parts(day);
  const base = `${weekdayName(day, true)} ${+m}/${+d}`;
  return today && today.slice(0, 4) !== y ? `${base}/${y.slice(2)}` : base;
}

/** @param {string} day @param {string} today */
export function dayLabel(day, today) {
  if (day === today) return 'Today';
  const back = daysBetween(day, today);
  if (back === 1) return 'Yesterday';
  if (back > 1 && back <= 6) return weekdayName(day);
  return shortDate(day, today);
}
