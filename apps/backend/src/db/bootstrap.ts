// §13.1 — First-run bootstrap.
// Creates the initial user ONLY when the users table is empty.
// Runs on every startup; is a no-op if any user already exists.
// DISTINCT from recovery: bootstrap creates; recovery updates-in-place.

import type { Pool } from 'pg'
import * as bcrypt from 'bcryptjs'

const BCRYPT_ROUNDS = 10

export async function bootstrap(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM users`)
  if (parseInt(rows[0].count) > 0) {
    console.log('[bootstrap] user already exists, skipping')
    return
  }

  const email    = process.env.INITIAL_USER_EMAIL
  const password = process.env.INITIAL_USER_PASSWORD

  if (!email || !password) {
    throw new Error(
      'INITIAL_USER_EMAIL and INITIAL_USER_PASSWORD are required for first-run bootstrap'
    )
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)`,
    [email, passwordHash]
  )
  console.log(`[bootstrap] created initial user ${email}`)
}
