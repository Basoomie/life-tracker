// §5.5 — Schedule (slot) management: the invariants, and add/edit/remove.
//
// Routes stay thin; the rules live here.
//
// The one structural rule this file enforces is the containment constraint:
//
//   An item that has children carries at most ONE schedule.
//
// Containment (§4.1) matches a child to its parent by day. If a parent had two slots
// on one day there would be no defined answer to which slot a child belongs to, and
// §6.1's derived % would have no well-formed denominator. Rather than invent an
// attachment rule, the case is refused — in both directions, since it can be reached
// either by adding a slot to a parent or by re-parenting a child under a multi-slot
// item.

import type { Pool } from 'pg'
import type {
  Item,
  ItemSchedule,
  ScheduleSnapshot,
  CreateScheduleBody,
  UpdateScheduleBody,
} from '@tracker/shared'
import * as repos from '../db/repos/index'
import { regenerateFutureOccurrences, topUpMaterializationForSchedule } from './materialization'

// A rejected mutation carries a machine-readable code so the route can map it to a
// status without re-deriving the reason from the message text.
export type ScheduleResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'parent_multi_schedule' | 'last_schedule' | 'not_found'; error: string }

/** §5.5 — the frozen copy of a slot carried by every schedule_* event. */
export function scheduleSnapshot(s: ItemSchedule): ScheduleSnapshot {
  return {
    scheduleId: s.id,
    label: s.label,
    recurrenceRule: s.recurrenceRule,
    anchorDay: s.anchorDay,
    timingPrecision: s.timingPrecision,
    timingBucketId: s.timingBucketId,
    timingStartTime: s.timingStartTime,
    timingEndTime: s.timingEndTime,
    plannedDurationMin: s.plannedDurationMin,
    sortOrder: s.sortOrder,
  }
}

/**
 * §5.5 — May `itemId` be given another slot?
 *
 * No if it has children. Exported because the same fact is checked from the other
 * direction when an item is re-parented (see canBeParent).
 */
export async function canAddSchedule(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<boolean> {
  const children = await repos.findChildItems(pool, itemId, userId)
  return children.length === 0
}

/**
 * §5.5 — May `parentId` be used as a parent?
 *
 * No if it already carries more than one slot. The mirror of canAddSchedule.
 */
export async function canBeParent(
  pool: Pool,
  parentId: string,
  userId: string
): Promise<boolean> {
  return (await repos.countActiveSchedules(pool, parentId, userId)) <= 1
}

/**
 * §5.5 — Add a slot to an existing item, and materialize its near-term horizon so it
 * shows up immediately rather than waiting for the nightly job (mirrors POST /items).
 */
export async function addSchedule(
  pool: Pool,
  item: Item,
  userId: string,
  body: CreateScheduleBody,
  today: string
): Promise<ScheduleResult<ItemSchedule>> {
  if (!(await canAddSchedule(pool, item.id, userId))) {
    return {
      ok: false,
      code: 'parent_multi_schedule',
      error:
        'An item with children carries at most one schedule (§5.5): a parent with two slots on one day leaves "which slot does this child belong to?" undefined.',
    }
  }

  const sortOrder = await repos.nextScheduleSortOrder(pool, item.id, userId)
  const schedule = await repos.insertSchedule(pool, {
    userId,
    itemId: item.id,
    label: body.label ?? null,
    recurrenceRule: body.recurrenceRule ?? null,
    anchorDay: body.anchorDay ?? null,
    timingPrecision: body.timingPrecision ?? 'none',
    timingBucketId: body.timingBucketId ?? null,
    timingStartTime: body.timingStartTime ?? null,
    timingEndTime: body.timingEndTime ?? null,
    plannedDurationMin: body.plannedDurationMin ?? null,
    sortOrder,
  })

  await repos.insertEvent(pool, {
    userId,
    eventType: 'schedule_added',
    itemId: item.id,
    occurrenceId: null,
    appliesToDay: null,
    payload: { snapshot: scheduleSnapshot(schedule) },
  })

  await topUpMaterializationForSchedule(pool, item, schedule, userId, today)
  return { ok: true, value: schedule }
}

/**
 * §5.3 / §5.5 — Edit one slot, forward-only.
 *
 * Regeneration is scoped to this slot: editing the 13:00 block must leave the 8:30
 * block's stored rows exactly where they are.
 */
export async function editSchedule(
  pool: Pool,
  item: Item,
  scheduleId: string,
  userId: string,
  body: UpdateScheduleBody,
  today: string
): Promise<ScheduleResult<ItemSchedule>> {
  const existing = await repos.findScheduleById(pool, scheduleId, userId)
  if (!existing || existing.itemId !== item.id || existing.archivedAt !== null) {
    return { ok: false, code: 'not_found', error: 'schedule not found' }
  }

  const updated = await repos.updateSchedule(pool, scheduleId, userId, body)
  if (!updated) return { ok: false, code: 'not_found', error: 'schedule not found' }

  await repos.insertEvent(pool, {
    userId,
    eventType: 'schedule_edited',
    itemId: item.id,
    occurrenceId: null,
    appliesToDay: null,
    payload: {
      scheduleId,
      changes: body as Partial<ScheduleSnapshot>,
      snapshot: scheduleSnapshot(updated),
    },
  })

  await regenerateFutureOccurrences(pool, item, userId, today, scheduleId)
  return { ok: true, value: updated }
}

/**
 * §5.5 — Remove a slot: archive it (never hard-delete, §3.4) and clear its untouched
 * future occurrences. Past occurrences and any already touched by an event stay put,
 * so history keeps reading honestly.
 *
 * Removing the item's only slot is refused: an item with no slot has no "when" and
 * would silently vanish from every view without being archived. Deleting the item is
 * the operation for that, and it is a different, logged decision.
 */
export async function removeSchedule(
  pool: Pool,
  item: Item,
  scheduleId: string,
  userId: string,
  today: string
): Promise<ScheduleResult<{ schedule: ItemSchedule; clearedFutureOccurrences: number }>> {
  const active = await repos.findSchedulesByItem(pool, item.id, userId)
  const target = active.find((s) => s.id === scheduleId)
  if (!target) return { ok: false, code: 'not_found', error: 'schedule not found' }

  if (active.length === 1) {
    return {
      ok: false,
      code: 'last_schedule',
      error:
        "An item's last schedule cannot be removed (§5.5) — an item with no schedule has no 'when'. Delete the item instead.",
    }
  }

  const archived = await repos.archiveSchedule(pool, scheduleId, userId)
  if (!archived) return { ok: false, code: 'not_found', error: 'schedule not found' }

  // Scoped to this slot, and nothing is re-materialized: the slot is gone.
  // regenerateFutureOccurrences finds no active schedule with this id and so only
  // performs the delete half.
  const cleared = await regenerateFutureOccurrences(pool, item, userId, today, scheduleId)

  await repos.insertEvent(pool, {
    userId,
    eventType: 'schedule_removed',
    itemId: item.id,
    occurrenceId: null,
    appliesToDay: null,
    payload: {
      snapshot: scheduleSnapshot(archived),
      clearedFutureOccurrences: cleared,
    },
  })

  return { ok: true, value: { schedule: archived, clearedFutureOccurrences: cleared } }
}
