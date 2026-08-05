// §5.5 — Persistence for item_schedules: the "when" rows an item owns.
//
// Mirrors the shape of repos/items.ts (Row / to* / COLUMN_MAP / JSON_FIELDS) so the
// two read the same way.  Schedules are soft-deleted (archived), never hard-deleted —
// a past occurrence must always be able to resolve the slot it came from (§3.4).

import type { Pool } from 'pg'
import type {
  ItemSchedule,
  RecurrenceRule,
  TimingPrecision,
} from '@tracker/shared'

interface ScheduleRow {
  id: string
  user_id: string
  item_id: string
  label: string | null
  recurrence_rule: RecurrenceRule | null
  anchor_day: string | null
  timing_precision: TimingPrecision
  timing_bucket_id: string | null
  timing_start_time: string | null
  timing_end_time: string | null
  planned_duration_min: number | null
  sort_order: number
  archived_at: Date | null
  created_at: Date
}

function toSchedule(row: ScheduleRow): ItemSchedule {
  return {
    id: row.id,
    userId: row.user_id,
    itemId: row.item_id,
    label: row.label,
    recurrenceRule: row.recurrence_rule,
    anchorDay: row.anchor_day,
    timingPrecision: row.timing_precision,
    timingBucketId: row.timing_bucket_id,
    timingStartTime: row.timing_start_time,
    timingEndTime: row.timing_end_time,
    plannedDurationMin: row.planned_duration_min,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  }
}

export type InsertScheduleData = {
  userId: string
  itemId: string
  label?: string | null
  recurrenceRule?: RecurrenceRule | null
  anchorDay?: string | null
  timingPrecision?: TimingPrecision
  timingBucketId?: string | null
  timingStartTime?: string | null
  timingEndTime?: string | null
  plannedDurationMin?: number | null
  sortOrder?: number
}

export async function insertSchedule(
  pool: Pool,
  data: InsertScheduleData
): Promise<ItemSchedule> {
  const { rows } = await pool.query<ScheduleRow>(
    `INSERT INTO item_schedules (
       user_id, item_id, label, recurrence_rule, anchor_day, timing_precision,
       timing_bucket_id, timing_start_time, timing_end_time, planned_duration_min,
       sort_order
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.userId,
      data.itemId,
      data.label ?? null,
      data.recurrenceRule ? JSON.stringify(data.recurrenceRule) : null,
      data.anchorDay ?? null,
      data.timingPrecision ?? 'none',
      data.timingBucketId ?? null,
      data.timingStartTime ?? null,
      data.timingEndTime ?? null,
      data.plannedDurationMin ?? null,
      data.sortOrder ?? 0,
    ]
  )
  return toSchedule(rows[0])
}

// Active (non-archived) schedules for one item, in slot order.
// created_at is the stable tiebreak for schedules that tie at the default 0, same
// reasoning as findChildItems.
export async function findSchedulesByItem(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<ItemSchedule[]> {
  const { rows } = await pool.query<ScheduleRow>(
    `SELECT * FROM item_schedules
      WHERE item_id = $1 AND user_id = $2 AND archived_at IS NULL
      ORDER BY sort_order, created_at`,
    [itemId, userId]
  )
  return rows.map(toSchedule)
}

// Active schedules for every item the user owns, in one round trip.
// Callers that iterate all items (materialization top-up, the merged read API)
// use this instead of N per-item queries.
export async function findSchedulesByUser(
  pool: Pool,
  userId: string
): Promise<ItemSchedule[]> {
  const { rows } = await pool.query<ScheduleRow>(
    `SELECT * FROM item_schedules
      WHERE user_id = $1 AND archived_at IS NULL
      ORDER BY item_id, sort_order, created_at`,
    [userId]
  )
  return rows.map(toSchedule)
}

// Includes archived; needed to resolve the slot a historical occurrence came from.
export async function findScheduleById(
  pool: Pool,
  id: string,
  userId: string
): Promise<ItemSchedule | null> {
  const { rows } = await pool.query<ScheduleRow>(
    `SELECT * FROM item_schedules WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toSchedule(rows[0]) : null
}

// Fields a schedule edit may change.  All optional — only provided keys are written.
export type UpdateScheduleData = Partial<{
  label: string | null
  recurrenceRule: RecurrenceRule | null
  anchorDay: string | null
  timingPrecision: TimingPrecision
  timingBucketId: string | null
  timingStartTime: string | null
  timingEndTime: string | null
  plannedDurationMin: number | null
  sortOrder: number
}>

const COLUMN_MAP: Record<string, string> = {
  label:              'label',
  recurrenceRule:     'recurrence_rule',
  anchorDay:          'anchor_day',
  timingPrecision:    'timing_precision',
  timingBucketId:     'timing_bucket_id',
  timingStartTime:    'timing_start_time',
  timingEndTime:      'timing_end_time',
  plannedDurationMin: 'planned_duration_min',
  sortOrder:          'sort_order',
}

const JSON_FIELDS = new Set(['recurrenceRule'])

// §5.3 / §5.5 — Forward-only edit of one slot.  Regenerating that slot's untouched
// future occurrences is the caller's responsibility (see regenerateFutureOccurrences).
export async function updateSchedule(
  pool: Pool,
  id: string,
  userId: string,
  updates: UpdateScheduleData
): Promise<ItemSchedule | null> {
  const setClauses: string[] = []
  const values: any[] = []  // pg.query accepts any[]
  let idx = 1

  for (const [key, col] of Object.entries(COLUMN_MAP)) {
    if (!(key in updates)) continue
    const raw = updates[key as keyof UpdateScheduleData]
    setClauses.push(`${col} = $${idx++}`)
    if (JSON_FIELDS.has(key) && raw !== null && raw !== undefined) {
      values.push(JSON.stringify(raw))
    } else {
      values.push(raw ?? null)
    }
  }

  if (setClauses.length === 0) return findScheduleById(pool, id, userId)

  values.push(id, userId)
  const { rows } = await pool.query<ScheduleRow>(
    `UPDATE item_schedules SET ${setClauses.join(', ')}
      WHERE id = $${idx++} AND user_id = $${idx++}
      RETURNING *`,
    values
  )
  return rows[0] ? toSchedule(rows[0]) : null
}

// §5.5 — Removing a slot archives it: its past occurrences stay visible and countable.
export async function archiveSchedule(
  pool: Pool,
  id: string,
  userId: string
): Promise<ItemSchedule | null> {
  const { rows } = await pool.query<ScheduleRow>(
    `UPDATE item_schedules SET archived_at = NOW()
      WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
      RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toSchedule(rows[0]) : null
}

// Where a newly added slot lands: after the item's existing ones.
export async function nextScheduleSortOrder(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<number> {
  const { rows } = await pool.query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM item_schedules
      WHERE item_id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [itemId, userId]
  )
  return rows[0].next
}

// How many active slots an item has.  Used by the §5.5 parent/child invariant checks,
// which must not pay for loading whole rows just to count them.
export async function countActiveSchedules(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM item_schedules
      WHERE item_id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [itemId, userId]
  )
  return parseInt(rows[0].count, 10)
}
