import type { Pool } from 'pg'
import type { User } from '@tracker/shared'

interface UserRow {
  id: string
  email: string
  password_hash: string | null
  created_at: Date
}

// Internal type — never exposed over the API; only used within auth code
export type UserWithHash = User & { passwordHash: string | null }

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, createdAt: row.created_at }
}

function toUserWithHash(row: UserRow): UserWithHash {
  return { id: row.id, email: row.email, createdAt: row.created_at, passwordHash: row.password_hash }
}

export async function insertUser(
  pool: Pool,
  data: { email: string; passwordHash?: string }
): Promise<User> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`,
    [data.email, data.passwordHash ?? null]
  )
  return toUser(rows[0])
}

export async function findUserById(
  pool: Pool,
  id: string
): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users WHERE id = $1`,
    [id]
  )
  return rows[0] ? toUser(rows[0]) : null
}

export async function findUserByEmail(
  pool: Pool,
  email: string
): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  )
  return rows[0] ? toUser(rows[0]) : null
}

// v1 is single-user (CLAUDE.md multi-user scoping rule: v1 always uses the same
// user). Used by the background scheduler, which needs a userId but has no
// request/session to read one from. Picks the earliest-created row so behavior
// is stable even if a second user row is ever added ahead of v2's multi-user work.
export async function findSoleUser(pool: Pool): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users ORDER BY created_at ASC LIMIT 1`
  )
  return rows[0] ? toUser(rows[0]) : null
}

// Used by auth login — includes password_hash for verification
export async function findUserByEmailWithHash(
  pool: Pool,
  email: string
): Promise<UserWithHash | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users WHERE email = $1`,
    [email]
  )
  return rows[0] ? toUserWithHash(rows[0]) : null
}

// Used by change-password — includes hash for current-password verification
export async function findUserByIdWithHash(
  pool: Pool,
  id: string
): Promise<UserWithHash | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users WHERE id = $1`,
    [id]
  )
  return rows[0] ? toUserWithHash(rows[0]) : null
}

// §13.1 — update password hash in-place; never touches user_id, email, or created_at
export async function updatePasswordHash(
  pool: Pool,
  userId: string,
  passwordHash: string
): Promise<void> {
  await pool.query(
    `UPDATE users SET password_hash = $1 WHERE id = $2`,
    [passwordHash, userId]
  )
}
