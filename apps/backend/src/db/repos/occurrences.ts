import type { Pool } from 'pg'
import type { Occurrence, ItemSnapshot } from '@tracker/shared'

interface OccurrenceRow {
  id: string
  user_id: string
  item_id: string
  applies_to_day: string
  snapshot: ItemSnapshot
  materialized_at: Date
}

function toOccurrence(row: OccurrenceRow): Occurrence {
  return {
    id: row.id,
    userId: row.user_id,
    itemId: row.item_id,
    appliesToDay: row.applies_to_day,
    snapshot: row.snapshot,
    materializedAt: row.materialized_at,
  }
}

export async function insertOccurrence(
  pool: Pool,
  data: {
    userId: string
    itemId: string
    appliesToDay: string    // YYYY-MM-DD
    snapshot: ItemSnapshot
  }
): Promise<Occurrence> {
  const { rows } = await pool.query<OccurrenceRow>(
    `INSERT INTO occurrences (user_id, item_id, applies_to_day, snapshot)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.userId, data.itemId, data.appliesToDay, JSON.stringify(data.snapshot)]
  )
  return toOccurrence(rows[0])
}

export async function findOccurrenceById(
  pool: Pool,
  id: string,
  userId: string
): Promise<Occurrence | null> {
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toOccurrence(rows[0]) : null
}

// All occurrences for a user on a specific day (the main daily view query)
export async function findOccurrencesByDay(
  pool: Pool,
  userId: string,
  day: string   // YYYY-MM-DD
): Promise<Occurrence[]> {
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences
     WHERE user_id = $1 AND applies_to_day = $2
     ORDER BY materialized_at`,
    [userId, day]
  )
  return rows.map(toOccurrence)
}

// All occurrences for a specific item, ordered by day
export async function findOccurrencesByItem(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<Occurrence[]> {
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences
     WHERE item_id = $1 AND user_id = $2
     ORDER BY applies_to_day`,
    [itemId, userId]
  )
  return rows.map(toOccurrence)
}

// Fetch a specific item+day occurrence (unique per the UNIQUE constraint)
export async function findOccurrenceByItemAndDay(
  pool: Pool,
  itemId: string,
  day: string,
  userId: string
): Promise<Occurrence | null> {
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences
     WHERE item_id = $1 AND applies_to_day = $2 AND user_id = $3`,
    [itemId, day, userId]
  )
  return rows[0] ? toOccurrence(rows[0]) : null
}

// All occurrences for a user across an inclusive date range — the primary query
// for the merged read API.
export async function findOccurrencesByRange(
  pool: Pool,
  userId: string,
  startDay: string,   // YYYY-MM-DD inclusive
  endDay: string      // YYYY-MM-DD inclusive
): Promise<Occurrence[]> {
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences
     WHERE user_id = $1 AND applies_to_day >= $2 AND applies_to_day <= $3
     ORDER BY applies_to_day, item_id`,
    [userId, startDay, endDay]
  )
  return rows.map(toOccurrence)
}

// Fetch occurrences for a set of item IDs on a specific day (bulk, for parent-derived % computation)
export async function findOccurrencesByItemsAndDay(
  pool: Pool,
  itemIds: string[],
  day: string,
  userId: string
): Promise<Occurrence[]> {
  if (itemIds.length === 0) return []
  const placeholders = itemIds.map((_, i) => `$${i + 3}`).join(', ')
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences
     WHERE user_id = $1 AND applies_to_day = $2 AND item_id IN (${placeholders})`,
    [userId, day, ...itemIds]
  )
  return rows.map(toOccurrence)
}

// §4.2 — Check if an item has ever been completed at 100% (used for isBlocked derivation).
// Returns true if the latest completion event for the item's occurrence has percent >= 100.
// One-time tasks have a single occurrence; this query finds it regardless.
export async function isItemEverCompleted(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<boolean> {
  const { rows } = await pool.query<{ pct: number }>(
    `SELECT (e.payload->>'completionPercent')::int AS pct
     FROM events e
     JOIN occurrences o ON o.id = e.occurrence_id
     WHERE o.item_id = $1
       AND o.user_id = $2
       AND e.user_id = $2
       AND e.event_type IN ('item_completed', 'retroactive_completion')
     ORDER BY e.recorded_at DESC
     LIMIT 1`,
    [itemId, userId]
  )
  if (rows.length === 0) return false
  return rows[0].pct >= 100
}

// Bulk: occurrences for a set of item IDs within an inclusive date range.
// Used by the stats observation layer to fetch parent + child occurrences in one shot.
export async function findOccurrencesByItemsInRange(
  pool: Pool,
  itemIds: string[],
  userId: string,
  startDay: string,
  endDay: string
): Promise<Occurrence[]> {
  if (itemIds.length === 0) return []
  const { rows } = await pool.query<OccurrenceRow>(
    `SELECT * FROM occurrences
     WHERE user_id = $1
       AND item_id = ANY($2::uuid[])
       AND applies_to_day >= $3 AND applies_to_day <= $4
     ORDER BY applies_to_day, item_id`,
    [userId, itemIds, startDay, endDay]
  )
  return rows.map(toOccurrence)
}

// §5.3 — Delete future occurrences for an item that have no events attached.
// Used during template edit: frozen past rows and rows already touched by events
// are left in place; the rest are wiped so they can be re-materialized with the
// updated snapshot.
// Returns the count of rows deleted.
export async function deleteUntouchedFutureOccurrences(
  pool: Pool,
  itemId: string,
  userId: string,
  fromDay: string   // YYYY-MM-DD — only delete on or after this day
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM occurrences
     WHERE item_id = $1
       AND user_id = $2
       AND applies_to_day >= $3
       AND id NOT IN (
         SELECT DISTINCT occurrence_id
         FROM events
         WHERE occurrence_id IS NOT NULL AND user_id = $2
       )`,
    [itemId, userId, fromDay]
  )
  return rowCount ?? 0
}
