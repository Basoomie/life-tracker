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
import type {
  Item,
  ItemSchedule,
  Occurrence,
  ItemSnapshot,
  ComputedOccurrence,
  RecurrenceRule,
} from '@tracker/shared'
import {
  getDueDays,
  scheduleAnchorDate,
  pausedIntervalsFromEvents,
  isDayPaused,
} from '@tracker/shared'
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

// Build an ItemSnapshot from the current item + the schedule this occurrence belongs
// to + its resolved prerequisite ids.
//
// §5.5 — the snapshot's shape is unchanged by the schedules split; the recurrence and
// timing fields simply now come from the slot rather than the item.  That is what
// keeps every frozen historical row valid without a data migration.
export function snapshotFromItem(
  item: Item,
  schedule: ItemSchedule,
  prerequisiteIds: string[]
): ItemSnapshot {
  return {
    name:              item.name,
    description:       item.description,
    categoryId:        item.categoryId,
    valence:           item.valence,
    priority:          item.priority,
    recurrenceRule:    schedule.recurrenceRule,
    quotaTarget:       item.quotaTarget,
    timingPrecision:   schedule.timingPrecision,
    timingBucketId:    schedule.timingBucketId,
    timingStartTime:   schedule.timingStartTime,
    timingEndTime:     schedule.timingEndTime,
    plannedDurationMin: schedule.plannedDurationMin,
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
 * §5.4 / §5.5 — Materialize a single occurrence for (item, schedule, day) if no row
 * exists yet.  No-op (safe to call multiple times) if already stored.
 * Returns the occurrence, whether newly written or pre-existing.
 */
export async function ensureOccurrenceMaterialized(
  pool: Pool,
  item: Item,
  schedule: ItemSchedule,
  day: string,   // YYYY-MM-DD
  userId: string
): Promise<Occurrence> {
  const existing = await repos.findOccurrenceByItemDayAndSchedule(
    pool, item.id, day, schedule.id, userId
  )
  if (existing) return existing

  const prereqs = await repos.findPrerequisitesByItem(pool, item.id, userId)
  const snapshot = snapshotFromItem(item, schedule, prereqs.map((p) => p.prerequisiteId))
  return repos.insertOccurrence(pool, {
    userId,
    itemId: item.id,
    scheduleId: schedule.id,
    appliesToDay: day,
    snapshot,
  })
}

/**
 * §5.4 / §5.5 — Materialize the near-term horizon for one slot.
 * The horizon is proportional to *that slot's* rule, so an item that is daily in one
 * slot and monthly in another keeps the right number of rows for each.
 */
export async function topUpMaterializationForSchedule(
  pool: Pool,
  item: Item,
  schedule: ItemSchedule,
  userId: string,
  today: string
): Promise<void> {
  // §5.6 — the single choke point through which recurring occurrences come into
  // existence, so the pause is enforced here rather than at each of the half-dozen
  // callers.  Without this, regenerateFutureOccurrences would re-materialize exactly
  // the rows a deactivation had just cleared, and the pause would last microseconds.
  if (item.deactivatedAt !== null) return

  if (!schedule.recurrenceRule) return  // one-time slots materialize at creation (step 3)

  const endDay  = addDays(today, horizonDays(schedule.recurrenceRule))
  const dueDays = getDueDays(
    schedule.recurrenceRule, today, endDay, scheduleAnchorDate(schedule, item)
  )

  for (const day of dueDays) {
    await ensureOccurrenceMaterialized(pool, item, schedule, day, userId)
  }
}

/**
 * §5.4 — Materialize (item, day) for an item that has exactly one slot.
 *
 * The single-schedule convenience over ensureOccurrenceMaterialized, for callers that
 * genuinely cannot be multi-slot: a one-time task's only occurrence, and test setup.
 * Throws (via soleSchedule) rather than guessing if the item has several slots.
 */
export async function ensureOccurrenceForItemDay(
  pool: Pool,
  item: Item,
  day: string,   // YYYY-MM-DD
  userId: string
): Promise<Occurrence> {
  const { soleSchedule } = await import('./items')
  const schedule = await soleSchedule(pool, item.id, userId)
  return ensureOccurrenceMaterialized(pool, item, schedule, day, userId)
}

// Materialize all due days for every one of an item's active slots.
export async function topUpMaterializationForItem(
  pool: Pool,
  item: Item,
  userId: string,
  today: string
): Promise<void> {
  const schedules = await repos.findSchedulesByItem(pool, item.id, userId)
  for (const schedule of schedules) {
    await topUpMaterializationForSchedule(pool, item, schedule, userId, today)
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
  // §5.6 — active only: a paused item must not have its horizon topped back up, or
  // the nightly job would quietly undo the deactivation one day at a time.
  const items = await repos.findActiveItemsByUser(pool, userId)
  for (const item of items) {
    await topUpMaterializationForItem(pool, item, userId, today)
  }
}

/**
 * §5.3 / §5.5 — After a template or schedule edit, regenerate the near-term horizon.
 * Occurrences that are past (before `today`) or already have events attached are
 * frozen and left untouched.  Untouched future occurrences are deleted and
 * re-materialized using the updated snapshot.
 *
 * `scheduleId` scopes the regeneration to one slot: editing the 13:00 block must not
 * disturb the 8:30 one.  Omit it for an item-level edit (rename, re-category), which
 * changes the snapshot of every slot.
 *
 * Returns the count of rows that were wiped and regenerated.
 */
export async function regenerateFutureOccurrences(
  pool: Pool,
  item: Item,
  userId: string,
  today: string,          // YYYY-MM-DD — 'past' = before today
  scheduleId?: string     // §5.5 — omit to cover all of the item's slots
): Promise<number> {
  const deleted = await repos.deleteUntouchedFutureOccurrences(
    pool, item.id, userId, today, scheduleId
  )

  if (scheduleId === undefined) {
    await topUpMaterializationForItem(pool, item, userId, today)
    return deleted
  }

  // A removed (archived) slot has nothing to re-materialize — the delete above is the
  // whole job.  findSchedulesByItem returns active slots only, so it simply won't
  // appear here.
  const schedules = await repos.findSchedulesByItem(pool, item.id, userId)
  const target = schedules.find((s) => s.id === scheduleId)
  if (target) {
    await topUpMaterializationForSchedule(pool, item, target, userId, today)
  }
  return deleted
}

/**
 * §5.4 / §5.5 — Merged read API.
 * Returns all occurrences for a user in [startDay, endDay] as a uniform
 * ComputedOccurrence array.  Materialized rows carry their id and materializedAt;
 * computed-on-the-fly occurrences have id=null and materializedAt=null.
 * Callers cannot tell (and need not care) which is which.
 *
 * Due days are computed per *schedule*; stored rows are matched by the full identity
 * (itemId, day, scheduleId), so an item with two slots on one day yields two entries.
 * One-time slots appear only when they have a stored occurrence in the range.
 */
export async function getOccurrencesInRange(
  pool: Pool,
  userId: string,
  startDay: string,
  endDay: string
): Promise<ComputedOccurrence[]> {
  // Non-deleted items, INCLUDING paused ones (§5.6).  Both halves of this function
  // need them for opposite reasons: the rule expansion below must skip them, and the
  // stored-row pass at the end must keep them, because a paused item's past
  // occurrences are frozen history and stay visible.
  const [items, allSchedules, stored] = await Promise.all([
    repos.findItemsByUser(pool, userId),
    repos.findSchedulesByUser(pool, userId),
    repos.findOccurrencesByRange(pool, userId, startDay, endDay),
  ])

  // §5.6 — an item that is active TODAY may still have been paused during the range
  // being asked about.  Its rules must not expand back over those days: looking at
  // last month after reactivating would otherwise show the paused days as due and
  // missed.  This is the same exclusion the stats layer applies (design-v2 §9.1.1.b),
  // and it is applied here for the same reason — so the two can never disagree about
  // what was due.
  const pausedByItem = await repos.findDeactivationEventsByItems(
    pool, items.map((i) => i.id), userId
  )
  const pausedIntervals = new Map(
    items.map((i) => [i.id, pausedIntervalsFromEvents(pausedByItem.get(i.id) ?? [])])
  )

  // Index stored occurrences by full identity for O(1) lookup and deduplication.
  const storedIndex = new Map<string, Occurrence>()
  for (const occ of stored) {
    storedIndex.set(`${occ.itemId}:${occ.appliesToDay}:${occ.scheduleId}`, occ)
  }

  const schedulesByItem = new Map<string, ItemSchedule[]>()
  for (const s of allSchedules) {
    const list = schedulesByItem.get(s.itemId)
    if (list) list.push(s)
    else schedulesByItem.set(s.itemId, [s])
  }

  // Slot order within a day, used by the final sort (below) so two blocks of the same
  // item come back in the order the user arranged them rather than by id.
  const scheduleSortOrder = new Map(allSchedules.map((s) => [s.id, s.sortOrder]))

  const results: ComputedOccurrence[] = []

  for (const item of items) {
    // §5.6 — a paused item generates nothing new.  Note this skips only the rule
    // expansion: any stored row it already has is picked up by the pass below.
    if (item.deactivatedAt !== null) continue

    const schedules = schedulesByItem.get(item.id) ?? []
    if (schedules.length === 0) continue

    const prereqs   = await repos.findPrerequisitesByItem(pool, item.id, userId)
    const prereqIds = prereqs.map((p) => p.prerequisiteId)

    for (const schedule of schedules) {
      if (!schedule.recurrenceRule) {
        // One-time slot: only shows up if a stored occurrence exists in the range.
        // (Materialized at creation time via the API layer — step 3.)
        continue
      }

      const anchor  = scheduleAnchorDate(schedule, item)
      const dueDays = getDueDays(schedule.recurrenceRule, startDay, endDay, anchor)

      const paused = pausedIntervals.get(item.id) ?? []

      for (const day of dueDays) {
        // §5.6 — a day the item was paused on was not a due day.  Skipped only when
        // there is no stored row: a row that survived the pause did so because it
        // carried an event, and that happened.
        const key     = `${item.id}:${day}:${schedule.id}`
        const stored2 = storedIndex.get(key)
        if (!stored2 && isDayPaused(day, paused)) continue

        if (stored2) {
          results.push({
            id:             stored2.id,
            userId:         stored2.userId,
            itemId:         stored2.itemId,
            scheduleId:     stored2.scheduleId,
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
            scheduleId:     schedule.id,
            appliesToDay:   day,
            snapshot:       snapshotFromItem(item, schedule, prereqIds),
            materializedAt: null,
          })
        }
      }
    }
  }

  // Remaining stored entries: one-time tasks, occurrences from archived (removed)
  // slots, and orphaned recurring occurrences (e.g. from items whose recurrence was
  // changed).  §5.5: a removed slot's past rows must stay visible.
  // Skip occurrences for archived items — they should not appear in active views.
  const activeItemIds = new Set(items.map((item) => item.id))
  for (const occ of storedIndex.values()) {
    if (!activeItemIds.has(occ.itemId)) continue
    results.push({
      id:             occ.id,
      userId:         occ.userId,
      itemId:         occ.itemId,
      scheduleId:     occ.scheduleId,
      appliesToDay:   occ.appliesToDay,
      snapshot:       occ.snapshot,
      materializedAt: occ.materializedAt,
    })
  }

  results.sort((a, b) => {
    if (a.appliesToDay !== b.appliesToDay) return a.appliesToDay.localeCompare(b.appliesToDay)
    if (a.itemId !== b.itemId) return a.itemId.localeCompare(b.itemId)
    // Same item, same day → two slots.  Order by the user's slot order; fall back to
    // id so the sort stays total for rows whose schedule is archived (absent above).
    const sa = scheduleSortOrder.get(a.scheduleId) ?? Number.MAX_SAFE_INTEGER
    const sb = scheduleSortOrder.get(b.scheduleId) ?? Number.MAX_SAFE_INTEGER
    return sa !== sb ? sa - sb : a.scheduleId.localeCompare(b.scheduleId)
  })

  return results
}

/**
 * §8 amendment — "Overdue" backlog: materialized **one-time** occurrences from
 * before `today` that haven't been given a stored row's worth of attention yet.
 * Scoped to one-time tasks only (snapshot.recurrenceRule === null) — a missed
 * recurring habit already gets its configured end-of-day policy (skip/excuse/
 * auto_close) via the background job; only require_manual one-time tasks are
 * the ones that silently pile up with nowhere to be found. Unlike
 * getOccurrencesInRange, this never expands a recurrence rule across history —
 * only stored rows are read, since an unmaterialized occurrence can't yet be
 * "missed." Excludes archived items, same as getOccurrencesInRange.
 *
 * Returns raw stored occurrences; the route layer enriches each (to derive
 * disposition from events) and filters to disposition.type === 'pending' —
 * that filter can't happen here since disposition isn't a stored column.
 */
export async function getOverdueOccurrences(
  pool: Pool,
  userId: string,
  today: string   // YYYY-MM-DD
): Promise<Occurrence[]> {
  // §5.6 — active only.  The backlog answers "what do I still owe?", and a task you
  // have deliberately paused is not owed.  Its stored row keeps existing and stays
  // visible in history; it just stops nagging.
  const [items, stored] = await Promise.all([
    repos.findActiveItemsByUser(pool, userId),
    repos.findOccurrencesBeforeDay(pool, userId, today),
  ])
  const activeItemIds = new Set(items.map((item) => item.id))
  return stored.filter((occ) => activeItemIds.has(occ.itemId) && occ.snapshot.recurrenceRule === null)
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
