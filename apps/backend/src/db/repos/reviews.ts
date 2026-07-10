// v2 §6 / §9.2 / §9.5.2 — Reviews repo. Insert + read only — a review is never edited
// once generated (§CLAUDE.md: derived artifacts are appended, not mutated).

import type { Pool } from 'pg'
import type { Review, ReviewCadence, Recommendation, FeedForwardRecord, DateWindow } from '@tracker/shared'

interface ReviewRow {
  id: string
  user_id: string
  cadence: ReviewCadence
  period_start: string
  period_end: string
  generated_at: Date
  narrative: string
  recommendations: Recommendation[]
  feed_forward_out: FeedForwardRecord[]
  prose: string
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    userId: row.user_id,
    cadence: row.cadence,
    window: { startDay: row.period_start, endDay: row.period_end },
    generatedAt: row.generated_at,
    narrative: row.narrative,
    recommendations: row.recommendations,
    feedForwardOut: row.feed_forward_out,
    prose: row.prose,
  }
}

export async function insertReview(
  pool: Pool,
  data: {
    userId: string
    cadence: ReviewCadence
    window: DateWindow
    narrative: string
    recommendations: Recommendation[]
    feedForwardOut: FeedForwardRecord[]
    prose: string
  }
): Promise<Review> {
  const { rows } = await pool.query<ReviewRow>(
    `INSERT INTO reviews
       (user_id, cadence, period_start, period_end, narrative, recommendations, feed_forward_out, prose)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.userId,
      data.cadence,
      data.window.startDay,
      data.window.endDay,
      data.narrative,
      JSON.stringify(data.recommendations),
      JSON.stringify(data.feedForwardOut),
      data.prose,
    ]
  )
  return toReview(rows[0])
}

// Most recent review for a given cadence — the source of the NEXT review's feed-forward
// input (§9.2.1).
export async function findLatestReviewByCadence(
  pool: Pool,
  userId: string,
  cadence: ReviewCadence
): Promise<Review | null> {
  const { rows } = await pool.query<ReviewRow>(
    `SELECT * FROM reviews
     WHERE user_id = $1 AND cadence = $2
     ORDER BY period_start DESC
     LIMIT 1`,
    [userId, cadence]
  )
  return rows[0] ? toReview(rows[0]) : null
}

export async function findReviewById(pool: Pool, id: string, userId: string): Promise<Review | null> {
  const { rows } = await pool.query<ReviewRow>(`SELECT * FROM reviews WHERE id = $1 AND user_id = $2`, [id, userId])
  return rows[0] ? toReview(rows[0]) : null
}

// Chronological history (§9.5.2) — newest first.
export async function findReviewsByUser(
  pool: Pool,
  userId: string,
  cadence?: ReviewCadence
): Promise<Review[]> {
  if (cadence) {
    const { rows } = await pool.query<ReviewRow>(
      `SELECT * FROM reviews WHERE user_id = $1 AND cadence = $2 ORDER BY period_start DESC`,
      [userId, cadence]
    )
    return rows.map(toReview)
  }
  const { rows } = await pool.query<ReviewRow>(
    `SELECT * FROM reviews WHERE user_id = $1 ORDER BY period_start DESC`,
    [userId]
  )
  return rows.map(toReview)
}
