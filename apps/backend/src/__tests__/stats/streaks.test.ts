// §3.2 Streak — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// Covers:
//   daily streak type (consecutive days at 100%)
//   quota streak type (consecutive periods hitting quotaTarget.count, §3.2.2)
//   excused days skip the chain — neither break nor extend
//   §3.2.1 resolution — the current day never breaks the chain; past pending days do
//   §3.2.3 boundary-partial periods
//   §3.2.4 currentStreak is not window-scoped
//   §3.2.5 the ambient summary (streak paired with its 30-day rate)
//   raw counts on every finding
//
// Every test pins `now` explicitly. Streak semantics are anchored to the current
// logical day (§3.2.1), so a test that let the real clock in would change meaning
// as it aged — a latent flake, which §"flaky tests are defects" forbids.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { getItemStreak, getStreakSummaries } from '../../stats/index'
import type { Item, QuotaTarget } from '@tracker/shared'
import type { DateWindow } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Week: Mon 13 Jan 2025 → Fri 17 Jan 2025 ─────────────────────────────────
const MON = '2025-01-13'
const TUE = '2025-01-14'
const WED = '2025-01-15'
const THU = '2025-01-16'
const FRI = '2025-01-17'
// Second week for quota streak tests
const MON2 = '2025-01-20'
const TUE2 = '2025-01-21'

const WEEK: DateWindow = { startDay: MON, endDay: FRI }
const TWO_WEEKS: DateWindow = { startDay: MON, endDay: TUE2 }

// Local noon of `day` — the date is then the same in every timezone, so
// logicalToday() (which reads the host's local calendar date) is deterministic.
function noonOf(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0)
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `streak-${suffix}@test.com` })
}

// anchorDay is set explicitly so the item's history window (§3.2.4 walks back to
// the anchor) is pinned to the fixture range rather than to the real creation date.
async function makeDaily(userId: string, name = 'Daily', anchorDay = MON) {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, anchorDay, creationSource: 'planned',
  })
}

async function makeQuota(
  userId: string,
  quotaTarget: QuotaTarget = { count: 1, period: 'week' },
  name = 'Quota',
  anchorDay = MON
) {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' },
    anchorDay, quotaTarget, creationSource: 'planned',
  })
}

async function complete(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'item_completed',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
}

async function excuse(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'excused',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { reasonId: null, comment: null },
  })
}

async function skip(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'skipped',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { reasonId: null, comment: null },
  })
}

// ── §3.2 Daily streak type ────────────────────────────────────────────────────

describe('§3.2 daily streak — consecutive days where completionPercent >= 100', () => {
  it('§3.2 currentStreak counts consecutive completions up to the current day', async () => {
    const u = await makeUser('daily-current')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    // Tue: no completion (pending) — break
    await complete(h, WED, u.id)
    await complete(h, THU, u.id)
    await complete(h, FRI, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.streakType).toBe('daily')
    expect(finding.currentStreak).toBe(3)  // Wed, Thu, Fri
    expect(finding.longestStreak).toBe(3)
  })

  it('§3.2 longestStreak tracks the widest run found', async () => {
    const u = await makeUser('daily-longest')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    await complete(h, WED, u.id)
    // Thu: skip — break
    await skip(h, THU, u.id)
    await complete(h, FRI, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.longestStreak).toBe(3)  // Mon–Wed
    expect(finding.currentStreak).toBe(1)  // Fri only
  })

  it('§3.2 all completions → streak = 5 for 5-day window', async () => {
    const u = await makeUser('daily-all')
    const h = await makeDaily(u.id)

    for (const day of [MON, TUE, WED, THU, FRI]) {
      await complete(h, day, u.id)
    }

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.currentStreak).toBe(5)
    expect(finding.longestStreak).toBe(5)
  })

  it('§3.2 no completions → streak = 0', async () => {
    const u = await makeUser('daily-none')
    const h = await makeDaily(u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
  })
})

// ── §3.2.1 Resolution — an unfinished day is not a miss ──────────────────────

describe('§3.2.1 the current day never breaks the chain', () => {
  it('§3.2.1 an as-yet-incomplete current day leaves the streak intact', async () => {
    const u = await makeUser('today-no-break')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    await complete(h, WED, u.id)
    // THU is the current day and is not done yet — it is neither hit nor miss.

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(THU))
    expect(finding.currentStreak).toBe(3)
    expect(finding.currentDayPending).toBe(true)
  })

  it('§3.2.1 completing the current day extends the chain', async () => {
    const u = await makeUser('today-extends')
    const h = await makeDaily(u.id)

    for (const day of [MON, TUE, WED, THU]) {
      await complete(h, day, u.id)
    }

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(THU))
    expect(finding.currentStreak).toBe(4)
    expect(finding.currentDayPending).toBe(false)
  })

  it('§3.2.1 a PAST pending day is a resolved miss and does break the chain', async () => {
    const u = await makeUser('past-pending-breaks')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    // TUE: never touched, and the day has since ended → a real miss
    await complete(h, WED, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(WED))
    expect(finding.currentStreak).toBe(1)  // Wed only — Tue broke it
  })

  it('§3.2.1 an excused current day is not reported as pending', async () => {
    const u = await makeUser('today-excused')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    await complete(h, WED, u.id)
    await excuse(h, THU, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(THU))
    expect(finding.currentStreak).toBe(3)
    expect(finding.currentDayPending).toBe(false)
  })
})

// ── §3.2.4 Current streak is not window-scoped ───────────────────────────────

describe('§3.2.4 currentStreak is identical whichever window is requested', () => {
  it('§3.2.4 a narrow and a wide window report the same currentStreak', async () => {
    const u = await makeUser('window-independent')
    const h = await makeDaily(u.id)

    for (const day of [MON, TUE, WED, THU, FRI]) {
      await complete(h, day, u.id)
    }

    const narrow = await getItemStreak(getTestPool(), u.id, h.id, { startDay: THU, endDay: FRI }, noonOf(FRI))
    const wide = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))

    // The chain is 5 days long; the narrow window can only SEE 2 of them.
    expect(narrow.currentStreak).toBe(5)
    expect(wide.currentStreak).toBe(5)
    // longestStreak, by contrast, is deliberately window-scoped.
    expect(narrow.longestStreak).toBe(2)
    expect(wide.longestStreak).toBe(5)
  })
})

// ── §3.2 Excused days skip the chain ─────────────────────────────────────────

describe('§3.2 excused days skip the chain — neither break nor extend', () => {
  it('§3.2 excused between two completions does not break the streak', async () => {
    const u = await makeUser('excused-no-break')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await excuse(h, TUE, u.id)   // should skip, not break
    await complete(h, WED, u.id)

    const window = { startDay: MON, endDay: WED }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf(WED))
    // Mon=1, Tue=excused (skipped), Wed=2 → streak 2 through excused day
    expect(finding.currentStreak).toBe(2)
    expect(finding.longestStreak).toBe(2)
  })

  it('§3.2 sequence [complete, excused, complete] yields longestStreak 2, not 1', async () => {
    const u = await makeUser('excused-chain')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await excuse(h, TUE, u.id)
    await complete(h, WED, u.id)
    // Thu: a resolved miss; Fri: the current day (unresolved)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.longestStreak).toBe(2)
  })

  it('§3.2 excused does not extend streak — [excused, complete] yields streak 1 not 2', async () => {
    const u = await makeUser('excused-no-extend')
    const h = await makeDaily(u.id)

    await excuse(h, MON, u.id)   // skipped in chain
    await complete(h, TUE, u.id)

    const window = { startDay: MON, endDay: TUE }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf(TUE))
    expect(finding.currentStreak).toBe(1)
  })

  it('§3.2 excused-only window → streak 0 (excused do not count as completions)', async () => {
    const u = await makeUser('all-excused')
    const h = await makeDaily(u.id)

    for (const day of [MON, TUE, WED, THU, FRI]) {
      await excuse(h, day, u.id)
    }

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
  })
})

// ── §3.2 Skipped / pending days break the streak ─────────────────────────────

describe('§3.2 skipped and past-pending days break the daily streak', () => {
  it('§3.2 skipped day resets current streak to 0', async () => {
    const u = await makeUser('skip-breaks')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    await skip(h, WED, u.id)
    await complete(h, THU, u.id)

    const window = { startDay: MON, endDay: THU }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf(THU))
    expect(finding.currentStreak).toBe(1)    // Thu only (Wed skip broke the run)
    expect(finding.longestStreak).toBe(2)    // Mon–Tue
  })

  it('§3.2 pending (no event) day breaks the streak once that day has ended', async () => {
    const u = await makeUser('pending-breaks')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    // TUE: no event — pending, and by FRI it is a resolved miss
    await complete(h, WED, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.longestStreak).toBe(1)  // single day runs only
  })
})

// ── §3.2.2 Quota streaks count against the item's actual target ──────────────

describe('§3.2.2 a quota period is a hit only when completions reach quotaTarget.count', () => {
  it('§3.2.2 a week short of the target does not count as a hit', async () => {
    const u = await makeUser('quota-under-target')
    const h = await makeQuota(u.id, { count: 3, period: 'week' })

    // Week Jan 13–19: only 2 completions against a target of 3.
    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)

    // Current day is in the FOLLOWING week, so Jan 13–19 is fully resolved.
    const window: DateWindow = { startDay: MON, endDay: '2025-01-26' }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf(MON2))
    expect(finding.streakType).toBe('quota')
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
  })

  it('§3.2.2 a week that reaches the target counts as a hit', async () => {
    const u = await makeUser('quota-meets-target')
    const h = await makeQuota(u.id, { count: 3, period: 'week' })

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    await complete(h, WED, u.id)

    const window: DateWindow = { startDay: MON, endDay: '2025-01-26' }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf(MON2))
    expect(finding.currentStreak).toBe(1)
    expect(finding.longestStreak).toBe(1)
  })

  it('§3.2.2 a monthly quota groups by calendar month, not by ISO week', async () => {
    const u = await makeUser('quota-monthly')
    const h = await makeQuota(u.id, { count: 2, period: 'month' }, 'Monthly', '2025-01-01')

    // Two completions in January, deliberately in DIFFERENT ISO weeks: under the
    // old week-grouping neither week reaches 2 and the streak would be 0.
    await complete(h, '2025-01-06', u.id)
    await complete(h, '2025-01-27', u.id)

    const window: DateWindow = { startDay: '2025-01-01', endDay: '2025-02-28' }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf('2025-02-28'))
    expect(finding.currentStreak).toBe(1)   // January hit; February still in progress
    expect(finding.currentPeriodProgress).toEqual({ completed: 0, target: 2, period: 'month' })
  })

  it('§3.2.2 currentPeriodProgress reports the in-progress period against its target', async () => {
    const u = await makeUser('quota-progress')
    const h = await makeQuota(u.id, { count: 4, period: 'week' })

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)

    // Current day is Wednesday of the same week — the period is not over.
    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(WED))
    expect(finding.currentPeriodProgress).toEqual({ completed: 2, target: 4, period: 'week' })
    // The unfinished week has not failed, so it neither counts nor breaks (§3.2.1).
    expect(finding.currentStreak).toBe(0)
  })
})

describe('§3.2 quota streak — consecutive periods hitting target', () => {
  it('§3.2 quota streak counts consecutive weeks that hit target', async () => {
    const u = await makeUser('quota-basic')
    const h = await makeQuota(u.id)

    await complete(h, TUE, u.id)    // week 1
    await complete(h, MON2, u.id)   // week 2

    const finding = await getItemStreak(getTestPool(), u.id, h.id, TWO_WEEKS, noonOf(TUE2))
    expect(finding.streakType).toBe('quota')
    expect(finding.currentStreak).toBe(2)
  })

  it('§3.2 quota streak: excused-only period is skipped (neither breaks nor extends)', async () => {
    const u = await makeUser('quota-excused-week')
    const h = await makeQuota(u.id)

    await complete(h, MON, u.id)    // week 1: hit
    for (const day of [MON2, TUE2]) {
      await excuse(h, day, u.id)    // week 2: every due day excused
    }

    const finding = await getItemStreak(getTestPool(), u.id, h.id, TWO_WEEKS, noonOf(TUE2))
    expect(finding.currentStreak).toBe(1)
  })

  it('§3.2 quota streak = 0 when no completions', async () => {
    const u = await makeUser('quota-zero')
    const h = await makeQuota(u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
  })
})

// ── §3.2.3 Boundary-partial periods ──────────────────────────────────────────

describe('§3.2.3 a boundary-partial period that already meets the target is a hit', () => {
  it('§3.2.3 hitting the target inside the clipped days counts, and extends the chain', async () => {
    const u = await makeUser('quota-partial-hit')
    // Anchored mid-week (Thu 16 Jan), so the item's first week is clipped: its only
    // due days are Thu and Fri.
    const h = await makeQuota(u.id, { count: 2, period: 'week' }, 'Partial', THU)

    await complete(h, THU, u.id)
    await complete(h, FRI, u.id)   // 2 of 2 inside the clipped week → a genuine hit
    await complete(h, MON2, u.id)
    await complete(h, TUE2, u.id)  // full following week also hits

    // Current day is in the week after both, so both are resolved.
    const window: DateWindow = { startDay: THU, endDay: '2025-01-29' }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window, noonOf('2025-01-29'))
    expect(finding.currentStreak).toBe(2)   // the clipped week counted
    expect(finding.longestStreak).toBe(2)
  })
})

// ── §3.2.5 The ambient summary ───────────────────────────────────────────────

describe('§3.2.5 the ambient summary pairs every streak with its 30-day rate', () => {
  it('§3.2.5 returns currentStreak and adherenceRate30d together for a recurring item', async () => {
    const u = await makeUser('summary-pairs')
    const anchor = '2025-01-01'
    const h = await makeDaily(u.id, 'Summary daily', anchor)

    // Complete the three days ending the day before the current day.
    for (const day of ['2025-01-13', '2025-01-14', '2025-01-15']) {
      await complete(h, day, u.id)
    }

    const summary = await getStreakSummaries(getTestPool(), u.id, noonOf('2025-01-16'))
    expect(summary.type).toBe('streak_summary')
    expect(summary.asOfDay).toBe('2025-01-16')

    const row = summary.items.find(i => i.itemId === h.id)
    expect(row).toBeDefined()
    expect(row!.currentStreak).toBe(3)
    // The rate window ends YESTERDAY (§3.2.5), so the unresolved current day is not
    // dragging the denominator down: due days 2024-12-17…2025-01-15 that exist from
    // the anchor onward are 2025-01-01…2025-01-15 = 15 days, 3 of them completed.
    expect(row!.adherenceDueCount30d).toBe(15)
    expect(row!.adherenceRate30d).toBeCloseTo(3 / 15)
  })

  it('§3.2.5 excludes one-time items — a streak is a property of a recurrence', async () => {
    const u = await makeUser('summary-one-time')
    const recurring = await makeDaily(u.id, 'Recurring')
    const oneTime = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'One-time', recurrenceRule: null, creationSource: 'planned',
    })

    const summary = await getStreakSummaries(getTestPool(), u.id, noonOf(FRI))
    const ids = summary.items.map(i => i.itemId)
    expect(ids).toContain(recurring.id)
    expect(ids).not.toContain(oneTime.id)
  })

  it('§3.2.5 reports the excused count, so the UI can say an excused day did not break the chain', async () => {
    const u = await makeUser('summary-excused')
    const h = await makeDaily(u.id, 'Excused daily', MON)

    await complete(h, MON, u.id)
    await excuse(h, TUE, u.id)
    await complete(h, WED, u.id)

    const summary = await getStreakSummaries(getTestPool(), u.id, noonOf(THU))
    const row = summary.items.find(i => i.itemId === h.id)!
    expect(row.currentStreak).toBe(2)      // the excused day did not break it
    expect(row.excusedCount30d).toBe(1)
  })

  it('§3.2.5 reports quota progress on the summary row', async () => {
    const u = await makeUser('summary-quota')
    const h = await makeQuota(u.id, { count: 4, period: 'week' }, 'Quota summary')

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)

    const summary = await getStreakSummaries(getTestPool(), u.id, noonOf(WED))
    const row = summary.items.find(i => i.itemId === h.id)!
    expect(row.streakType).toBe('quota')
    expect(row.currentPeriodProgress).toEqual({ completed: 2, target: 4, period: 'week' })
  })
})

// ── §3.2 Raw counts on every finding ─────────────────────────────────────────

describe('§3.2 every streak finding includes rawCounts', () => {
  it('§3.2 rawCounts has dueCount, completedCount, excusedCount', async () => {
    const u = await makeUser('streak-raw')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await excuse(h, TUE, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK, noonOf(FRI))
    expect(finding.rawCounts).toMatchObject({
      dueCount: expect.any(Number),
      completedCount: expect.any(Number),
      excusedCount: expect.any(Number),
    })
    expect(finding.rawCounts.completedCount).toBe(1)
    expect(finding.rawCounts.excusedCount).toBe(1)
    expect(finding.rawCounts.dueCount).toBe(5)
  })
})
