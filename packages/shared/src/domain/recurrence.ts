// §5.1 — Recurrence rule evaluation: given a rule and a date range, return all
// logical days on which the item is due.
//
// Pure and deterministic: (rule, range, anchor) → due days.  No DB access, no side
// effects.  Quota targets (§5.2) are stats-only and do not affect due-day computation.
//
// All date arithmetic uses Date.UTC / getUTC* to avoid DST distortion.

import type { RecurrenceRule } from '../types/enums'
import type { Item, ItemSchedule } from '../types/entities'

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

// §5.1 amendment / §5.5 — the anchor date for a schedule's 'interval'/'monthly'
// recurrence.  Uses the explicit anchor_day if the user set one; otherwise falls back
// to the UTC calendar date of the owning item's createdAt (the pre-amendment default).
//
// The fallback is the *item's* creation date, not the schedule's, so that a schedule
// backfilled by migration 0014 anchors exactly where it did before the split.
export function scheduleAnchorDate(schedule: ItemSchedule, item: Item): string {
  return schedule.anchorDay ?? item.createdAt.toISOString().slice(0, 10)
}

// §5.5 — one due (day, schedule) pair.  This, not a bare day, is what identifies an
// occurrence once an item can carry several schedules.
export type DueSlot = {
  day: string          // YYYY-MM-DD
  scheduleId: string
}

/**
 * §5.5 — Every slot an item is due in [startDate, endDate], across all of its
 * schedules, in ascending (day, schedule sort order) order.
 *
 * Two schedules due on the same day yield two slots for that day — that is the whole
 * point.  Archived schedules (§5.5: the user removed the slot) and one-time schedules
 * (null rule; they only ever exist as stored rows) contribute nothing here.
 *
 * Callers that want the distinct *days* an item is due — stats, which treat the item
 * as the unit — should use getItemDueDays instead of de-duplicating this themselves.
 */
export function getItemDueSlots(
  item: Item,
  schedules: ItemSchedule[],
  startDate: string,
  endDate: string
): DueSlot[] {
  const slots: DueSlot[] = []

  const active = schedules
    .filter((s) => s.archivedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime())

  for (const schedule of active) {
    if (!schedule.recurrenceRule) continue
    const days = getDueDays(
      schedule.recurrenceRule,
      startDate,
      endDate,
      scheduleAnchorDate(schedule, item)
    )
    for (const day of days) slots.push({ day, scheduleId: schedule.id })
  }

  // Day-major so a caller walking the list sees a day's slots together.
  slots.sort((a, b) => a.day.localeCompare(b.day))
  return slots
}

/**
 * §5.5 — The distinct days an item is due in the window (the union across its
 * schedules).  A day on which several slots fall appears exactly once.
 */
export function getItemDueDays(
  item: Item,
  schedules: ItemSchedule[],
  startDate: string,
  endDate: string
): string[] {
  const days = new Set(getItemDueSlots(item, schedules, startDate, endDate).map((s) => s.day))
  return Array.from(days).sort()
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
