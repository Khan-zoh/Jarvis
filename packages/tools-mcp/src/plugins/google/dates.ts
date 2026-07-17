/**
 * Voice-friendly date formatting for the Google plugin (binding output rule:
 * cdd/plan/tools-and-google.md — "human dates ('tue jul 14, 3pm')").
 *
 * Everything is lower-case and in the server's LOCAL timezone (which is the user's machine).
 * Timed values render as `tue jul 14, 3pm`; all-day (date-only, e.g. `2026-07-14`) values render
 * as `tue jul 14` with no clock component — and are parsed from their calendar parts so an
 * all-day event never drifts a day when the machine is behind UTC.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
] as const;

/** True for a bare `YYYY-MM-DD` (all-day / date-only) value with no time component. */
export function isDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
}

/** `3pm`, `3:30pm`, `12am` (midnight), `12pm` (noon). */
export function humanTime(d: Date): string {
  const minutes = d.getMinutes();
  let hour = d.getHours();
  const meridiem = hour < 12 ? 'am' : 'pm';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return minutes === 0 ? `${hour}${meridiem}` : `${hour}:${String(minutes).padStart(2, '0')}${meridiem}`;
}

function dayLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** `tue jul 14, 3pm` for a timestamp, or `tue jul 14` for a date-only value. Invalid → echoed back. */
export function humanDate(iso: string): string {
  if (isDateOnly(iso)) {
    const [y, m, day] = iso.trim().split('-').map(Number);
    const local = new Date(y!, m! - 1, day!);
    return dayLabel(local);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayLabel(d)}, ${humanTime(d)}`;
}

/**
 * A start→end window spoken naturally:
 *  - same day, timed:  `tue jul 14, 3pm–4pm`
 *  - crossing days:    `tue jul 14, 11pm – wed jul 15, 1am`
 *  - all-day:          `tue jul 14 (all day)` (Google's exclusive end date is ignored)
 */
export function humanTimeRange(startIso: string, endIso: string): string {
  if (isDateOnly(startIso)) return `${humanDate(startIso)} (all day)`;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return humanDate(startIso);
  }
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  return sameDay
    ? `${humanDate(startIso)}–${humanTime(end)}`
    : `${humanDate(startIso)} – ${humanDate(endIso)}`;
}
