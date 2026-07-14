// §6.7 — Day-start bucketing tests.
//
// Tests are named after the spec's stated rules so a reviewer reading the test list
// reads the design back.  All tests use bucketLocalDateTime with explicit date/time
// strings so they are fully deterministic regardless of the host's TZ setting.
// (bucketTimestamp wraps the same logic via Date.getHours()/getDate() and is
//  intentionally not tested with timezone-specific assertions here.)

import { describe, it, expect } from 'vitest'
import type { DayStartEntry } from '../types/entities'
import { bucketLocalDateTime, bucketTimestamp, getEffectiveDayStart } from '../domain/day-start'

// Minimal DayStartEntry factory — only the fields bucketLocalDateTime uses.
function makeEntry(startsOn: string, value: string, recordedAt: Date = new Date()): DayStartEntry {
  return { id: '1', userId: 'u', startsOn, value, recordedAt }
}

const TIMELINE_4AM: DayStartEntry[] = [makeEntry('2024-01-01', '04:00')]

// ── Core day-start bucketing ──────────────────────────────────────────────────

describe('§6.7 day-start bucketing', () => {
  it('§6.7 timestamp before day-start belongs to previous logical day (1:30am, 4:00am start)', () => {
    expect(bucketLocalDateTime('2024-01-15', '01:30', TIMELINE_4AM)).toBe('2024-01-14')
  })

  it('§6.7 timestamp after day-start belongs to new logical day (5:00am, 4:00am start)', () => {
    expect(bucketLocalDateTime('2024-01-15', '05:00', TIMELINE_4AM)).toBe('2024-01-15')
  })

  it('§6.7 timestamp exactly at day-start boundary belongs to new logical day', () => {
    expect(bucketLocalDateTime('2024-01-15', '04:00', TIMELINE_4AM)).toBe('2024-01-15')
  })

  it('§6.7 timestamp at 11:59pm belongs to the same calendar day', () => {
    expect(bucketLocalDateTime('2024-01-15', '23:59', TIMELINE_4AM)).toBe('2024-01-15')
  })

  it('§6.7 timestamp at midnight (00:00) with 4:00am day-start belongs to previous day', () => {
    expect(bucketLocalDateTime('2024-01-15', '00:00', TIMELINE_4AM)).toBe('2024-01-14')
  })

  it('§6.7 timestamp just before midnight (23:59) with midnight day-start belongs to same day', () => {
    const midnight = [makeEntry('2024-01-01', '00:00')]
    expect(bucketLocalDateTime('2024-01-15', '23:59', midnight)).toBe('2024-01-15')
  })
})

// ── Timeline correctness ──────────────────────────────────────────────────────

describe('§6.7 timeline lookup', () => {
  it('§6.7 past day buckets by then-effective value, not current one', () => {
    // Config: 00:00 from Jan 1, changed to 04:00 from Jun 1.
    // A Jan 15 event at 01:00 should use the then-active 00:00 → belongs to Jan 15.
    const timeline = [
      makeEntry('2024-01-01', '00:00'),
      makeEntry('2024-06-01', '04:00'),
    ]
    // Jan 15 at 01:00 — effective day-start was 00:00; 01:00 ≥ 00:00 → Jan 15
    expect(bucketLocalDateTime('2024-01-15', '01:00', timeline)).toBe('2024-01-15')
    // Jun 15 at 01:00 — effective day-start is now 04:00; 01:00 < 04:00 → Jun 14
    expect(bucketLocalDateTime('2024-06-15', '01:00', timeline)).toBe('2024-06-14')
  })

  it('§6.7 timeline correctness: changing config later never re-buckets past days', () => {
    // Simulate: a past event was bucketed when day-start was 00:00.
    // Even if the user later changed to 06:00, the past event is fixed on its
    // logical day.  We prove this by showing that for the past calendar date the
    // lookup still returns the old value.
    const timelineBeforeChange = [makeEntry('2024-01-01', '00:00')]
    const timelineAfterChange  = [
      makeEntry('2024-01-01', '00:00'),
      makeEntry('2024-07-01', '06:00'),
    ]
    // Event on Feb 10 at 02:00: under old timeline → stays Feb 10
    expect(bucketLocalDateTime('2024-02-10', '02:00', timelineBeforeChange)).toBe('2024-02-10')
    // Same event re-evaluated under new timeline (looking up 2024-02-10): still 00:00
    expect(bucketLocalDateTime('2024-02-10', '02:00', timelineAfterChange)).toBe('2024-02-10')
  })

  it('§6.7 no day-start configured: falls back to midnight, logical day equals calendar day', () => {
    expect(bucketLocalDateTime('2024-03-10', '01:00', [])).toBe('2024-03-10')
    expect(bucketLocalDateTime('2024-03-10', '23:00', [])).toBe('2024-03-10')
  })

  it('§6.7 timeline with single entry older than all dates: that entry applies to all future days', () => {
    const timeline = [makeEntry('2000-01-01', '03:00')]
    expect(bucketLocalDateTime('2024-12-31', '02:59', timeline)).toBe('2024-12-30')
    expect(bucketLocalDateTime('2024-12-31', '03:00', timeline)).toBe('2024-12-31')
  })

  it('§6.7 getEffectiveDayStart: two entries with the same startsOn break the tie on recordedAt (latest wins), regardless of array order', () => {
    const earlier = makeEntry('2024-01-15', '04:00', new Date('2024-01-15T08:00:00Z'))
    const later   = makeEntry('2024-01-15', '06:00', new Date('2024-01-15T09:00:00Z'))
    expect(getEffectiveDayStart([earlier, later], '2024-01-15')).toBe('06:00')
    // Order-independence: same result with the array reversed.
    expect(getEffectiveDayStart([later, earlier], '2024-01-15')).toBe('06:00')
  })
})

// ── Changeover-day edge ───────────────────────────────────────────────────────

describe('§6.7 changeover-day edge', () => {
  it('§6.7 changeover-day: first day of new day-start uses the new value immediately', () => {
    // Day-start changes from 00:00 to 04:00 on Jul 5.
    // On Jul 5 itself, 02:00 is now before the new day-start → belongs to Jul 4.
    const timeline = [
      makeEntry('2024-01-01', '00:00'),
      makeEntry('2024-07-05', '04:00'),
    ]
    // Jul 4 at 02:00 — effective is 00:00 (Jul 4 < Jul 5); 02:00 ≥ 00:00 → Jul 4
    expect(bucketLocalDateTime('2024-07-04', '02:00', timeline)).toBe('2024-07-04')
    // Jul 5 at 02:00 — effective is 04:00 (new value); 02:00 < 04:00 → Jul 4
    expect(bucketLocalDateTime('2024-07-05', '02:00', timeline)).toBe('2024-07-04')
    // Jul 5 at 05:00 — effective is 04:00; 05:00 ≥ 04:00 → Jul 5
    expect(bucketLocalDateTime('2024-07-05', '05:00', timeline)).toBe('2024-07-05')
  })

  it('§6.7 changeover-day: moving day-start earlier extends the day (more hours belong to new day)', () => {
    // Day-start moves from 06:00 to 04:00 on Jul 5.
    // On Jul 5, 04:30 now belongs to Jul 5 (it used to belong to Jul 4 under 06:00).
    const timeline = [
      makeEntry('2024-01-01', '06:00'),
      makeEntry('2024-07-05', '04:00'),
    ]
    // Jul 4 at 04:30 — effective is 06:00; 04:30 < 06:00 → Jul 3
    expect(bucketLocalDateTime('2024-07-04', '04:30', timeline)).toBe('2024-07-03')
    // Jul 5 at 04:30 — effective is 04:00; 04:30 ≥ 04:00 → Jul 5
    expect(bucketLocalDateTime('2024-07-05', '04:30', timeline)).toBe('2024-07-05')
  })
})

// ── Postgres TIME value normalization ─────────────────────────────────────────

describe('§6.7 Postgres TIME value normalization', () => {
  it('§6.7 day-start value arriving as HH:MM:SS (Postgres TIME type) is parsed correctly', () => {
    // The day_start_timeline.value column is TIME — pg returns '04:00:00', not '04:00'.
    const timeline = [makeEntry('2024-01-01', '04:00:00')]
    expect(bucketLocalDateTime('2024-01-15', '01:00', timeline)).toBe('2024-01-14')
    expect(bucketLocalDateTime('2024-01-15', '05:00', timeline)).toBe('2024-01-15')
  })
})

// ── DST / date arithmetic stability ──────────────────────────────────────────

describe('§6.7 DST stability', () => {
  it('§6.7 prevCalendarDay uses UTC arithmetic — Mar 10 2024 (US DST transition) is correct', () => {
    // US DST: clocks jump forward on Mar 10 2024. Local midnight arithmetic can
    // lose an hour, but prevCalendarDay uses Date.UTC so it is unaffected.
    // 00:30 on Mar 10 with a 04:00 day-start → should be Mar 9.
    const timeline = [makeEntry('2024-01-01', '04:00')]
    expect(bucketLocalDateTime('2024-03-10', '00:30', timeline)).toBe('2024-03-09')
  })

  it('§6.7 DST stability: Nov 3 2024 (US fall-back) — same calendar date produced', () => {
    // US DST fall-back Nov 3 2024; clocks repeat 01:00–02:00 local time.
    // With a 04:00 day-start, 01:00 is before the boundary → belongs to Nov 2.
    const timeline = [makeEntry('2024-01-01', '04:00')]
    expect(bucketLocalDateTime('2024-11-03', '01:00', timeline)).toBe('2024-11-02')
    expect(bucketLocalDateTime('2024-11-03', '05:00', timeline)).toBe('2024-11-03')
  })
})

// ── bucketTimestamp (wrapper) smoke test ──────────────────────────────────────

describe('bucketTimestamp wrapper', () => {
  it('bucketTimestamp produces the same result as bucketLocalDateTime for a UTC-timezone process', () => {
    // We cannot assert local-time details portably, but we can verify that wrapping
    // a Date and calling bucketLocalDateTime with the same components agree.
    // Pick noon UTC on Jan 15 — well away from any midnight/day-start edge.
    const ts = new Date('2024-01-15T12:00:00Z')
    const result = bucketTimestamp(ts, TIMELINE_4AM)
    // Extract local components the same way the function does (via Date local methods)
    const localDate =
      String(ts.getFullYear()) +
      '-' +
      String(ts.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(ts.getDate()).padStart(2, '0')
    const localTime =
      String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0')
    const expected = bucketLocalDateTime(localDate, localTime, TIMELINE_4AM)
    expect(result).toBe(expected)
  })
})
