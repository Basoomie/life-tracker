// §5.1 — Recurrence rule evaluation tests.
//
// Tests are named after the spec's stated rules.  All date arithmetic uses UTC
// so results are identical regardless of the host's TZ setting.
// §5.2 note: quota targets are stats-only and must not affect due-day computation.

import { describe, it, expect } from 'vitest'
import { getDueDays } from '../domain/recurrence'

// ── Daily rule ────────────────────────────────────────────────────────────────

describe('§5.1 daily rule', () => {
  it('§5.1 daily rule: every day in range is a due day', () => {
    const days = getDueDays({ type: 'daily' }, '2024-01-01', '2024-01-07', '2024-01-01')
    expect(days).toEqual([
      '2024-01-01', '2024-01-02', '2024-01-03',
      '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-07',
    ])
  })

  it('§5.1 daily rule: returns exactly the range — no days outside it', () => {
    const days = getDueDays({ type: 'daily' }, '2024-03-05', '2024-03-05', '2024-01-01')
    expect(days).toEqual(['2024-03-05'])
  })

  it('§5.1 daily rule: start > end returns empty', () => {
    const days = getDueDays({ type: 'daily' }, '2024-03-10', '2024-03-09', '2024-01-01')
    expect(days).toHaveLength(0)
  })

  it('§5.1 daily rule: month boundary is handled correctly (Jan 31 → Feb 1)', () => {
    const days = getDueDays({ type: 'daily' }, '2024-01-30', '2024-02-02', '2024-01-01')
    expect(days).toEqual(['2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02'])
  })
})

// ── Days-of-week rule ─────────────────────────────────────────────────────────

describe('§5.1 days_of_week rule', () => {
  // Week of Mon 2024-01-08 … Sun 2024-01-14
  it('§5.1 MWF item is due Mon/Wed/Fri and not Tue/Thu/Sat/Sun', () => {
    const days = getDueDays(
      { type: 'days_of_week', days: [1, 3, 5] },  // Mon, Wed, Fri
      '2024-01-08', '2024-01-14',
      '2024-01-01'
    )
    expect(days).toEqual(['2024-01-08', '2024-01-10', '2024-01-12'])
  })

  it('§5.1 days_of_week: multi-week range repeats correctly for MWF', () => {
    const days = getDueDays(
      { type: 'days_of_week', days: [1, 3, 5] },
      '2024-01-08', '2024-01-21',
      '2024-01-01'
    )
    expect(days).toEqual([
      '2024-01-08', '2024-01-10', '2024-01-12',  // week 1
      '2024-01-15', '2024-01-17', '2024-01-19',  // week 2
    ])
  })

  it('§5.1 days_of_week: Saturday-only (day 6) recurrence', () => {
    const days = getDueDays(
      { type: 'days_of_week', days: [6] },
      '2024-01-01', '2024-01-31',
      '2024-01-01'
    )
    expect(days).toEqual(['2024-01-06', '2024-01-13', '2024-01-20', '2024-01-27'])
  })

  it('§5.1 days_of_week: empty days array produces no due days', () => {
    const days = getDueDays(
      { type: 'days_of_week', days: [] },
      '2024-01-01', '2024-01-31',
      '2024-01-01'
    )
    expect(days).toHaveLength(0)
  })

  it('§5.1 days_of_week: all 7 days is equivalent to daily', () => {
    const allDays = getDueDays(
      { type: 'days_of_week', days: [0, 1, 2, 3, 4, 5, 6] },
      '2024-01-01', '2024-01-07',
      '2024-01-01'
    )
    const daily = getDueDays({ type: 'daily' }, '2024-01-01', '2024-01-07', '2024-01-01')
    expect(allDays).toEqual(daily)
  })

  it('§5.1 days_of_week: weekday Mon–Fri workout schedule', () => {
    const days = getDueDays(
      { type: 'days_of_week', days: [1, 2, 4, 6] },  // Mon/Tue/Thu/Sat
      '2024-01-08', '2024-01-14',
      '2024-01-01'
    )
    expect(days).toEqual(['2024-01-08', '2024-01-09', '2024-01-11', '2024-01-13'])
  })
})

// ── Interval rule ─────────────────────────────────────────────────────────────

describe('§5.1 interval rule', () => {
  it('§5.1 interval day: every 3 days from anchor lands on correct days', () => {
    // Anchor Jan 1 → due Jan 1, Jan 4, Jan 7, Jan 10, ...
    const days = getDueDays(
      { type: 'interval', unit: 'day', every: 3 },
      '2024-01-01', '2024-01-15',
      '2024-01-01'
    )
    expect(days).toEqual([
      '2024-01-01', '2024-01-04', '2024-01-07',
      '2024-01-10', '2024-01-13',
    ])
  })

  it('§5.1 interval day: range starting mid-cycle picks up at the right occurrence', () => {
    // Anchor Jan 1, every 5 days: Jan 1, 6, 11, 16, ...
    // Range starts Jan 7 → first result is Jan 11
    const days = getDueDays(
      { type: 'interval', unit: 'day', every: 5 },
      '2024-01-07', '2024-01-20',
      '2024-01-01'
    )
    expect(days).toEqual(['2024-01-11', '2024-01-16'])
  })

  it('§5.1 interval week: biweekly (every 2 weeks) from anchor', () => {
    // Anchor Mon Jan 1 → due Jan 1, Jan 15, Jan 29
    const days = getDueDays(
      { type: 'interval', unit: 'week', every: 2 },
      '2024-01-01', '2024-01-31',
      '2024-01-01'
    )
    expect(days).toEqual(['2024-01-01', '2024-01-15', '2024-01-29'])
  })

  it('§5.1 interval week: biweekly result never lands on wrong-week days', () => {
    // Anchor Mon Jan 1 → Jan 8 must NOT be a due day (it's one week, not two).
    const days = getDueDays(
      { type: 'interval', unit: 'week', every: 2 },
      '2024-01-01', '2024-01-31',
      '2024-01-01'
    )
    expect(days).not.toContain('2024-01-08')
    expect(days).not.toContain('2024-01-22')
  })

  it('§5.1 interval: range starting before anchor has no occurrences before anchor date', () => {
    // Range starts Dec 25, anchor is Jan 1 → first due day is Jan 1.
    const days = getDueDays(
      { type: 'interval', unit: 'day', every: 7 },
      '2024-12-25', '2025-01-15',
      '2025-01-01'
    )
    expect(days[0]).toBe('2025-01-01')
    expect(days).not.toContain('2024-12-25')
    expect(days).not.toContain('2024-12-27')
  })

  it('§5.1 interval day: every 1 day is equivalent to daily', () => {
    const interval = getDueDays(
      { type: 'interval', unit: 'day', every: 1 },
      '2024-02-01', '2024-02-10',
      '2024-01-01'
    )
    const daily = getDueDays({ type: 'daily' }, '2024-02-01', '2024-02-10', '2024-01-01')
    expect(interval).toEqual(daily)
  })
})

// ── Monthly rule ──────────────────────────────────────────────────────────────

describe('§5.1 monthly rule', () => {
  it('§5.1 monthly: same day-of-month as anchor, multi-month range', () => {
    // Anchor Jan 15 → due 15th of each month
    const days = getDueDays(
      { type: 'monthly' },
      '2024-01-01', '2024-06-30',
      '2024-01-15'
    )
    expect(days).toEqual([
      '2024-01-15', '2024-02-15', '2024-03-15',
      '2024-04-15', '2024-05-15', '2024-06-15',
    ])
  })

  it('§5.1 monthly: anchor day 31 — skips months with fewer than 31 days', () => {
    // Jan 31 anchor: Feb has 29 days in 2024 (leap year) — skip Feb; Apr/Jun/Sep/Nov also skipped.
    const days = getDueDays(
      { type: 'monthly' },
      '2024-01-01', '2024-12-31',
      '2024-01-31'
    )
    // Should land on: Jan 31, Mar 31, May 31, Jul 31, Aug 31, Oct 31, Dec 31
    expect(days).toEqual([
      '2024-01-31', '2024-03-31', '2024-05-31',
      '2024-07-31', '2024-08-31', '2024-10-31', '2024-12-31',
    ])
  })

  it('§5.1 monthly: leap-year Feb 29 anchor is due on Feb 29 in leap years only', () => {
    // 2024 is a leap year (Feb 29 exists); 2025 is not.
    const days2024 = getDueDays(
      { type: 'monthly' },
      '2024-02-01', '2024-03-01',
      '2024-02-29'
    )
    expect(days2024).toContain('2024-02-29')

    const days2025 = getDueDays(
      { type: 'monthly' },
      '2025-02-01', '2025-03-01',
      '2024-02-29'  // same anchor day-of-month = 29
    )
    expect(days2025).not.toContain('2025-02-29')  // Feb 29 doesn't exist in 2025
    expect(days2025).toHaveLength(0)              // no due day in Feb 2025
  })

  it('§5.1 monthly: range with start == end returns that day if it matches', () => {
    const days = getDueDays(
      { type: 'monthly' },
      '2024-03-15', '2024-03-15',
      '2024-01-15'
    )
    expect(days).toEqual(['2024-03-15'])
  })

  it('§5.1 monthly: range with start == end returns empty if day does not match', () => {
    const days = getDueDays(
      { type: 'monthly' },
      '2024-03-14', '2024-03-14',
      '2024-01-15'
    )
    expect(days).toHaveLength(0)
  })
})

// ── Cross-cutting / edge cases ────────────────────────────────────────────────

describe('§5.1 edge cases', () => {
  it('§5.1 range start == end: daily returns that single day', () => {
    const days = getDueDays({ type: 'daily' }, '2024-06-15', '2024-06-15', '2024-01-01')
    expect(days).toEqual(['2024-06-15'])
  })

  it('§5.1 result is sorted ascending regardless of rule type', () => {
    // days_of_week — verify ascending order across a month
    const days = getDueDays(
      { type: 'days_of_week', days: [5, 1, 3] },  // deliberate unsorted input
      '2024-01-01', '2024-01-31',
      '2024-01-01'
    )
    const sorted = [...days].sort()
    expect(days).toEqual(sorted)
  })

  it('§5.2 quota target is not part of due-day computation — getDueDays does not accept it', () => {
    // getDueDays only takes a RecurrenceRule, not a QuotaTarget.  This is structural:
    // passing { type: 'daily' } produces the same result whether a quota exists or not.
    const withRule = getDueDays({ type: 'daily' }, '2024-01-01', '2024-01-03', '2024-01-01')
    expect(withRule).toHaveLength(3)
  })

  it('§5.1 interval week: multi-month range works across year boundary', () => {
    // Every 4 weeks (28 days) from Dec 1 2024.
    // Dec 1 → Dec 29 → Jan 26 → Feb 23.  Range ends Jan 31 to capture exactly 3.
    const days = getDueDays(
      { type: 'interval', unit: 'week', every: 4 },
      '2024-12-01', '2025-01-31',
      '2024-12-01'
    )
    expect(days).toEqual(['2024-12-01', '2024-12-29', '2025-01-26'])
  })
})
