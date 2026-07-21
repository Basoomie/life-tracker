// §12.3 / §12.4 — Range computation for List and Calendar views.
//
// "Today" is the user's local wall-clock calendar date — matching what a native
// <input type="date"> shows/highlights as today, and matching the backend's
// today() helper (see apps/backend/src/routes/helpers.ts). Using UTC here would
// make the "Today" quick-select disagree with a manually-picked "today" date for
// part of every day (whenever the local and UTC calendar dates differ), splitting
// completions/time logs across two appliesToDay buckets for what the user
// experiences as one day.
//
// Once anchored to a date-only YYYY-MM-DD string, all further arithmetic below
// stays UTC-based deliberately — that's just string date math (no DST pitfalls),
// not a statement about which day "now" is.

export type RangeKey = 'today' | 'tomorrow' | 'this-week' | 'this-month' | 'overdue' | 'custom'

// Matches the v2 stats "all time" floor (stats-presentation.ts) — simplest
// honest lower bound for a single-user app at this scale.
const OVERDUE_FLOOR = '2000-01-01'

export function todayStr(ref: Date = new Date()): string {
  return (
    String(ref.getFullYear()) +
    '-' +
    String(ref.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(ref.getDate()).padStart(2, '0')
  )
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// `today` is supplied by the caller rather than derived internally here — List
// and Calendar views compute it via bucketTimestamp(now, dayStartEntries) so
// "Today" and the is-today highlight honor the user's configured day-start
// (§6.7), which this module has no way to know about on its own.
export function getRangeDates(
  key: RangeKey,
  today: string,
  customDate?: string
): { start: string; end: string } {
  if (key === 'custom') {
    const day = customDate ?? today
    return { start: day, end: day }
  }

  if (key === 'today') return { start: today, end: today }

  if (key === 'tomorrow') {
    const tom = addDays(today, 1)
    return { start: tom, end: tom }
  }

  if (key === 'this-week') {
    // ISO week: Monday → Sunday
    const dow = new Date(today + 'T00:00:00Z').getUTCDay() // 0=Sun
    const daysToMon = dow === 0 ? -6 : 1 - dow
    const mon = addDays(today, daysToMon)
    const sun = addDays(mon, 6)
    return { start: mon, end: sun }
  }

  if (key === 'overdue') {
    // Descriptive only — ListView queries a dedicated /occurrences/overdue
    // endpoint rather than fetching this whole span (avoids expanding every
    // recurring item's rule across decades just to find a handful of
    // untouched one-time tasks).
    return { start: OVERDUE_FLOOR, end: addDays(today, -1) }
  }

  // this-month
  const firstDay = today.slice(0, 7) + '-01'
  const d = new Date(today + 'T00:00:00Z')
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10)
  return { start: firstDay, end: lastDay }
}

// All YYYY-MM-DD strings from start to end inclusive.
export function getDaysInRange(start: string, end: string): string[] {
  const days: string[] = []
  let cur = start
  while (cur <= end) {
    days.push(cur)
    cur = addDays(cur, 1)
  }
  return days
}

export function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
