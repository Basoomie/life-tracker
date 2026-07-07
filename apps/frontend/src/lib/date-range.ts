// §12.3 / §12.4 — Range computation for List and Calendar views.
// All dates are UTC to match backend todayUTC().

export type RangeKey = 'today' | 'tomorrow' | 'this-week' | 'this-month'

export function todayStr(ref: Date = new Date()): string {
  return ref.toISOString().slice(0, 10)
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function getRangeDates(
  key: RangeKey,
  ref: Date = new Date()
): { start: string; end: string } {
  const today = todayStr(ref)

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
