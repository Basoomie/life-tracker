import type { Pool } from 'pg'
import type { DayStartEntry } from '@tracker/shared'

interface DayStartRow {
  id: string
  user_id: string
  starts_on: string
  value: string
  recorded_at: Date
}

function toDayStartEntry(row: DayStartRow): DayStartEntry {
  return {
    id: row.id,
    userId: row.user_id,
    startsOn: row.starts_on,
    // Postgres TIME columns return 'HH:MM:SS'; normalise to the spec's 'HH:MM' format.
    value: row.value.slice(0, 5),
    recordedAt: row.recorded_at,
  }
}

// Appends a new entry to the timeline.  Each change is a new row — never an update.
export async function insertDayStartEntry(
  pool: Pool,
  data: {
    userId: string
    startsOn: string   // YYYY-MM-DD — first day this value is active
    value: string      // HH:MM
  }
): Promise<DayStartEntry> {
  const { rows } = await pool.query<DayStartRow>(
    `INSERT INTO day_start_timeline (user_id, starts_on, value)
     VALUES ($1, $2, $3) RETURNING *`,
    [data.userId, data.startsOn, data.value]
  )
  return toDayStartEntry(rows[0])
}

// Full timeline for the user, ascending — useful for auditing and config UI
export async function findDayStartTimeline(
  pool: Pool,
  userId: string
): Promise<DayStartEntry[]> {
  const { rows } = await pool.query<DayStartRow>(
    `SELECT * FROM day_start_timeline
     WHERE user_id = $1
     ORDER BY starts_on ASC, recorded_at ASC`,
    [userId]
  )
  return rows.map(toDayStartEntry)
}

// The effective day-start for a specific calendar day: the latest entry whose
// starts_on <= targetDay.  Returns null if no entry exists yet for that user.
export async function findEffectiveDayStart(
  pool: Pool,
  userId: string,
  targetDay: string   // YYYY-MM-DD
): Promise<DayStartEntry | null> {
  const { rows } = await pool.query<DayStartRow>(
    `SELECT * FROM day_start_timeline
     WHERE user_id = $1 AND starts_on <= $2
     ORDER BY starts_on DESC, recorded_at DESC
     LIMIT 1`,
    [userId, targetDay]
  )
  return rows[0] ? toDayStartEntry(rows[0]) : null
}
