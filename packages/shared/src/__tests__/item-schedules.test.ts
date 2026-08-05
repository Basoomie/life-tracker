// §5.5 — Multiple schedules per item: due-slot expansion.
//
// Tests are named after the spec's stated rules. getItemDueSlots is the function the
// whole feature turns on: it answers "which (day, slot) pairs is this item due in",
// which is what an occurrence is identified by once an item can carry several slots.

import { describe, it, expect } from 'vitest'
import { getItemDueSlots, getItemDueDays, scheduleAnchorDate } from '../domain/recurrence'
import type { Item, ItemSchedule } from '../types/entities'
import type { RecurrenceRule } from '../types/enums'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ITEM: Item = {
  id: 'item-a',
  userId: 'u1',
  name: 'Task A',
  description: null,
  categoryId: null,
  valence: null,
  priority: null,
  quotaTarget: null,
  parentId: null,
  sortOrder: 0,
  dispositionPolicy: 'skip',
  creationSource: 'planned',
  archivedAt: null,
  createdAt: new Date('2024-06-01T12:00:00Z'),
}

function slot(
  id: string,
  recurrenceRule: RecurrenceRule | null,
  overrides: Partial<ItemSchedule> = {}
): ItemSchedule {
  return {
    id,
    userId: 'u1',
    itemId: 'item-a',
    label: null,
    recurrenceRule,
    anchorDay: null,
    timingPrecision: 'none',
    timingBucketId: null,
    timingStartTime: null,
    timingEndTime: null,
    plannedDurationMin: null,
    sortOrder: 0,
    archivedAt: null,
    createdAt: new Date('2024-06-01T12:00:00Z'),
    ...overrides,
  }
}

// The spec's worked example (§5.5): one task, three slots.
//   8:30–9:30  Tue/Thu/Fri
//   10:30–11:30 Mon/Wed
//   13:00–14:00 all weekdays
const MORNING   = slot('s-morning',   { type: 'days_of_week', days: [2, 4, 5] }, { sortOrder: 0 })
const LATE_MORN = slot('s-late',      { type: 'days_of_week', days: [1, 3] },    { sortOrder: 1 })
const AFTERNOON = slot('s-afternoon', { type: 'days_of_week', days: [1, 2, 3, 4, 5] }, { sortOrder: 2 })

// 2025-01-06 is a Monday; the week runs Mon 06 → Sun 12.
const MON = '2025-01-06'
const TUE = '2025-01-07'
const WED = '2025-01-08'
const SAT = '2025-01-11'

describe('§5.5 an item is due in the union of its schedules', () => {
  it('§5.5 two schedules due on the same day produce two distinct slots', () => {
    const slots = getItemDueSlots(ITEM, [LATE_MORN, AFTERNOON], MON, MON)
    expect(slots).toHaveLength(2)
    expect(slots.map((s) => s.scheduleId).sort()).toEqual(['s-afternoon', 's-late'])
    expect(slots.every((s) => s.day === MON)).toBe(true)
  })

  it("§5.5 a day's slots are exactly the schedules whose rule makes it due", () => {
    const all = [MORNING, LATE_MORN, AFTERNOON]
    // Monday: late-morning + afternoon. Tuesday: morning + afternoon.
    expect(getItemDueSlots(ITEM, all, MON, MON).map((s) => s.scheduleId).sort())
      .toEqual(['s-afternoon', 's-late'])
    expect(getItemDueSlots(ITEM, all, TUE, TUE).map((s) => s.scheduleId).sort())
      .toEqual(['s-afternoon', 's-morning'])
  })

  it('§5.5 a day no schedule covers yields no slots', () => {
    const slots = getItemDueSlots(ITEM, [MORNING, LATE_MORN, AFTERNOON], SAT, SAT)
    expect(slots).toHaveLength(0)
  })

  it('§5.5 getItemDueDays is the union — a day with several slots appears once', () => {
    const days = getItemDueDays(ITEM, [MORNING, LATE_MORN, AFTERNOON], MON, WED)
    expect(days).toEqual([MON, TUE, WED])
  })

  it('§5.5 slots come back day-major so a day\'s slots read together', () => {
    const slots = getItemDueSlots(ITEM, [MORNING, LATE_MORN, AFTERNOON], MON, WED)
    const days = slots.map((s) => s.day)
    expect(days).toEqual([...days].sort())
  })

  it('§5.5 the worked example: every weekday has exactly two slots, the weekend none', () => {
    const all = [MORNING, LATE_MORN, AFTERNOON]
    const slots = getItemDueSlots(ITEM, all, MON, '2025-01-12')  // Mon → Sun
    const perDay = new Map<string, number>()
    for (const s of slots) perDay.set(s.day, (perDay.get(s.day) ?? 0) + 1)

    expect([...perDay.keys()].sort()).toEqual([MON, TUE, WED, '2025-01-09', '2025-01-10'])
    expect([...perDay.values()]).toEqual([2, 2, 2, 2, 2])
  })
})

describe('§5.5 archived and one-time schedules', () => {
  it('§5.5 an archived schedule produces no slots — the user removed that slot', () => {
    const removed = slot('s-gone', { type: 'daily' }, { archivedAt: new Date('2025-01-05T00:00:00Z') })
    expect(getItemDueSlots(ITEM, [removed], MON, WED)).toHaveLength(0)
  })

  it('§5.5 archiving one slot leaves the others due', () => {
    const removed = { ...AFTERNOON, archivedAt: new Date('2025-01-05T00:00:00Z') }
    const slots = getItemDueSlots(ITEM, [LATE_MORN, removed], MON, MON)
    expect(slots.map((s) => s.scheduleId)).toEqual(['s-late'])
  })

  it('§5.5 a one-time schedule (null rule) contributes no computed slots', () => {
    // One-time slots exist only as stored rows; they are never expanded from a rule.
    expect(getItemDueSlots(ITEM, [slot('s-once', null)], MON, WED)).toHaveLength(0)
  })

  it('§5.5 an item with no schedules is never due', () => {
    expect(getItemDueSlots(ITEM, [], MON, WED)).toHaveLength(0)
    expect(getItemDueDays(ITEM, [], MON, WED)).toHaveLength(0)
  })
})

describe('§5.5 each schedule anchors independently', () => {
  it('§5.1 + §5.5 scheduleAnchorDate uses the slot\'s explicit anchorDay when set', () => {
    const s = slot('s-anchored', { type: 'interval', unit: 'day', every: 3 }, { anchorDay: '2024-01-01' })
    expect(scheduleAnchorDate(s, ITEM)).toBe('2024-01-01')
  })

  it("§5.1 + §5.5 scheduleAnchorDate falls back to the ITEM's createdAt, not the slot's", () => {
    // A slot added later must still anchor where the item did, or migration 0014's
    // backfilled slots would silently shift every interval item's due days.
    const s = slot('s-later', { type: 'interval', unit: 'day', every: 3 }, {
      anchorDay: null,
      createdAt: new Date('2025-03-01T00:00:00Z'),
    })
    expect(scheduleAnchorDate(s, ITEM)).toBe('2024-06-01')
  })

  it('§5.5 two interval slots with different anchors are due on complementary days', () => {
    const odd  = slot('s-odd',  { type: 'interval', unit: 'day', every: 2 }, { anchorDay: '2025-01-06' })
    const even = slot('s-even', { type: 'interval', unit: 'day', every: 2 }, { anchorDay: '2025-01-07', sortOrder: 1 })

    const slots = getItemDueSlots(ITEM, [odd, even], '2025-01-06', '2025-01-09')
    const byDay = new Map<string, string[]>()
    for (const s of slots) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s.scheduleId])

    expect(byDay.get('2025-01-06')).toEqual(['s-odd'])
    expect(byDay.get('2025-01-07')).toEqual(['s-even'])
    expect(byDay.get('2025-01-08')).toEqual(['s-odd'])
    expect(byDay.get('2025-01-09')).toEqual(['s-even'])
  })
})
