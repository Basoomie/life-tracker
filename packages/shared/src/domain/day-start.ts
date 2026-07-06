// §6.7 — Day-start bucketing: translate an absolute timestamp to a logical day.
//
// The core operation: given a wall-clock date + time and the day-start timeline,
// determine which logical day the timestamp belongs to.  A 1:30am timestamp with a
// 4:00am day-start belongs to the *previous* calendar day; a 5:00am timestamp belongs
// to the *new* calendar day.
//
// The pure, testable function is bucketLocalDateTime — it accepts pre-extracted
// local date and time strings so callers can control timezone extraction independently.
// bucketTimestamp is the convenience wrapper that extracts those from a Date object
// using the Node.js local (system) timezone.

import type { DayStartEntry } from '../types/entities'

// Normalize a TIME value that may arrive as 'HH:MM:SS' (Postgres TIME type) to 'HH:MM'.
function normalizeHHMM(value: string): string {
  return value.slice(0, 5)
}

// Subtract one calendar day from a YYYY-MM-DD string.
// UTC arithmetic prevents DST distortion in date-only math.
function prevCalendarDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d - 1))
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

// Find the effective day-start value (HH:MM) for a given calendar day.
// Returns the value whose startsOn is the latest one ≤ calendarDay.
// Returns null when no entry exists at or before that day.
function getEffectiveDayStart(timeline: DayStartEntry[], calendarDay: string): string | null {
  let best: DayStartEntry | null = null
  for (const entry of timeline) {
    if (entry.startsOn <= calendarDay) {
      if (!best || entry.startsOn > best.startsOn) {
        best = entry
      }
    }
  }
  return best ? normalizeHHMM(best.value) : null
}

/**
 * §6.7 — Pure bucketing function.  Accepts the local wall-clock date and time as
 * strings so timezone extraction is the caller's responsibility and tests are
 * fully deterministic regardless of the machine's TZ setting.
 *
 * Changeover-day rule (§6.7): the calendar date of the timestamp determines which
 * day-start value applies.  On the first day a new day-start takes effect its new
 * value is used immediately — the early-morning window before the new boundary is
 * attributed to the *previous* logical day, which may shorten or lengthen that
 * transition day.  Past logical days are never re-bucketed by a later config change
 * because they were bucketed using the then-effective value when the event occurred.
 *
 * Falls back to '00:00' (midnight) when no day-start is configured, making the
 * logical day always equal to the calendar day.
 *
 * @param localDate  Local wall-clock calendar date, YYYY-MM-DD
 * @param localTime  Local wall-clock time, HH:MM
 * @param timeline   Full day-start timeline for the user (any order)
 * @returns          Logical day, YYYY-MM-DD
 */
export function bucketLocalDateTime(
  localDate: string,
  localTime: string,
  timeline: DayStartEntry[]
): string {
  const dayStart = getEffectiveDayStart(timeline, localDate) ?? '00:00'
  return localTime >= dayStart ? localDate : prevCalendarDay(localDate)
}

// Extract 'YYYY-MM-DD' from a Date using the Node.js process local timezone.
function localCalendarDate(ts: Date): string {
  return (
    String(ts.getFullYear()) +
    '-' +
    String(ts.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(ts.getDate()).padStart(2, '0')
  )
}

// Extract 'HH:MM' from a Date using the Node.js process local timezone.
function localTimeHHMM(ts: Date): string {
  return String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0')
}

/**
 * §6.7 — Convenience wrapper around bucketLocalDateTime.
 * Extracts the local wall-clock date and time from a Date object using the Node.js
 * process timezone (i.e. the system timezone of the host machine).
 *
 * For deterministic unit tests use bucketLocalDateTime directly with explicit strings.
 */
export function bucketTimestamp(ts: Date, timeline: DayStartEntry[]): string {
  return bucketLocalDateTime(localCalendarDate(ts), localTimeHHMM(ts), timeline)
}
