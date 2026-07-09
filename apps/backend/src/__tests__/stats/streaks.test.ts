// §3.2 Streak — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// Covers:
//   daily streak type (consecutive days at 100%)
//   quota streak type (consecutive weeks with ≥1 completion)
//   excused days skip the chain — neither break nor extend the streak
//   missing / skipped / pending days break the streak
//   raw counts on every finding

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { getItemStreak } from '../../stats/index'
import type { Item } from '@tracker/shared'
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

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `streak-${suffix}@test.com` })
}

async function makeDaily(userId: string, name = 'Daily') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned',
  })
}

async function makeQuota(userId: string, name = 'Quota') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' },
    quotaTarget: { count: 1, period: 'week' }, creationSource: 'planned',
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
  it('§3.2 currentStreak counts consecutive completions from end of window', async () => {
    const u = await makeUser('daily-current')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    // Tue: no completion (pending) — break
    await complete(h, WED, u.id)
    await complete(h, THU, u.id)
    await complete(h, FRI, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
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

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(finding.longestStreak).toBe(3)  // Mon–Wed
    expect(finding.currentStreak).toBe(1)  // Fri only
  })

  it('§3.2 all completions → streak = 5 for 5-day window', async () => {
    const u = await makeUser('daily-all')
    const h = await makeDaily(u.id)

    for (const day of [MON, TUE, WED, THU, FRI]) {
      await complete(h, day, u.id)
    }

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(finding.currentStreak).toBe(5)
    expect(finding.longestStreak).toBe(5)
  })

  it('§3.2 no completions → streak = 0', async () => {
    const u = await makeUser('daily-none')
    const h = await makeDaily(u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
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

    // Window ends at WED so there are no trailing missing days
    const window = { startDay: MON, endDay: WED }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window)
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
    // Thu, Fri: pending — these trailing missing days reset currentStreak to 0

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    // The longest run spanning the excused day is 2
    expect(finding.longestStreak).toBe(2)
  })

  it('§3.2 excused does not extend streak — [excused, complete] yields streak 1 not 2', async () => {
    const u = await makeUser('excused-no-extend')
    const h = await makeDaily(u.id)

    await excuse(h, MON, u.id)   // skipped in chain
    await complete(h, TUE, u.id)

    // Window ends at TUE so there are no trailing missing days
    const window = { startDay: MON, endDay: TUE }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window)
    // Mon excused is skipped; Tue completes = streak 1 (excused did not add to it)
    expect(finding.currentStreak).toBe(1)
  })

  it('§3.2 excused-only window → streak 0 (excused do not count as completions)', async () => {
    const u = await makeUser('all-excused')
    const h = await makeDaily(u.id)

    for (const day of [MON, TUE, WED, THU, FRI]) {
      await excuse(h, day, u.id)
    }

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
  })
})

// ── §3.2 Skipped / pending days break the streak ─────────────────────────────

describe('§3.2 skipped and pending days break the daily streak', () => {
  it('§3.2 skipped day resets current streak to 0', async () => {
    const u = await makeUser('skip-breaks')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    await skip(h, WED, u.id)
    await complete(h, THU, u.id)

    // Window ends at THU to avoid trailing missing FRI resetting currentStreak
    const window = { startDay: MON, endDay: THU }
    const finding = await getItemStreak(getTestPool(), u.id, h.id, window)
    expect(finding.currentStreak).toBe(1)    // Thu only (Wed skip broke the run)
    expect(finding.longestStreak).toBe(2)    // Mon–Tue
  })

  it('§3.2 pending (no event) day breaks the streak', async () => {
    const u = await makeUser('pending-breaks')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    // TUE: no event — pending → break
    await complete(h, WED, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(finding.longestStreak).toBe(1)  // single day runs only
  })
})

// ── §3.2 Quota streak type ────────────────────────────────────────────────────

describe('§3.2 quota streak — consecutive periods with ≥1 completion', () => {
  it('§3.2 quota streak counts consecutive weeks with at least one completion', async () => {
    const u = await makeUser('quota-basic')
    const h = await makeQuota(u.id)

    // Week 1: complete on Tuesday
    await complete(h, TUE, u.id)
    // Week 2: complete on Monday
    await complete(h, MON2, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, TWO_WEEKS)
    expect(finding.streakType).toBe('quota')
    expect(finding.currentStreak).toBe(2)
  })

  it('§3.2 quota streak: excused-only week is skipped (neither breaks nor extends)', async () => {
    const u = await makeUser('quota-excused-week')
    const h = await makeQuota(u.id)

    await complete(h, MON, u.id)    // week 1: hit
    // Week 2: all excused → skip week
    for (const day of [MON2, TUE2]) {
      await excuse(h, day, u.id)
    }

    // We need a 3-week window for this test; simulate with week 1 + week 2
    // Week 1 hit, week 2 all excused (skipped) — streak stays
    const finding = await getItemStreak(getTestPool(), u.id, h.id, TWO_WEEKS)
    expect(finding.streakType).toBe('quota')
    // Week 1 has a completion; week 2 is all excused → skipped → streak = 1
    expect(finding.currentStreak).toBe(1)
  })

  it('§3.2 quota streak = 0 when no completions', async () => {
    const u = await makeUser('quota-zero')
    const h = await makeQuota(u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(finding.currentStreak).toBe(0)
    expect(finding.longestStreak).toBe(0)
  })
})

// ── §3.2 Raw counts on every finding ─────────────────────────────────────────

describe('§3.2 every streak finding includes rawCounts', () => {
  it('§3.2 rawCounts has dueCount, completedCount, excusedCount', async () => {
    const u = await makeUser('streak-raw')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await excuse(h, TUE, u.id)

    const finding = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
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
