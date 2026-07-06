import type { Pool } from 'pg'
import type { Bucket } from '@tracker/shared'

interface BucketRow {
  id: string
  user_id: string
  name: string
  start_time: string
  end_time: string
  sort_order: number
  created_at: Date
}

function toBucket(row: BucketRow): Bucket {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    startTime: row.start_time,
    endTime: row.end_time,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }
}

export async function insertBucket(
  pool: Pool,
  data: {
    userId: string
    name: string
    startTime: string   // HH:MM
    endTime: string     // HH:MM
    sortOrder?: number
  }
): Promise<Bucket> {
  const { rows } = await pool.query<BucketRow>(
    `INSERT INTO buckets (user_id, name, start_time, end_time, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.userId, data.name, data.startTime, data.endTime, data.sortOrder ?? 0]
  )
  return toBucket(rows[0])
}

// Ordered by sort_order for consistent display
export async function findBucketsByUser(
  pool: Pool,
  userId: string
): Promise<Bucket[]> {
  const { rows } = await pool.query<BucketRow>(
    `SELECT * FROM buckets WHERE user_id = $1 ORDER BY sort_order, name`,
    [userId]
  )
  return rows.map(toBucket)
}

export async function findBucketById(
  pool: Pool,
  id: string,
  userId: string
): Promise<Bucket | null> {
  const { rows } = await pool.query<BucketRow>(
    `SELECT * FROM buckets WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toBucket(rows[0]) : null
}

export async function updateBucketBoundaries(
  pool: Pool,
  id: string,
  userId: string,
  startTime: string,
  endTime: string
): Promise<Bucket | null> {
  const { rows } = await pool.query<BucketRow>(
    `UPDATE buckets SET start_time = $3, end_time = $4
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, startTime, endTime]
  )
  return rows[0] ? toBucket(rows[0]) : null
}
