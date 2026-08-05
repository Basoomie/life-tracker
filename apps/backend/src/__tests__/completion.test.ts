// §6.1–6.4 — Completion integration tests.
// Named after the spec's stated rules; test list should read the design back.
// All tests hit a real database via the test pool.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import {
  completeLeaf,
  uncompleteLeaf,
  completeRetroactive,
  completeChild,
  uncompleteChild,
  declareParentPercent,
  getLeafCompletionState,
  getParentCompletionState,
} from '../domain/completion'
import { ensureOccurrenceForItemDay } from '../domain/materialization'
import { skipOccurrenceByUser, excuseOccurrenceByUser } from '../domain/dispositions'
import type { Item, Occurrence } from '@tracker/shared'
import { createItem } from '../domain/items'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = '2025-01-15'   // Wednesday
const MONDAY  = '2025-01-13' // Monday (MWF due)
const TUESDAY = '2025-01-14' // Tuesday (MWF NOT due)

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function makeTask(userId: string, name = 'Task', opts: Partial<Parameters<typeof createItem>[1]> = {}) {
  return createItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: null,   // one-time task, not a habit
    creationSource: 'planned',
    ...opts,
  })
}

async function makeHabit(userId: string, name = 'Habit') {
  return createItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'daily' },
    creationSource: 'planned',
  })
}

async function makeMWFHabit(userId: string, name = 'MWF Habit') {
  return createItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },   // Mon/Wed/Fri
    creationSource: 'planned',
  })
}

async function makeDailyHabit(
  userId: string,
  name = 'Daily Habit',
  opts: Partial<Parameters<typeof createItem>[1]> = {}
) {
  return createItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'daily' },
    creationSource: 'planned',
    ...opts,
  })
}

// Create and materialize an occurrence for a given item and day
async function materialize(item: Item, day: string, userId: string): Promise<Occurrence> {
  return ensureOccurrenceForItemDay(getTestPool(), item, day, userId)
}

// ── §6.1 Leaf completion ──────────────────────────────────────────────────────

describe('§6.1 leaf completion is binary — 0% or 100%', () => {
  it('§6.1 leaf starts at 0% before any events', async () => {
    const u = await makeUser('comp-leaf-zero@test.com')
    const item = await makeTask(u.id, 'Leaf zero')
    const occ = await materialize(item, TODAY, u.id)

    const state = await getLeafCompletionState(getTestPool(), occ, u.id)
    expect(state.completionPercent).toBe(0)
    expect(state.completedAt).toBeNull()
  })

  it('§6.1 completeLeaf fires item_completed at 100%', async () => {
    const u = await makeUser('comp-leaf-complete@test.com')
    const item = await makeTask(u.id, 'Leaf complete')
    const occ = await materialize(item, TODAY, u.id)

    const event = await completeLeaf(getTestPool(), occ, u.id)
    expect(event.eventType).toBe('item_completed')
    expect((event.payload as any).completionPercent).toBe(100)

    const state = await getLeafCompletionState(getTestPool(), occ, u.id)
    expect(state.completionPercent).toBe(100)
    expect(state.completedAt).toBeInstanceOf(Date)
    expect(state.wasRetroactive).toBe(false)
  })

  it('§6.1 uncompleteLeaf fires item_completed at 0% and state reverts to 0%', async () => {
    const u = await makeUser('comp-leaf-uncheck@test.com')
    const item = await makeTask(u.id, 'Leaf uncheck')
    const occ = await materialize(item, TODAY, u.id)

    await completeLeaf(getTestPool(), occ, u.id)
    const afterComplete = await getLeafCompletionState(getTestPool(), occ, u.id)
    expect(afterComplete.completionPercent).toBe(100)

    await uncompleteLeaf(getTestPool(), occ, u.id)
    const afterUncheck = await getLeafCompletionState(getTestPool(), occ, u.id)
    expect(afterUncheck.completionPercent).toBe(0)
  })
})

// ── §6.4 Retroactive completion ───────────────────────────────────────────────

describe('§6.4 retroactive completion', () => {
  it('§6.4 retroactive_completion event preserves recorded-at ≠ applies-to', async () => {
    const u = await makeUser('comp-retro-ts@test.com')
    const item = await makeTask(u.id, 'Retro item')
    const pastDay = '2025-01-10'
    const occ = await materialize(item, pastDay, u.id)

    // "This morning" recording an event for "yesterday"
    const recordedAt = new Date('2025-01-15T08:30:00Z')
    const event = await completeRetroactive(getTestPool(), occ, u.id, recordedAt)

    expect(event.eventType).toBe('retroactive_completion')
    expect(event.appliesToDay).toBe(pastDay)
    expect(event.recordedAt).toEqual(recordedAt)
    // Gap is present: recorded-at is 5 days after applies-to
    expect(event.recordedAt.getTime()).toBeGreaterThan(
      new Date(pastDay + 'T00:00:00Z').getTime()
    )
  })

  it('§6.4 backfill lateness is derivable from the recorded-at vs applies-to gap', async () => {
    const u = await makeUser('comp-retro-gap@test.com')
    const item = await makeTask(u.id, 'Retro gap item')
    const pastDay = '2025-01-10'
    const occ = await materialize(item, pastDay, u.id)

    const recordedAt = new Date('2025-01-15T09:00:00Z')
    const event = await completeRetroactive(getTestPool(), occ, u.id, recordedAt)

    // Compute gap in whole days: Math.floor((recordedAt - appliesToDay) / 86400000)
    const appliesToMs = new Date(event.appliesToDay! + 'T00:00:00Z').getTime()
    const gapDays = Math.floor((event.recordedAt.getTime() - appliesToMs) / 86_400_000)
    expect(gapDays).toBe(5)  // 5 days late
  })

  it('§6.4 retroactive completion results in wasRetroactive = true in derived state', async () => {
    const u = await makeUser('comp-retro-flag@test.com')
    const item = await makeTask(u.id, 'Retro flag')
    const pastDay = '2025-01-10'
    const occ = await materialize(item, pastDay, u.id)

    await completeRetroactive(getTestPool(), occ, u.id, new Date('2025-01-15T08:00:00Z'))
    const state = await getLeafCompletionState(getTestPool(), occ, u.id)
    expect(state.wasRetroactive).toBe(true)
    expect(state.completionPercent).toBe(100)
  })
})

// ── §6.1 Parent derived % ─────────────────────────────────────────────────────

describe('§6.1 parent derived % uses getDueDays to determine which children are due', () => {
  it('§6.1 derived % excludes children not due on that day (Tuesday with MWF child → 100%)', async () => {
    // Night Routine (daily parent) + Tretinoin (MWF child)
    // Tuesday: Tretinoin is NOT due → denominator = 0 → derived % = 100% (vacuous)
    const u = await makeUser('comp-tuesday-case@test.com')
    const parent = await makeDailyHabit(u.id, 'Night Routine')
    await makeTask(u.id, 'Tretinoin', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, TUESDAY, u.id)
    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, TUESDAY)

    // Tretinoin not due on Tuesday → 0 due children → derived % = 100
    expect(state.derivedPercent).toBe(100)
  })

  it('§6.1 derived % is 0% when a due child is not yet completed (Monday with MWF child)', async () => {
    const u = await makeUser('comp-monday-due@test.com')
    const parent = await makeDailyHabit(u.id, 'Night Routine Mon')
    await makeTask(u.id, 'Tretinoin Mon', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, MONDAY, u.id)
    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)

    // Tretinoin IS due on Monday, not completed → derived % = 0
    expect(state.derivedPercent).toBe(0)
  })

  it('§6.1 derived % = 100% when all due children are completed (Monday, child completed)', async () => {
    const u = await makeUser('comp-monday-complete@test.com')
    const parent = await makeDailyHabit(u.id, 'Night Routine Mon Cmp')
    const child = await makeTask(u.id, 'Tretinoin Mon Cmp', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, MONDAY, u.id)
    const childOcc  = await materialize(child, MONDAY, u.id)

    await completeChild(getTestPool(), childOcc, parentOcc, u.id)

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(100)
  })
})

// ── §6.1 Nested parents contribute their own value (partial credit) ───────────

describe('§6.1 a child that is itself a parent contributes its own value to the derived %', () => {
  it('§6.1 a sub-routine at 6-of-7 contributes 86, not 0 (it carries no item_completed event)', async () => {
    // Morning Routine → Morning Stretching → 7 leaves, 6 of them done.
    // Morning Stretching is a parent, so it never gets an item_completed event
    // (routes/occurrences.ts sends parents down the declared-% path) — read as a
    // leaf it would contribute 0 and Morning Routine would show 0%.
    const u = await makeUser('comp-nested-partial@test.com')
    const root = await makeDailyHabit(u.id, 'Morning Routine')
    const sub = await makeDailyHabit(u.id, 'Morning Stretching', { parentId: root.id })

    const rootOcc = await materialize(root, MONDAY, u.id)
    const subOcc = await materialize(sub, MONDAY, u.id)

    for (let i = 0; i < 7; i++) {
      const leaf = await makeTask(u.id, `Stretch ${i}`, {
        recurrenceRule: { type: 'daily' },
        parentId: sub.id,
      })
      const leafOcc = await materialize(leaf, MONDAY, u.id)
      if (i < 6) await completeChild(getTestPool(), leafOcc, subOcc, u.id)
    }

    const subState = await getParentCompletionState(getTestPool(), subOcc, u.id, MONDAY)
    expect(subState.derivedPercent).toBe(86)   // 6/7

    const rootState = await getParentCompletionState(getTestPool(), rootOcc, u.id, MONDAY)
    expect(rootState.derivedPercent).toBe(86)  // its only due child is worth 86
  })

  it('§6.1 a parent averages its children\'s percentages — 25/50/75 → 50%, not 0%', async () => {
    const u = await makeUser('comp-nested-average@test.com')
    const root = await makeDailyHabit(u.id, 'Averaging Routine')
    const rootOcc = await materialize(root, MONDAY, u.id)

    // Three sub-routines at 1/4, 1/2 and 3/4.
    for (const [name, total, done] of [['Quarter', 4, 1], ['Half', 2, 1], ['ThreeQ', 4, 3]] as const) {
      const sub = await makeDailyHabit(u.id, name, { parentId: root.id })
      const subOcc = await materialize(sub, MONDAY, u.id)
      for (let i = 0; i < total; i++) {
        const leaf = await makeTask(u.id, `${name} leaf ${i}`, {
          recurrenceRule: { type: 'daily' },
          parentId: sub.id,
        })
        const leafOcc = await materialize(leaf, MONDAY, u.id)
        if (i < done) await completeChild(getTestPool(), leafOcc, subOcc, u.id)
      }
    }

    const state = await getParentCompletionState(getTestPool(), rootOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(50)
  })

  it('§6.3 a manually-completed sub-routine contributes its declared %, not its derived %', async () => {
    const u = await makeUser('comp-nested-declared@test.com')
    const root = await makeDailyHabit(u.id, 'Declared-sub Routine')
    const sub = await makeDailyHabit(u.id, 'Declared Sub', { parentId: root.id })
    const leaf = await makeTask(u.id, 'Untouched leaf', {
      recurrenceRule: { type: 'daily' },
      parentId: sub.id,
    })

    const rootOcc = await materialize(root, MONDAY, u.id)
    const subOcc = await materialize(sub, MONDAY, u.id)
    await materialize(leaf, MONDAY, u.id)

    // Sub-routine's own child is untouched (derived 0), but the user declared it done.
    await declareParentPercent(getTestPool(), subOcc, u.id, 100)

    const state = await getParentCompletionState(getTestPool(), rootOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(100)
  })
})

// ── §8.1 Excused children leave the denominator ───────────────────────────────

describe('§8.1 an excused child is excluded from the parent derived %; a skipped one is not', () => {
  it('§8.1 excused child leaves the denominator — 1 done + 1 excused of 3 → 50%', async () => {
    const u = await makeUser('comp-excused-child@test.com')
    const parent = await makeDailyHabit(u.id, 'Excuse Routine')
    const parentOcc = await materialize(parent, MONDAY, u.id)

    const [done, excused, missed] = await Promise.all(
      ['done', 'excused', 'missed'].map((n) =>
        makeTask(u.id, `Excuse ${n}`, { recurrenceRule: { type: 'daily' }, parentId: parent.id })
      )
    )
    const doneOcc = await materialize(done, MONDAY, u.id)
    const excusedOcc = await materialize(excused, MONDAY, u.id)
    await materialize(missed, MONDAY, u.id)

    await completeChild(getTestPool(), doneOcc, parentOcc, u.id)
    await excuseOccurrenceByUser(getTestPool(), excusedOcc, u.id)

    // Denominator is {done, missed}, not all three → 50%, not 33%.
    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(50)
  })

  it('§8.1 a skipped child stays in the denominator as a miss — 1 done + 1 skipped → 50%', async () => {
    const u = await makeUser('comp-skipped-child@test.com')
    const parent = await makeDailyHabit(u.id, 'Skip Routine')
    const parentOcc = await materialize(parent, MONDAY, u.id)

    const done = await makeTask(u.id, 'Skip done', { recurrenceRule: { type: 'daily' }, parentId: parent.id })
    const skipped = await makeTask(u.id, 'Skip skipped', { recurrenceRule: { type: 'daily' }, parentId: parent.id })
    const doneOcc = await materialize(done, MONDAY, u.id)
    const skippedOcc = await materialize(skipped, MONDAY, u.id)

    await completeChild(getTestPool(), doneOcc, parentOcc, u.id)
    await skipOccurrenceByUser(getTestPool(), skippedOcc, u.id)

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(50)
  })

  it('§8.1 every due child excused → 100% (vacuous), never 0% — an excuse is not a miss', async () => {
    const u = await makeUser('comp-all-excused@test.com')
    const parent = await makeDailyHabit(u.id, 'All-excused Routine')
    const parentOcc = await materialize(parent, MONDAY, u.id)

    for (const n of ['a', 'b']) {
      const child = await makeTask(u.id, `All-excused ${n}`, {
        recurrenceRule: { type: 'daily' },
        parentId: parent.id,
      })
      const childOcc = await materialize(child, MONDAY, u.id)
      await excuseOccurrenceByUser(getTestPool(), childOcc, u.id)
    }

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(100)
  })
})

// ── §6.2 Declared and derived coexist ────────────────────────────────────────

describe('§6.2 derived and declared % coexist on a parent occurrence and can diverge', () => {
  it('§6.2 declareParentPercent fires manual_parent_percent_declared event', async () => {
    const u = await makeUser('comp-declare@test.com')
    const parent = await makeDailyHabit(u.id, 'Declare parent')
    const parentOcc = await materialize(parent, TODAY, u.id)

    const event = await declareParentPercent(getTestPool(), parentOcc, u.id, 75)
    expect(event.eventType).toBe('manual_parent_percent_declared')
    expect((event.payload as any).declaredPercent).toBe(75)
  })

  it('§6.2 declared and derived coexist: derived = 0 (no children done), declared = 75', async () => {
    const u = await makeUser('comp-coexist@test.com')
    const parent = await makeDailyHabit(u.id, 'Coexist parent')
    await makeTask(u.id, 'Coexist child', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, MONDAY, u.id)
    // Child is due on Monday but not completed → derived = 0
    await declareParentPercent(getTestPool(), parentOcc, u.id, 75)

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(state.derivedPercent).toBe(0)      // computed from children
    expect(state.declaredPercent).toBe(75)    // from manual event
    expect(state.displayPercent).toBe(75)     // declared takes display precedence
    // Both coexist — neither replaced the other
  })

  it('§6.3 parent default is derived % — no declared when only children are completed', async () => {
    const u = await makeUser('comp-default-derived@test.com')
    const parent = await makeDailyHabit(u.id, 'Default derived parent')
    const child = await makeTask(u.id, 'Default derived child', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, MONDAY, u.id)
    const childOcc  = await materialize(child, MONDAY, u.id)
    await completeChild(getTestPool(), childOcc, parentOcc, u.id)

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    // Default = derived %; no declared % involved
    expect(state.declaredPercent).toBeNull()
    expect(state.derivedPercent).toBe(100)
    expect(state.displayPercent).toBe(100)
  })
})

// ── §10.1 State derived by replaying events ───────────────────────────────────

describe('§10.1 state is derived by replaying events — unchecking a child lowers derived %', () => {
  it('§10.1 completing a child raises derived %, unchecking lowers it back', async () => {
    const u = await makeUser('comp-uncheck-lowers@test.com')
    const parent = await makeDailyHabit(u.id, 'Replay parent')
    const child = await makeTask(u.id, 'Replay child', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, MONDAY, u.id)
    const childOcc  = await materialize(child, MONDAY, u.id)

    // Initially: child due but not complete → 0%
    const before = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(before.derivedPercent).toBe(0)

    // Complete the child
    await completeChild(getTestPool(), childOcc, parentOcc, u.id)
    const afterComplete = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(afterComplete.derivedPercent).toBe(100)

    // Uncheck the child
    await uncompleteChild(getTestPool(), childOcc, parentOcc, u.id)
    const afterUncheck = await getParentCompletionState(getTestPool(), parentOcc, u.id, MONDAY)
    expect(afterUncheck.derivedPercent).toBe(0)
  })
})

// ── §10.1 / §5.1 Interlock: 2a getDueDays drives 2b derived % ────────────────

describe('§10.1 + §5.1 interlock: MWF child due-ness from getDueDays drives parent derived % on Wed vs Tue', () => {
  it('§5.1 + §6.1 Wednesday: MWF child IS due → derived % reflects child completion', async () => {
    const WEDNESDAY = '2025-01-15'  // Wednesday
    const u = await makeUser('comp-interlock-wed@test.com')
    const parent = await makeDailyHabit(u.id, 'Night Routine Wed')
    const child = await makeTask(u.id, 'Tretinoin Wed', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, WEDNESDAY, u.id)
    const childOcc  = await materialize(child, WEDNESDAY, u.id)

    // Child is due on Wednesday; before completion → parent = 0%
    const stateBeforeWed = await getParentCompletionState(getTestPool(), parentOcc, u.id, WEDNESDAY)
    expect(stateBeforeWed.derivedPercent).toBe(0)

    await completeChild(getTestPool(), childOcc, parentOcc, u.id)
    const stateAfterWed = await getParentCompletionState(getTestPool(), parentOcc, u.id, WEDNESDAY)
    expect(stateAfterWed.derivedPercent).toBe(100)
  })

  it('§5.1 + §6.1 Tuesday: MWF child NOT due → parent is 100% by default (vacuous)', async () => {
    const u = await makeUser('comp-interlock-tue@test.com')
    const parent = await makeDailyHabit(u.id, 'Night Routine Tue')
    await makeTask(u.id, 'Tretinoin Tue', {
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
    })

    const parentOcc = await materialize(parent, TUESDAY, u.id)
    const stateTue = await getParentCompletionState(getTestPool(), parentOcc, u.id, TUESDAY)
    // No children due Tuesday → vacuous 100%
    expect(stateTue.derivedPercent).toBe(100)
  })
})
