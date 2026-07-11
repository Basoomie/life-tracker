// §5.4 / §3.2 — Lazy materialization engine.
//
// Core mechanic:
//   - Far-future occurrences are computed on the fly from the recurrence rule.
//     No rows are written.
//   - An occurrence is materialized (written as a stored row, snapshot frozen) only
//     when it is near-term (within the per-item proportional horizon) or when it is
//     first touched by an event.
//   - Past occurrences are already stored and immutable.
//
// Public API:
//   ensureOccurrenceMaterialized   — materialize a single occurrence if not yet stored
//   topUpMaterialization           — background job phase (a): near-term horizon topup
//   regenerateFutureOccurrences    — post-template-edit: wipe + re-materialize untouched future
//   getOccurrencesInRange          — merged read API: stored + computed in one coherent result
//   runBackgroundJob               — entry point combining topup (a) + seam for disposition (b)

import type { Pool } from 'pg'
import type { Item, Occurrence, ItemSnapshot, ComputedOccurrence, RecurrenceRule } from '@tracker/shared'
import { getDueDays, itemAnchorDate } from '@tracker/shared'
import * as repos from '../db/repos/index'

// ── Helpers ──────────────────────────────────────────────────────────────────

// Add N calendar days to a YYYY-MM-DD string using UTC to avoid DST distortion.
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

// Build an ItemSnapshot from the current item state + its resolved prerequisite ids.
function snapshotFromItem(item: Item, prerequisiteIds: string[]): ItemSnapshot {
  return {
    name:              item.name,
    description:       item.description,
    categoryId:        item.categoryId,
    valence:           item.valence,
    priority:          item.priority,
    recurrenceRule:    item.recurrenceRule,
    quotaTarget:       item.quotaTarget,
    timingPrecision:   item.timingPrecision,
    timingBucketId:    item.timingBucketId,
    timingStartTime:   item.timingStartTime,
    timingEndTime:     item.timingEndTime,
    plannedDurationMin: item.plannedDurationMin,
    dispositionPolicy: item.dispositionPolicy,
    parentId:          item.parentId,
    prerequisiteIds,
  }
}

// §5.4 — Proportional horizon: how many days ahead to keep materialized.
// Daily items keep a handful of rows; a yearly-equivalent item keeps ~1.
// The goal is to never pre-generate a large fixed window.
export function horizonDays(rule: RecurrenceRule): number {
  switch (rule.type) {
    case 'daily':        return 7
    case 'days_of_week': return 14
    case 'interval': {
      const periodDays = rule.unit === 'day' ? rule.every : rule.every * 7
      // Two occurrences ahead, minimum 7 days.  A yearly item (period≈365) keeps
      // ~2 future rows (730 days), which is "~one" in the spirit of §5.4.
      return Math.max(7, periodDays * 2)
    }
    case 'monthly':      return 60   // ~2 months / ~2 occurrences
  }
}

// ── Core materialization ──────────────────────────────────────────────────────

/**
 * §5.4 — Materialize a single occurrence for (item, day) if no row exists yet.
 * No-op (safe to call multiple times) if already stored.
 * Returns the occurrence, whether newly written or pre-existing.
 */
export async function ensureOccurrenceMaterialized(
  pool: Pool,
  item: Item,
  day: string,   // YYYY-MM-DD
  userId: string
): Promise<Occurrence> {
  const existing = await repos.findOccurrenceByItemAndDay(pool, item.id, day, userId)
  if (existing) return existing

  const prereqs = await repos.findPrerequisitesByItem(pool, item.id, userId)
  const snapshot = snapshotFromItem(item, prereqs.map((p) => p.prerequisiteId))
  return repos.insertOccurrence(pool, { userId, itemId: item.id, appliesToDay: day, snapshot })
}

// Materialize all due days for a single item within its proportional horizon.
async function topUpMaterializationForItem(
  pool: Pool,
  item: Item,
  userId: string,
  today: string
): Promise<void> {
  if (!item.recurrenceRule) return  // one-time tasks materialize at creation (step 3)

  const endDay  = addDays(today, horizonDays(item.recurrenceRule))
  const dueDays = getDueDays(item.recurrenceRule, today, endDay, itemAnchorDate(item))

  for (const day of dueDays) {
    await ensureOccurrenceMaterialized(pool, item, day, userId)
  }
}

/**
 * §5.4 / §8.4 — Background job, phase (a): tops up near-term materialization
 * for all active recurring items belonging to the user.
 *
 * Called by runBackgroundJob.  Also exported for targeted testing.
 */
export async function topUpMaterialization(
  pool: Pool,
  userId: string,
  today: string   // YYYY-MM-DD
): Promise<void> {
  const items = await repos.findItemsByUser(pool, userId)
  for (const item of items) {
    await topUpMaterializationForItem(pool, item, userId, today)
  }
}

/**
 * §5.3 — After a template edit, regenerate the near-term horizon for the item.
 * Occurrences that are past (before `today`) or already have events attached are
 * frozen and left untouched.  Untouched future occurrences are deleted and
 * re-materialized using the updated item snapshot.
 *
 * Returns the count of rows that were wiped and regenerated.
 */
export async function regenerateFutureOccurrences(
  pool: Pool,
  item: Item,
  userId: string,
  today: string   // YYYY-MM-DD — 'past' = before today
): Promise<number> {
  const deleted = await repos.deleteUntouchedFutureOccurrences(pool, item.id, userId, today)
  await topUpMaterializationForItem(pool, item, userId, today)
  return deleted
}

/**
 * §5.4 — Merged read API.
 * Returns all occurrences for a user in [startDay, endDay] as a uniform
 * ComputedOccurrence array.  Materialized rows carry their id and materializedAt;
 * computed-on-the-fly occurrences have id=null and materializedAt=null.
 * Callers cannot tell (and need not care) which is which.
 *
 * For recurring items, due days are computed from the rule; stored rows are
 * matched by (itemId, day) and used when present.  One-time tasks appear only
 * when they have a stored occurrence in the range.
 */
export async function getOccurrencesInRange(
  pool: Pool,
  userId: string,
  startDay: string,
  endDay: string
): Promise<ComputedOccurrence[]> {
  const [items, stored] = await Promise.all([
    repos.findItemsByUser(pool, userId),
    repos.findOccurrencesByRange(pool, userId, startDay, endDay),
  ])

  // Index stored occurrences by 'itemId:day' for O(1) lookup and deduplication.
  const storedIndex = new Map<string, Occurrence>()
  for (const occ of stored) {
    storedIndex.set(`${occ.itemId}:${occ.appliesToDay}`, occ)
  }

  const results: ComputedOccurrence[] = []

  for (const item of items) {
    if (!item.recurrenceRule) {
      // One-time task: only shows up if a stored occurrence exists in the range.
      // (Materialized at creation time via the API layer — step 3.)
      continue
    }

    const prereqs   = await repos.findPrerequisitesByItem(pool, item.id, userId)
    const prereqIds = prereqs.map((p) => p.prerequisiteId)
    const anchor    = itemAnchorDate(item)
    const dueDays   = getDueDays(item.recurrenceRule, startDay, endDay, anchor)

    for (const day of dueDays) {
      const key     = `${item.id}:${day}`
      const stored2 = storedIndex.get(key)

      if (stored2) {
        results.push({
          id:             stored2.id,
          userId:         stored2.userId,
          itemId:         stored2.itemId,
          appliesToDay:   stored2.appliesToDay,
          snapshot:       stored2.snapshot,
          materializedAt: stored2.materializedAt,
        })
        storedIndex.delete(key)  // mark consumed so we don't double-include it below
      } else {
        // Computed on the fly — no row written.
        results.push({
          id:             null,
          userId,
          itemId:         item.id,
          appliesToDay:   day,
          snapshot:       snapshotFromItem(item, prereqIds),
          materializedAt: null,
        })
      }
    }
  }

  // Remaining stored entries: one-time tasks and orphaned recurring occurrences
  // (e.g. from items whose recurrence was changed).
  // Skip occurrences for archived items — they should not appear in active views.
  const activeItemIds = new Set(items.map((item) => item.id))
  for (const occ of storedIndex.values()) {
    if (!activeItemIds.has(occ.itemId)) continue
    results.push({
      id:             occ.id,
      userId:         occ.userId,
      itemId:         occ.itemId,
      appliesToDay:   occ.appliesToDay,
      snapshot:       occ.snapshot,
      materializedAt: occ.materializedAt,
    })
  }

  results.sort((a, b) =>
    a.appliesToDay !== b.appliesToDay
      ? a.appliesToDay.localeCompare(b.appliesToDay)
      : a.itemId.localeCompare(b.itemId)
  )

  return results
}

/**
 * §8.4 — Background job entry point.
 * Phase (a): tops up near-term materialization for all active items.
 * Phase (b): end-of-day dispositions for untouched occurrences on `day`.
 *
 * `day` is the logical day being closed out (determined by the caller from the
 * day-start timeline).  Phase (a) materializes near-term rows first so phase (b)
 * can find all due occurrences via a simple table scan.
 */
export async function runBackgroundJob(
  pool: Pool,
  userId: string,
  today: string   // YYYY-MM-DD
): Promise<void> {
  await topUpMaterialization(pool, userId, today)
  const { runDispositions } = await import('./dispositions')
  await runDispositions(pool, userId, today)
}
