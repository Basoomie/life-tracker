// v2 Layer 2 — Top-level async API for inference findings.
//
// Each function:
//   1. Fetches the item from the DB (user_id-scoped per §13.4)
//   2. Calls the appropriate observation builder (domain layer)
//   3. Computes the DataQualityFinding (always ships with Layer 2 results)
//   4. Passes arrays to the pure Layer 2 calculator
//   5. Returns the finding
//
// All logic lives in calculators; these functions are thin orchestrators.
// Strict user_id scoping through the same choke point as Layer 1 (§13.4).

import type { Pool } from 'pg'
import type {
  ContextStabilityFinding,
  AutocorrelationFinding,
  TrajectoryFinding,
  DayOfWeekFinding,
  TwoConditionFinding,
  DateWindow,
} from '@tracker/shared'
import * as repos from '../db/repos/index'
import {
  buildLeafDayObservations,
  buildParentDayObservations,
  buildSessionObservations,
  buildBackfillObservations,
} from './domain/observations'
import { computeDataQuality } from './calculators/data-quality'
import { computeContextStability } from './calculators/context-stability'
import { computeAutocorrelation } from './calculators/autocorrelation'
import { computeTrajectory } from './calculators/trajectory'
import { computeDayOfWeek } from './calculators/day-of-week'
import { computeTwoCondition } from './calculators/two-condition'

// ── Shared helper: build day observations (leaf or parent) ────────────────────

async function buildDayObs(pool: Pool, userId: string, itemId: string, window: DateWindow) {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)
  const children = await repos.findChildItems(pool, itemId, userId)
  if (children.length === 0) {
    return { item, dayObs: await buildLeafDayObservations(pool, userId, item, window) }
  }
  const { parentObs } = await buildParentDayObservations(pool, userId, item, window)
  return { item, dayObs: parentObs }
}

// ── §5.3 item 2 — Context Stability ──────────────────────────────────────────

export async function getContextStability(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<ContextStabilityFinding> {
  const item = await repos.findItemById(pool, itemId, userId)
  if (!item) throw new Error(`item not found: ${itemId}`)

  const [sessions, backfills, dayObsForQuality] = await Promise.all([
    buildSessionObservations(pool, userId, window, { itemId }),
    buildBackfillObservations(pool, userId, window, itemId),
    buildDayObs(pool, userId, itemId, window).then(r => r.dayObs),
  ])

  const children = await repos.findChildItems(pool, itemId, userId)
  const dataQuality = computeDataQuality(
    userId, itemId, window, dayObsForQuality, backfills,
    undefined, children.length > 0
  )

  return computeContextStability(itemId, userId, window, sessions, dataQuality)
}

// ── §5.3 item 5 — Autocorrelation ────────────────────────────────────────────

export async function getAutocorrelation(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<AutocorrelationFinding> {
  const { item, dayObs } = await buildDayObs(pool, userId, itemId, window)
  const children = await repos.findChildItems(pool, item.id, userId)
  const backfills = await buildBackfillObservations(pool, userId, window, itemId)

  const dataQuality = computeDataQuality(
    userId, itemId, window, dayObs, backfills,
    undefined, children.length > 0
  )

  return computeAutocorrelation(itemId, userId, window, dayObs, dataQuality)
}

// ── §5.3 item 4 — Trajectory ──────────────────────────────────────────────────

export async function getTrajectory(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<TrajectoryFinding> {
  const { item, dayObs } = await buildDayObs(pool, userId, itemId, window)
  const children = await repos.findChildItems(pool, item.id, userId)
  const backfills = await buildBackfillObservations(pool, userId, window, itemId)

  const dataQuality = computeDataQuality(
    userId, itemId, window, dayObs, backfills,
    undefined, children.length > 0
  )

  return computeTrajectory(itemId, userId, window, dayObs, dataQuality)
}

// ── §5.3 item 3 — Day-of-week (k=7) ──────────────────────────────────────────

export async function getDayOfWeek(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<DayOfWeekFinding> {
  const { item, dayObs } = await buildDayObs(pool, userId, itemId, window)
  const children = await repos.findChildItems(pool, item.id, userId)
  const backfills = await buildBackfillObservations(pool, userId, window, itemId)

  const dataQuality = computeDataQuality(
    userId, itemId, window, dayObs, backfills,
    undefined, children.length > 0
  )

  return computeDayOfWeek(itemId, userId, window, item.recurrenceRule, dayObs, dataQuality)
}

// ── §5.3 item 3 (k=2) — Two-condition (weekday vs. weekend) ──────────────────

export async function getTwoCondition(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<TwoConditionFinding> {
  const { item, dayObs } = await buildDayObs(pool, userId, itemId, window)
  const children = await repos.findChildItems(pool, item.id, userId)
  const backfills = await buildBackfillObservations(pool, userId, window, itemId)

  const dataQuality = computeDataQuality(
    userId, itemId, window, dayObs, backfills,
    undefined, children.length > 0
  )

  return computeTwoCondition(itemId, userId, window, dayObs, dataQuality)
}
