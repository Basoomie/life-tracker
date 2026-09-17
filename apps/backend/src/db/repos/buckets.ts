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
    // Postgres TIME columns return 'HH:MM:SS'; normalise to the spec's 'HH:MM' format.
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
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

/**
 * §6.6 — Move the seam between two adjacent buckets: the one that ends there and the
 * one that starts there, in a single transaction.
 *
 * The explicit BEGIN/COMMIT is a deliberate exception to this codebase's
 * sequential-statements style (see reorderChildren). Every other multi-row write here
 * is idempotent or order-independent; this one is not. A half-applied seam move leaves
 * a gap or overlap in the stored bucket set — the precise state the tiling rule exists
 * to prevent — and nothing downstream would flag it.
 *
 * Returns the full bucket set so callers never have to re-derive it.
 */
export async function moveBucketSeam(
  pool: Pool,
  userId: string,
  beforeBucketId: string,
  afterBucketId: string,
  newTime: string
): Promise<Bucket[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE buckets SET end_time = $3 WHERE id = $1 AND user_id = $2`,
      [beforeBucketId, userId, newTime]
    )
    await client.query(
      `UPDATE buckets SET start_time = $3 WHERE id = $1 AND user_id = $2`,
      [afterBucketId, userId, newTime]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return findBucketsByUser(pool, userId)
}
