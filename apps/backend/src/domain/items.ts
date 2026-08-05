// §3.1 / §5.5 — Item creation.
//
// Since the schedules split (migration 0014) an item and its first slot are created
// together: an item with no schedule has no "when" and can never produce an
// occurrence, so creating one without the other is never what a caller wants.
// This function is that unit.  Additional slots are added afterwards through the
// schedule routes.
//
// The argument shape is deliberately flat (item fields and the initial slot's fields
// side by side) — it matches how the create API and the UI think about a new item,
// and it is what every caller used before the split.

import type { Pool } from 'pg'
import type {
  Item,
  ItemSchedule,
  CreationSource,
  DispositionPolicy,
  Priority,
  QuotaTarget,
  RecurrenceRule,
  TimingPrecision,
  Valence,
} from '@tracker/shared'
import * as repos from '../db/repos/index'

export type CreateItemData = {
  userId: string
  name: string
  description?: string | null
  categoryId?: string | null
  valence?: Valence | null
  priority?: Priority | null
  quotaTarget?: QuotaTarget | null
  parentId?: string | null
  sortOrder?: number
  dispositionPolicy?: DispositionPolicy
  creationSource?: CreationSource

  // ── The item's initial schedule (§5.5) ──────────────────────────────────────
  scheduleLabel?: string | null
  recurrenceRule?: RecurrenceRule | null
  anchorDay?: string | null
  timingPrecision?: TimingPrecision
  timingBucketId?: string | null
  timingStartTime?: string | null
  timingEndTime?: string | null
  plannedDurationMin?: number | null
}

/**
 * §5.5 — Create an item together with its initial schedule.
 * Returns both, since callers routinely need the slot id straight away (to
 * materialize a one-time task's single occurrence, or to log a creation event).
 */
export async function createItemWithSchedule(
  pool: Pool,
  data: CreateItemData
): Promise<{ item: Item; schedule: ItemSchedule }> {
  const item = await repos.insertItem(pool, {
    userId: data.userId,
    name: data.name,
    description: data.description ?? null,
    categoryId: data.categoryId ?? null,
    valence: data.valence ?? null,
    priority: data.priority ?? null,
    quotaTarget: data.quotaTarget ?? null,
    parentId: data.parentId ?? null,
    sortOrder: data.sortOrder ?? 0,
    dispositionPolicy: data.dispositionPolicy ?? 'skip',
    creationSource: data.creationSource ?? 'planned',
  })

  const schedule = await repos.insertSchedule(pool, {
    userId: data.userId,
    itemId: item.id,
    label: data.scheduleLabel ?? null,
    recurrenceRule: data.recurrenceRule ?? null,
    anchorDay: data.anchorDay ?? null,
    timingPrecision: data.timingPrecision ?? 'none',
    timingBucketId: data.timingBucketId ?? null,
    timingStartTime: data.timingStartTime ?? null,
    timingEndTime: data.timingEndTime ?? null,
    plannedDurationMin: data.plannedDurationMin ?? null,
    sortOrder: 0,
  })

  return { item, schedule }
}

/**
 * Convenience wrapper for the common case where the caller only wants the item.
 */
export async function createItem(pool: Pool, data: CreateItemData): Promise<Item> {
  const { item } = await createItemWithSchedule(pool, data)
  return item
}

/**
 * §5.5 — The item's one and only active schedule.
 *
 * Used by paths that predate multiple schedules and are only ever reached for
 * single-slot items (one-time task materialization, test setup).  It throws rather
 * than picking a slot when the item has several: silently choosing one would be
 * exactly the kind of invisible wrong answer this design exists to avoid.
 */
export async function soleSchedule(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<ItemSchedule> {
  const schedules = await repos.findSchedulesByItem(pool, itemId, userId)
  if (schedules.length === 0) {
    throw new Error(`item ${itemId} has no active schedule`)
  }
  if (schedules.length > 1) {
    throw new Error(
      `item ${itemId} has ${schedules.length} active schedules; the caller must say which slot it means`
    )
  }
  return schedules[0]
}
