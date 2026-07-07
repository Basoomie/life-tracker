// Key-value preference storage per user. Upsertable; survives browser cache clears.

import type { Pool } from 'pg'

export async function getAllUserPreferences(
  pool: Pool,
  userId: string
): Promise<Record<string, string>> {
  const res = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM user_preferences WHERE user_id = $1',
    [userId]
  )
  const out: Record<string, string> = {}
  for (const row of res.rows) out[row.key] = row.value
  return out
}

export async function setUserPreference(
  pool: Pool,
  userId: string,
  key: string,
  value: string
): Promise<void> {
  await pool.query(
    `INSERT INTO user_preferences (user_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [userId, key, value]
  )
}
