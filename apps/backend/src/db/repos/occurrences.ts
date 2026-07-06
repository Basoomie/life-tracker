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
