// v2 Layer 1 / 1.5 — Top-level stats API.
//
// These async functions are the entry points for route handlers.  Each one:
//   1. Calls the observation builders (domain layer — DB access)
//   2. Passes the resulting arrays to a pure calculator function
//   3. Returns the finding
//
// All functions are user_id-scoped (§13.4) and thin (no business logic here —
// logic lives in calculators or in the observation builders that call v1 domain).

import type { Pool } from 'pg'
import type {
  AdherenceFinding,
  StreakFinding,
  StreakSummaryFinding,
  ItemStreakSummary,
  TimeStatsFinding,
  AdHocShareFinding,
  ProcrastinationFinding,
  DataQualityFinding,
  DateWindow,
  Item,
} from '@tracker/shared'
import * as repos from '../db/repos/index'
import { logicalToday } from '../domain/day'
import {
  buildLeafDayObservations,
  buildParentDayObservations,
  buildSessionObservations,
  buildRescheduleObservations,
  buildBackfillObservations,
  itemEarliestAnchor,
  itemPlannedDurationMin,
} from './domain/observations'
import { computeLeafAdherence, computeParentAdherence } from './calculators/adherence'
import { computeStreak } from './calculators/streaks'
import { computeTimeStats, computeAdHocShare } from './calculators/time'
import { computeProcrastination } from './calculators/procrastination'
import { computeDataQuality } from './calculators/data-quality'

// ── §3.1 Adherence ────────────────────────────────────────────────────────────

export async function getItemAdherence(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<AdherenceFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  const children = await repos.findChildItems(pool, itemId, userId)

  if (children.length === 0) {
    // Leaf item
    const observations = await buildLeafDayObservations(pool, userId, item, window)
    return computeLeafAdherence(itemId, userId, window, observations)
  } else {
    // Parent item — derived % from children; always includes per-child breakdown
    const { parentObs, childObs } = await buildParentDayObservations(pool, userId, item, window)
    return computeParentAdherence(itemId, userId, window, parentObs, childObs)
  }
}

// ── §3.2 Streaks ──────────────────────────────────────────────────────────────

// Leaf items use their own day observations; a parent uses its derived-% parent
// days. Shared by the per-item finding and the ambient summary so the badge on the
// Now view can never disagree with the number on the Stats page.
async function buildStreakObservations(pool: Pool, userId: string, item: Item, window: DateWindow) {
  const children = await repos.findChildItems(pool, item.id, userId)
  if (children.length === 0) {
    return buildLeafDayObservations(pool, userId, item, window)
  }
  const { parentObs } = await buildParentDayObservations(pool, userId, item, window)
  return parentObs
}

export async function getItemStreak(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow,
  now: Date = new Date()
): Promise<StreakFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  // §3.2.1 — the logical day (v1 §6.7 day-start bucketing), not the calendar date:
  // with a 4am day-start, 1:30am still belongs to yesterday, and yesterday must not
  // be treated as a resolved miss while the user is still up doing it.
  const currentDay = await logicalToday(pool, userId, now)

  // §3.2.4 — currentStreak is NOT window-scoped, so it needs the item's history
  // (back to its anchor, which is as far back as occurrences can exist) up to today,
  // while longestStreak needs exactly the requested window. Build the union once and
  // slice it: two builds over an all-time window would double the most expensive
  // query on the page for no gain, and could only ever agree by construction anyway.
  // §5.5 — "as far back as occurrences can exist" is the earliest of the item's slots.
  const schedules = await repos.findSchedulesByItem(pool, itemId, userId)
  const historyWindow: DateWindow = {
    startDay: minDay(itemEarliestAnchor(item, schedules), window.startDay),
    endDay: maxDay(currentDay, window.endDay),
  }
  const historyObs = await buildStreakObservations(pool, userId, item, historyWindow)
  const windowObs = historyObs.filter(o => o.day >= window.startDay && o.day <= window.endDay)

  const overHistory = computeStreak(itemId, userId, historyWindow, historyObs, currentDay, item.quotaTarget)
  const windowed = computeStreak(itemId, userId, window, windowObs, currentDay, item.quotaTarget)

  // rawCounts and longestStreak describe the requested window; the current-chain
  // fields describe today. Both are labelled as such on the type.
  return {
    ...windowed,
    currentStreak: overHistory.currentStreak,
    currentDayPending: overHistory.currentDayPending,
    currentPeriodProgress: overHistory.currentPeriodProgress,
  }
}

const minDay = (a: string, b: string) => (a <= b ? a : b)
const maxDay = (a: string, b: string) => (a >= b ? a : b)

// §3.2.5 — the fixed rate the streak is always shown next to. Deliberately ends
// YESTERDAY: including an unresolved today in the denominator would make the rate
// sag every morning and recover every evening, which is the same artifact §3.2.1
// removes from the streak itself.
const ADHERENCE_BADGE_DAYS = 30

function badgeAdherenceWindow(currentDay: string): DateWindow {
  const [y, m, d] = currentDay.split('-').map(Number)
  const end = new Date(Date.UTC(y, m - 1, d - 1))
  const start = new Date(Date.UTC(y, m - 1, d - ADHERENCE_BADGE_DAYS))
  return { startDay: start.toISOString().slice(0, 10), endDay: end.toISOString().slice(0, 10) }
}

/**
 * §3.2.5 — Ambient streak badges for every recurring item, in ONE call.
 *
 * The Now and List views render this for every row; fetching per item would put an
 * N-request waterfall on the app's most-used surface. Streak and 30-day rate are
 * returned together because §3.2.5 requires them to be displayed together — they
 * cannot be fetched separately and drift.
 *
 * One-time items are excluded: a streak is a property of a recurrence.
 */
export async function getStreakSummaries(
  pool: Pool,
  userId: string,
  now: Date = new Date()
): Promise<StreakSummaryFinding> {
  const currentDay = await logicalToday(pool, userId, now)
  const rateWindow = badgeAdherenceWindow(currentDay)

  const allItems = await repos.findItemsByUser(pool, userId)
  // §5.5 — an item is recurring if any of its slots recurs.
  const withSchedules = await Promise.all(
    allItems
      .filter(i => i.archivedAt === null)
      .map(async (item) => ({
        item,
        schedules: await repos.findSchedulesByItem(pool, item.id, userId),
      }))
  )
  const recurring = withSchedules.filter(
    ({ schedules }) => schedules.some(s => s.recurrenceRule !== null)
  )

  const items: ItemStreakSummary[] = await Promise.all(
    recurring.map(async ({ item, schedules }): Promise<ItemStreakSummary> => {
      // One build over the item's whole history serves both numbers: the backwards
      // streak walk needs the history, and the 30-day rate is a filter on its tail.
      const window: DateWindow = {
        startDay: itemEarliestAnchor(item, schedules),
        endDay: currentDay,
      }
      const observations = await buildStreakObservations(pool, userId, item, window)
      const streak = computeStreak(item.id, userId, window, observations, currentDay, item.quotaTarget)

      const inRate = observations.filter(o => o.day >= rateWindow.startDay && o.day <= rateWindow.endDay)
      const dueCount = inRate.length
      const completed = inRate.filter(o => o.completionPercent >= 100).length

      return {
        itemId: item.id,
        streakType: streak.streakType,
        currentStreak: streak.currentStreak,
        currentDayPending: streak.currentDayPending,
        currentPeriodProgress: streak.currentPeriodProgress,
        // Raw adherence per §3.1: excused days stay in the denominator.
        adherenceRate30d: dueCount > 0 ? completed / dueCount : 0,
        adherenceDueCount30d: dueCount,
        excusedCount30d: inRate.filter(o => o.disposition === 'excused').length,
      }
    })
  )

  return { type: 'streak_summary', userId, asOfDay: currentDay, items }
}

// ── §3.3 Time ─────────────────────────────────────────────────────────────────

export async function getItemTimeStats(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<TimeStatsFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  const schedules = await repos.findSchedulesByItem(pool, itemId, userId)
  const sessions = await buildSessionObservations(pool, userId, window, { itemId })
  return computeTimeStats(itemId, userId, window, sessions, itemPlannedDurationMin(schedules))
}

export async function getAdHocShare(
  pool: Pool,
  userId: string,
  window: DateWindow
): Promise<AdHocShareFinding> {
  const sessions = await buildSessionObservations(pool, userId, window)
  return computeAdHocShare(userId, window, sessions)
}

export async function getCategoryTimeStats(
  pool: Pool,
  userId: string,
  categoryId: string,
  window: DateWindow
): Promise<TimeStatsFinding> {
  const sessions = await buildSessionObservations(pool, userId, window, { categoryId })
  // Use categoryId as the "item" id for the finding shape (consistent with the finding type)
  return computeTimeStats(categoryId, userId, window, sessions, null)
}

// ── §3.4 Procrastination ──────────────────────────────────────────────────────

export async function getItemProcrastination(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<ProcrastinationFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  const [reschedules, backfills] = await Promise.all([
    buildRescheduleObservations(pool, userId, itemId, window),
    buildBackfillObservations(pool, userId, window, itemId),
  ])

  return computeProcrastination(itemId, userId, window, reschedules, backfills)
}

// ── §4 Data Quality ────────────────────────────────────────────────────────────

export async function getItemDataQuality(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<DataQualityFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  const children = await repos.findChildItems(pool, itemId, userId)
  let dayObs
  if (children.length === 0) {
    dayObs = await buildLeafDayObservations(pool, userId, item, window)
  } else {
    const { parentObs } = await buildParentDayObservations(pool, userId, item, window)
    dayObs = parentObs
  }

  const backfills = await buildBackfillObservations(pool, userId, window, itemId)
  return computeDataQuality(userId, itemId, window, dayObs, backfills, undefined, children.length > 0)
}

export async function getUserDataQuality(
  pool: Pool,
  userId: string,
  window: DateWindow
): Promise<DataQualityFinding> {
  // Aggregate data quality across all active items
  const allItems = await repos.findItemsByUser(pool, userId)

  // Collect all day observations across all items
  const allDayObs = []
  const sessionStats: Array<{ hasPlannedDuration: boolean; hasSessions: boolean }> = []
  const sessions = await buildSessionObservations(pool, userId, window)
  const sessionItemIds = new Set(sessions.map(s => s.itemId))

  for (const item of allItems) {
    const children = await repos.findChildItems(pool, item.id, userId)
    let obs
    if (children.length === 0) {
      obs = await buildLeafDayObservations(pool, userId, item, window)
    } else {
      const { parentObs } = await buildParentDayObservations(pool, userId, item, window)
      obs = parentObs
    }
    allDayObs.push(...obs)

    const itemSchedules = await repos.findSchedulesByItem(pool, item.id, userId)
    if (itemPlannedDurationMin(itemSchedules) !== null) {
      sessionStats.push({
        hasPlannedDuration: true,
        hasSessions: sessionItemIds.has(item.id),
      })
    }
  }

  const backfills = await buildBackfillObservations(pool, userId, window)
  return computeDataQuality(userId, null, window, allDayObs, backfills, sessionStats, true)
}
