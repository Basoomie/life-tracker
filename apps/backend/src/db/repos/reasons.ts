import type { Pool } from 'pg'
import type { Reason } from '@tracker/shared'

interface ReasonRow {
  id: string
  user_id: string
  name: string
  archived_at: Date | null
  created_at: Date
}

function toReason(row: ReasonRow): Reason {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  }
}

export async function insertReason(
  pool: Pool,
  data: { userId: string; name: string }
): Promise<Reason> {
  const { rows } = await pool.query<ReasonRow>(
    `INSERT INTO reasons (user_id, name) VALUES ($1, $2) RETURNING *`,
    [data.userId, data.name]
  )
  return toReason(rows[0])
}

// Returns only active (non-archived) reasons for the user
export async function findReasonsByUser(
  pool: Pool,
  userId: string
): Promise<Reason[]> {
  const { rows } = await pool.query<ReasonRow>(
    `SELECT * FROM reasons
     WHERE user_id = $1 AND archived_at IS NULL
     ORDER BY name`,
    [userId]
  )
  return rows.map(toReason)
}

// Includes archived; used when resolving historical event references
export async function findReasonById(
  pool: Pool,
  id: string,
  userId: string
): Promise<Reason | null> {
  const { rows } = await pool.query<ReasonRow>(
    `SELECT * FROM reasons WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toReason(rows[0]) : null
}

export async function archiveReason(
  pool: Pool,
  id: string,
  userId: string
): Promise<Reason | null> {
  const { rows } = await pool.query<ReasonRow>(
    `UPDATE reasons
     SET archived_at = NOW()
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
     RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toReason(rows[0]) : null
}
