import type { Pool } from 'pg'
import type { User } from '@tracker/shared'

interface UserRow {
  id: string
  email: string
  created_at: Date
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, createdAt: row.created_at }
}

export async function insertUser(
  pool: Pool,
  data: { email: string }
): Promise<User> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email) VALUES ($1) RETURNING *`,
    [data.email]
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
