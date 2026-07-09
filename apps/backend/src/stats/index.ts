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
  TimeStatsFinding,
  AdHocShareFinding,
  ProcrastinationFinding,
  DataQualityFinding,
  DateWindow,
} from '@tracker/shared'
import * as repos from '../db/repos/index'
import {
  buildLeafDayObservations,
  buildParentDayObservations,
  buildSessionObservations,
  buildRescheduleObservations,
  buildBackfillObservations,
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

export async function getItemStreak(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<StreakFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  // Leaf observations for streak computation (parent streaks use parent due days)
  const children = await repos.findChildItems(pool, itemId, userId)
  let observations
  if (children.length === 0) {
    observations = await buildLeafDayObservations(pool, userId, item, window)
  } else {
    const { parentObs } = await buildParentDayObservations(pool, userId, item, window)
    observations = parentObs
  }

  // Streak type: 'quota' if item has a quotaTarget; 'daily' otherwise
  const streakType = item.quotaTarget ? 'quota' : 'daily'
  return computeStreak(itemId, userId, window, observations, streakType)
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

  const sessions = await buildSessionObservations(pool, userId, window, { itemId })
  return computeTimeStats(itemId, userId, window, sessions, item.plannedDurationMin)
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

    if (item.plannedDurationMin !== null) {
      sessionStats.push({
        hasPlannedDuration: true,
        hasSessions: sessionItemIds.has(item.id),
      })
    }
  }

  const backfills = await buildBackfillObservations(pool, userId, window)
  return computeDataQuality(userId, null, window, allDayObs, backfills, sessionStats, true)
}
