// §13.1 — Server-side session store backed by Postgres.
// Sessions are rows in auth_sessions; the session ID (UUID) is stored in an httpOnly cookie.
// Rolling 30-day expiry: extended on every authenticated request.

import type { Pool } from 'pg'

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

interface SessionRow {
  id: string
  user_id: string
  created_at: Date
  expires_at: Date
  invalidated_at: Date | null
}

export async function createSession(pool: Pool, userId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id`,
    [userId, expiresAt]
  )
  return rows[0].id
}

export async function findActiveSession(
  pool: Pool,
  sessionId: string
): Promise<{ userId: string } | null> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT * FROM auth_sessions
     WHERE id = $1
       AND invalidated_at IS NULL
       AND expires_at > NOW()`,
    [sessionId]
  )
  return rows[0] ? { userId: rows[0].user_id } : null
}

export async function extendSession(pool: Pool, sessionId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
  await pool.query(
    `UPDATE auth_sessions SET expires_at = $1 WHERE id = $2`,
    [expiresAt, sessionId]
  )
}

export async function invalidateSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE auth_sessions SET invalidated_at = NOW() WHERE id = $1`,
    [sessionId]
  )
}

export async function invalidateAllUserSessions(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `UPDATE auth_sessions SET invalidated_at = NOW() WHERE user_id = $1`,
    [userId]
  )
}

// For testing: create a session that is already expired
export async function createExpiredSession(pool: Pool, userId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, NOW() - INTERVAL '1 second') RETURNING id`,
    [userId]
  )
  return rows[0].id
}
