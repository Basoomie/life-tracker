// §5.1 — Recurrence rule evaluation: given a rule and a date range, return all
// logical days on which the item is due.
//
// Pure and deterministic: (rule, range, anchor) → due days.  No DB access, no side
// effects.  Quota targets (§5.2) are stats-only and do not affect due-day computation.
//
// All date arithmetic uses Date.UTC / getUTC* to avoid DST distortion.

import type { RecurrenceRule } from '../types/enums'
import type { Item } from '../types/entities'

// Advance a YYYY-MM-DD string by one calendar day (UTC-safe).
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

// Day-of-week of a YYYY-MM-DD: 0=Sun … 6=Sat.
// Uses UTC midnight to prevent timezone-dependent day-of-week shifts.
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// Whole days from date a to date b (b − a), using UTC midnight.
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

// Add N calendar days to a YYYY-MM-DD string (UTC-safe).
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

// Build a YYYY-MM-DD from year, 1-based month, and 1-based day.
// Returns null if the day doesn't exist in that month (e.g. Feb 30).
function buildDate(year: number, month: number, day: number): string | null {
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCMonth() !== month - 1) return null  // overflowed into the next month
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

// §5.1 amendment — the anchor date for an item's 'interval'/'monthly' recurrence.
// Uses the explicit anchor_day if the user set one at creation; otherwise falls
// back to the UTC calendar date of createdAt (the pre-amendment default).
export function itemAnchorDate(item: Item): string {
  return item.anchorDay ?? item.createdAt.toISOString().slice(0, 10)
}

/**
 * §5.1 — Return all logical days in [startDate, endDate] on which an item with
 * the given recurrence rule is due, in ascending order.
 *
 * @param rule        The item's recurrence rule.
 * @param startDate   Inclusive range start, YYYY-MM-DD.
 * @param endDate     Inclusive range end, YYYY-MM-DD.
 * @param anchorDate  The item's creation date (YYYY-MM-DD), used as the reference
 *                    point for 'interval' rules.  Ignored by daily / days_of_week /
 *                    monthly rules.
 *
 * Interval rule: the item is due on anchorDate and every N days (unit='day') or
 * N×7 days (unit='week') thereafter.  No occurrences are generated before anchorDate.
 *
 * Monthly rule: due on the same day-of-month as anchorDate.  Months that do not
 * contain that day (e.g. anchor on Jan 31 → February) are skipped — consistent with
 * iCal BYMONTHDAY semantics referenced in §5.1.
 *
 * §5.2 note: quota targets are stats-only and play no role here.
 */
export function getDueDays(
  rule: RecurrenceRule,
  startDate: string,
  endDate: string,
  anchorDate: string
): string[] {
  if (startDate > endDate) return []

  const result: string[] = []

  switch (rule.type) {
    case 'daily': {
      let cur = startDate
      while (cur <= endDate) {
        result.push(cur)
        cur = nextDay(cur)
      }
      break
    }

    case 'days_of_week': {
      const daySet = new Set(rule.days)
      let cur = startDate
      while (cur <= endDate) {
        if (daySet.has(dayOfWeek(cur))) {
          result.push(cur)
        }
        cur = nextDay(cur)
      }
      break
    }

    case 'interval': {
      // Step size in days: N days or N weeks (= N×7 days).
      const stepDays = rule.unit === 'day' ? rule.every : rule.every * 7

      // Find the smallest k ≥ 0 such that (anchorDate + k×stepDays) ≥ startDate.
      const anchorToStart = daysBetween(anchorDate, startDate)
      const firstK = anchorToStart <= 0 ? 0 : Math.ceil(anchorToStart / stepDays)

      for (let k = firstK; ; k++) {
        const due = addDays(anchorDate, k * stepDays)
        if (due > endDate) break
        if (due >= startDate) {
          result.push(due)
        }
      }
      break
    }

    case 'monthly': {
      // Due on the same day-of-month as anchorDate; skip months that don't have it.
      const targetDay = parseInt(anchorDate.slice(8), 10)
      const [sy, sm] = startDate.split('-').map(Number)
      const [ey, em] = endDate.split('-').map(Number)

      for (let year = sy; year <= ey; year++) {
        const monthStart = year === sy ? sm : 1
        const monthEnd   = year === ey ? em : 12
        for (let month = monthStart; month <= monthEnd; month++) {
          const due = buildDate(year, month, targetDay)
          if (due && due >= startDate && due <= endDate) {
            result.push(due)
          }
        }
      }
      break
    }
  }

  return result
}
