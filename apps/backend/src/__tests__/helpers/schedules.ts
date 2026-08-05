// §5.5 test helpers.
//
// Most tests describe items that have exactly one slot, which is the shape every item
// had before schedules existed. These helpers say "the item's only slot" / "the item's
// only occurrence that day" once, so individual tests keep reading about the behaviour
// they assert rather than about the schedules split.
//
// They deliberately do NOT paper over ambiguity: soleScheduleOf throws (via
// domain/items' soleSchedule) if an item has several slots, and occurrenceOn returns
// the first of a day's occurrences only for single-slot items — a multi-slot test
// should assert on occurrencesOn instead.

import type { Pool } from 'pg'
import type { ItemSchedule, Occurrence } from '@tracker/shared'
import * as repos from '../../db/repos/index'
import { soleSchedule } from '../../domain/items'

/** The item's one and only active schedule; throws if it has more than one. */
export function soleScheduleOf(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<ItemSchedule> {
  return soleSchedule(pool, itemId, userId)
}

/** The item's occurrence on `day` for single-slot items; null if not materialized. */
export async function occurrenceOn(
  pool: Pool,
  itemId: string,
  day: string,
  userId: string
): Promise<Occurrence | null> {
  const occs = await repos.findOccurrencesByItemAndDay(pool, itemId, day, userId)
  return occs[0] ?? null
}

/** Every slot's occurrence for the item on `day`, in materialization order. */
export function occurrencesOn(
  pool: Pool,
  itemId: string,
  day: string,
  userId: string
): Promise<Occurrence[]> {
  return repos.findOccurrencesByItemAndDay(pool, itemId, day, userId)
}
