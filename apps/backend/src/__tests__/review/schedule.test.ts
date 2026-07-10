// v2 §6.4 / §9.3 / §9.6 Category 4 — schedule.ts: cadence periods, no daily review,
// day-start-aligned windows, configurable week boundary.

import { describe, it, expect } from 'vitest'
import { determineClosedPeriods } from '../../review/schedule'

describe('§6.4 — no daily cadence exists', () => {
  it('an ordinary Wednesday with no calendar significance closes zero periods', () => {
    // 2026-01-07 is a Wednesday — not a week start (Mon), not the 1st of a month.
    expect(determineClosedPeriods('2026-01-07', 'monday')).toEqual([])
  })
})

describe('§9.3 weekly — fires on the configured week-start day, window is the 7 days that just ended', () => {
  it('Monday week-start: a Monday closes the prior Mon–Sun week', () => {
    // 2026-01-05 is a Monday.
    const periods = determineClosedPeriods('2026-01-05', 'monday')
    const weekly = periods.find((p) => p.cadence === 'weekly')
    expect(weekly).toBeDefined()
    expect(weekly!.window).toEqual({ startDay: '2025-12-29', endDay: '2026-01-04' })
  })

  it('Sunday week-start: the same calendar Monday does NOT close a week (wrong boundary day)', () => {
    const periods = determineClosedPeriods('2026-01-05', 'sunday')
    expect(periods.find((p) => p.cadence === 'weekly')).toBeUndefined()
  })

  it('Sunday week-start: a Sunday closes the prior Sun–Sat week', () => {
    // 2026-01-04 is a Sunday.
    const periods = determineClosedPeriods('2026-01-04', 'sunday')
    const weekly = periods.find((p) => p.cadence === 'weekly')
    expect(weekly!.window).toEqual({ startDay: '2025-12-28', endDay: '2026-01-03' })
  })

  it('the weekly window is always exactly 7 days — never splits a 4x/week quota period (§9.3)', () => {
    const periods = determineClosedPeriods('2026-01-05', 'monday')
    const weekly = periods.find((p) => p.cadence === 'weekly')!
    const start = new Date(weekly.window.startDay)
    const end = new Date(weekly.window.endDay)
    const days = (end.getTime() - start.getTime()) / 86_400_000
    expect(days).toBe(6) // inclusive of both ends → 7 calendar days total
  })
})

describe('§9.3 monthly — fires on the 1st, window is the entire previous calendar month', () => {
  it('Feb 1st closes January', () => {
    const periods = determineClosedPeriods('2026-02-01', 'monday')
    const monthly = periods.find((p) => p.cadence === 'monthly')
    expect(monthly!.window).toEqual({ startDay: '2026-01-01', endDay: '2026-01-31' })
  })

  it('Jan 1st closes December of the PREVIOUS year (year boundary)', () => {
    const periods = determineClosedPeriods('2026-01-01', 'monday')
    const monthly = periods.find((p) => p.cadence === 'monthly')
    expect(monthly!.window).toEqual({ startDay: '2025-12-01', endDay: '2025-12-31' })
  })

  it('the 15th of a month closes nothing monthly', () => {
    const periods = determineClosedPeriods('2026-01-15', 'monday')
    expect(periods.find((p) => p.cadence === 'monthly')).toBeUndefined()
  })
})

describe('§9.3 quarterly — fires on the 1st of Jan/Apr/Jul/Oct, window is the previous 3 months', () => {
  it('Apr 1st closes Q1 (Jan–Mar)', () => {
    const periods = determineClosedPeriods('2026-04-01', 'monday')
    const quarterly = periods.find((p) => p.cadence === 'quarterly')
    expect(quarterly!.window).toEqual({ startDay: '2026-01-01', endDay: '2026-03-31' })
  })

  it('Jan 1st closes Q4 of the previous year (year boundary)', () => {
    const periods = determineClosedPeriods('2026-01-01', 'monday')
    const quarterly = periods.find((p) => p.cadence === 'quarterly')
    expect(quarterly!.window).toEqual({ startDay: '2025-10-01', endDay: '2025-12-31' })
  })

  it('Feb 1st (not a quarter-start month) closes no quarter', () => {
    const periods = determineClosedPeriods('2026-02-01', 'monday')
    expect(periods.find((p) => p.cadence === 'quarterly')).toBeUndefined()
  })
})

describe('a single day can close multiple periods at once', () => {
  it('Jan 1st (Thursday) can be a monthly AND quarterly boundary simultaneously', () => {
    const periods = determineClosedPeriods('2026-01-01', 'monday')
    expect(periods.map((p) => p.cadence).sort()).toEqual(['monthly', 'quarterly'])
  })
})
