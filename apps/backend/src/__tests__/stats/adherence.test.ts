// §3.1 Adherence — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// Covers:
//   raw adherence (including excused) is the default headline
//   adherence-excluding-excused is the secondary lens
//   excuse rate is a first-class stat (excused / misses)
//   leaf adherence is binary hit-rate
//   parent adherence uses mean of daily derived percentages
//   parents always return a per-child breakdown
//   not-due children excluded from the denominator (Tuesday/MWF case)
//   every finding includes raw counts
//   user_id scoping

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { getItemAdherence } from '../../stats/index'
import type { Item, RecurrenceRule } from '@tracker/shared'
import type { DateWindow } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A week containing Mon 13, Tue 14, Wed 15 Jan 2025
const MON = '2025-01-13'
const TUE = '2025-01-14'
const WED = '2025-01-15'
const THU = '2025-01-16'
const FRI = '2025-01-17'

const WEEK: DateWindow = { startDay: MON, endDay: FRI }

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `adh-${suffix}@test.com` })
}

async function makeDailyHabit(userId: string, name = 'Daily') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned',
  })
}

async function makeMWFHabit(userId: string, name = 'MWF') {
  return repos.insertItem(getTestPool(), {
    userId, name,
    recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },  // Mon=1, Wed=3, Fri=5
    creationSource: 'planned',
  })
}

async function makeParent(userId: string, name = 'Parent') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned',
  })
}

async function makeChild(userId: string, parentId: string, name = 'Child', rule: RecurrenceRule = { type: 'daily' }) {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: rule, parentId, creationSource: 'planned',
  })
}

// Materialize and complete a leaf on a given day
async function complete(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'item_completed',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
}

// Materialize and excuse a leaf on a given day
async function excuse(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'excused',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { reasonId: null, comment: null },
  })
}

// Materialize and skip a leaf on a given day
async function skip(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'skipped',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { reasonId: null, comment: null },
  })
}

// ── §3.1 Leaf adherence: binary hit-rate ─────────────────────────────────────

describe('§3.1 leaf adherence is binary — 0% or 100%', () => {
  it('§3.1 leaf adherence counts only completion events at 100% as hits', async () => {
    const u = await makeUser('leaf-binary')
    const habit = await makeDailyHabit(u.id)

    // Complete Mon, skip Tue, do nothing Wed-Fri
    await complete(habit, MON, u.id)
    await skip(habit, TUE, u.id)

    const finding = await getItemAdherence(getTestPool(), u.id, habit.id, WEEK)
    expect(finding.type).toBe('leaf_adherence')
    if (finding.type !== 'leaf_adherence') return

    expect(finding.rawCounts.dueCount).toBe(5)       // Mon-Fri
    expect(finding.rawCounts.completedCount).toBe(1)  // Mon only
    expect(finding.rawCounts.skippedCount).toBe(1)    // Tue
  })
})

describe('§3.1 raw adherence including excused is the default headline', () => {
  it('§3.1 rawAdherence includes excused days in denominator', async () => {
    const u = await makeUser('raw-excused')
    const habit = await makeDailyHabit(u.id)

    // 3/5 days completed, 1 excused, 1 skipped
    await complete(habit, MON, u.id)
    await complete(habit, WED, u.id)
    await complete(habit, FRI, u.id)
    await excuse(habit, TUE, u.id)
    await skip(habit, THU, u.id)

    const finding = await getItemAdherence(getTestPool(), u.id, habit.id, WEEK)
    expect(finding.type).toBe('leaf_adherence')
    if (finding.type !== 'leaf_adherence') return

    // rawAdherence = 3/5 = 0.6 (excused counts in denominator)
    expect(finding.rawAdherence).toBeCloseTo(3 / 5)
    expect(finding.rawCounts.excusedCount).toBe(1)
  })
})

describe('§3.1 adherence-excluding-excused is the secondary lens', () => {
  it('§3.1 adherenceExclExcused excludes excused days from denominator', async () => {
    const u = await makeUser('excl-excused')
    const habit = await makeDailyHabit(u.id)

    await complete(habit, MON, u.id)
    await complete(habit, WED, u.id)
    await excuse(habit, TUE, u.id)
    // THU, FRI: skipped/pending → 2 non-excused misses

    const finding = await getItemAdherence(getTestPool(), u.id, habit.id, WEEK)
    expect(finding.type).toBe('leaf_adherence')
    if (finding.type !== 'leaf_adherence') return

    // dueCount=5, excusedCount=1, completedCount=2
    // adherenceExclExcused = 2 / (5 - 1) = 0.5
    expect(finding.adherenceExclExcused).toBeCloseTo(2 / 4)
  })
})

describe('§3.1 excuse rate is a first-class stat — excused / misses', () => {
  it('§3.1 excuseRate = excusedCount / (dueCount - completedCount)', async () => {
    const u = await makeUser('excuse-rate')
    const habit = await makeDailyHabit(u.id)

    // 2 completed, 2 excused, 1 skipped → misses = 3
    await complete(habit, MON, u.id)
    await complete(habit, TUE, u.id)
    await excuse(habit, WED, u.id)
    await excuse(habit, THU, u.id)
    await skip(habit, FRI, u.id)

    const finding = await getItemAdherence(getTestPool(), u.id, habit.id, WEEK)
    expect(finding.type).toBe('leaf_adherence')
    if (finding.type !== 'leaf_adherence') return

    // misses = 5 - 2 = 3; excuseRate = 2/3
    expect(finding.excuseRate).toBeCloseTo(2 / 3)
    expect(finding.rawCounts.excusedCount).toBe(2)
  })

  it('§3.1 excuseRate is 0 when no misses', async () => {
    const u = await makeUser('excuse-rate-zero')
    const habit = await makeDailyHabit(u.id)

    await complete(habit, MON, u.id)
    await complete(habit, TUE, u.id)
    await complete(habit, WED, u.id)
    await complete(habit, THU, u.id)
    await complete(habit, FRI, u.id)

    const finding = await getItemAdherence(getTestPool(), u.id, habit.id, WEEK)
    expect(finding.type).toBe('leaf_adherence')
    if (finding.type !== 'leaf_adherence') return
    expect(finding.excuseRate).toBe(0)
    expect(finding.rawAdherence).toBe(1)
  })
})

// ── §3.1 Parent adherence: mean of daily derived percentages ─────────────────

describe('§3.1 parent adherence uses mean of daily derived percentages', () => {
  it('§3.1 parent adherence = mean derived % across due days', async () => {
    const u = await makeUser('parent-derived')
    const parent = await makeParent(u.id, 'Routine')
    const child  = await makeChild(u.id, parent.id, 'Step')

    // Mon: child NOT done → derived 0%
    // Tue: child done → derived 100%
    // Wed: child done → derived 100%
    // Thu, Fri: child pending → derived 0%
    await complete(child, TUE, u.id)
    await complete(child, WED, u.id)

    const finding = await getItemAdherence(getTestPool(), u.id, parent.id, WEEK)
    expect(finding.type).toBe('parent_adherence')
    if (finding.type !== 'parent_adherence') return

    // derived: Mon=0, Tue=100, Wed=100, Thu=0, Fri=0 → mean = 200/5 = 40
    expect(finding.meanDerivedPercent).toBeCloseTo(40)
  })
})

// ── §3.1 Parents always include per-child breakdown ──────────────────────────

describe('§3.1 parents always return a per-child breakdown', () => {
  it('§3.1 parent finding includes children array', async () => {
    const u = await makeUser('parent-children')
    const parent = await makeParent(u.id, 'Night Routine')
    const child1 = await makeChild(u.id, parent.id, 'Brush Teeth')
    const child2 = await makeChild(u.id, parent.id, 'Meditate')

    const finding = await getItemAdherence(getTestPool(), u.id, parent.id, WEEK)
    expect(finding.type).toBe('parent_adherence')
    if (finding.type !== 'parent_adherence') return

    expect(finding.children).toHaveLength(2)
    const childIds = finding.children.map(c => c.itemId)
    expect(childIds).toContain(child1.id)
    expect(childIds).toContain(child2.id)
  })

  it('§3.1 per-child breakdown shows where adherence drops', async () => {
    const u = await makeUser('child-breakdown')
    const parent = await makeParent(u.id, 'Routine')
    const alwaysDone = await makeChild(u.id, parent.id, 'Always')
    const neverDone  = await makeChild(u.id, parent.id, 'Never')

    // Always done Mon-Fri
    for (const day of [MON, TUE, WED, THU, FRI]) {
      await complete(alwaysDone, day, u.id)
    }
    // Never done: no events

    const finding = await getItemAdherence(getTestPool(), u.id, parent.id, WEEK)
    expect(finding.type).toBe('parent_adherence')
    if (finding.type !== 'parent_adherence') return

    const alwaysFinding = finding.children.find(c => c.itemId === alwaysDone.id)
    const neverFinding  = finding.children.find(c => c.itemId === neverDone.id)
    expect(alwaysFinding!.rawAdherence).toBe(1)     // 5/5
    expect(neverFinding!.rawAdherence).toBe(0)       // 0/5
  })
})

// ── §3.1 Not-due children excluded from denominator (Tuesday/MWF case) ────────

describe('§3.1 not-due children excluded from parent denominator (Tuesday/MWF case)', () => {
  it('§3.1 MWF child not counted on Tuesday — parent vacuously 100% on non-due days', async () => {
    const u = await makeUser('mwf-tuesday')
    const parent  = await makeParent(u.id, 'Night Routine')
    // Tretinoin is MWF only (days_of_week: Mon=1, Wed=3, Fri=5)
    const tretinoin = await makeChild(u.id, parent.id, 'Tretinoin', {
      type: 'days_of_week', days: [1, 3, 5],
    })

    // Tuesday: Tretinoin not due → parent vacuously 100%
    // Wednesday: Tretinoin due but not completed → parent 0%
    // Monday: Tretinoin due and completed → parent 100%
    await complete(tretinoin, MON, u.id)
    // WED: Tretinoin due, not completed → parent derived = 0

    const finding = await getItemAdherence(getTestPool(), u.id, parent.id, WEEK)
    expect(finding.type).toBe('parent_adherence')
    if (finding.type !== 'parent_adherence') return

    // Mon=100%, Tue=100% (no due child → vacuous), Wed=0%, Thu=100% (vacuous), Fri=0%
    // mean = (100+100+0+100+0)/5 = 60%
    expect(finding.meanDerivedPercent).toBeCloseTo(60)
  })

  it('§3.1 MWF child due-day count = 3, not 5 (Tuesday excluded from denominator)', async () => {
    const u = await makeUser('mwf-child-count')
    const parent  = await makeParent(u.id, 'Routine')
    const mwfChild = await makeChild(u.id, parent.id, 'MWF Step', {
      type: 'days_of_week', days: [1, 3, 5],
    })

    const finding = await getItemAdherence(getTestPool(), u.id, parent.id, WEEK)
    expect(finding.type).toBe('parent_adherence')
    if (finding.type !== 'parent_adherence') return

    // Child has dueCount=3 (Mon, Wed, Fri), not 5
    const childFinding = finding.children.find(c => c.itemId === mwfChild.id)
    expect(childFinding!.rawCounts.dueCount).toBe(3)
  })
})

// ── §3.1 Every finding includes raw counts ────────────────────────────────────

describe('§3.1 every finding includes raw counts', () => {
  it('§3.1 leaf finding has rawCounts with all required fields', async () => {
    const u = await makeUser('leaf-raw-counts')
    const habit = await makeDailyHabit(u.id)
    await complete(habit, MON, u.id)

    const finding = await getItemAdherence(getTestPool(), u.id, habit.id, WEEK)
    expect(finding.type).toBe('leaf_adherence')
    if (finding.type !== 'leaf_adherence') return

    expect(finding.rawCounts).toMatchObject({
      dueCount: expect.any(Number),
      completedCount: expect.any(Number),
      excusedCount: expect.any(Number),
      skippedCount: expect.any(Number),
      autoCloseCount: expect.any(Number),
      missingCount: expect.any(Number),
    })
  })

  it('§3.1 parent finding has rawCounts with required fields', async () => {
    const u = await makeUser('parent-raw-counts')
    const parent = await makeParent(u.id)
    await makeChild(u.id, parent.id)

    const finding = await getItemAdherence(getTestPool(), u.id, parent.id, WEEK)
    expect(finding.type).toBe('parent_adherence')
    if (finding.type !== 'parent_adherence') return

    expect(finding.rawCounts).toMatchObject({
      dueCount: expect.any(Number),
      excusedCount: expect.any(Number),
      missingCount: expect.any(Number),
      declaredOverrideCount: expect.any(Number),
    })
  })
})

// ── §13.4 user_id scoping ─────────────────────────────────────────────────────

describe('§13.4 adherence is user_id scoped', () => {
  it('§13.4 user A cannot see user B adherence data', async () => {
    const ua = await makeUser('scope-a')
    const ub = await makeUser('scope-b')
    const habitA = await makeDailyHabit(ua.id, 'Habit A')
    const habitB = await makeDailyHabit(ub.id, 'Habit B')

    await complete(habitA, MON, ua.id)

    // User B querying user A's item should throw (item not found)
    await expect(getItemAdherence(getTestPool(), ub.id, habitA.id, WEEK)).rejects.toThrow()
  })

  it('§13.4 adherence counts only events for the correct user', async () => {
    const ua = await makeUser('scope-count-a')
    const ub = await makeUser('scope-count-b')
    const habitA = await makeDailyHabit(ua.id, 'SharedName')
    const habitB = await makeDailyHabit(ub.id, 'SharedName')

    await complete(habitA, MON, ua.id)
    await complete(habitA, TUE, ua.id)
    // user B has no completions

    const findingA = await getItemAdherence(getTestPool(), ua.id, habitA.id, WEEK)
    const findingB = await getItemAdherence(getTestPool(), ub.id, habitB.id, WEEK)

    expect(findingA.type).toBe('leaf_adherence')
    expect(findingB.type).toBe('leaf_adherence')
    if (findingA.type !== 'leaf_adherence' || findingB.type !== 'leaf_adherence') return

    expect(findingA.rawCounts.completedCount).toBe(2)
    expect(findingB.rawCounts.completedCount).toBe(0)
  })
})
