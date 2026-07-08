// §13.1 — CLI recovery tool. Run on the NAS when locked out:
//   docker compose exec app tsx src/scripts/reset-password.ts [email] [new-password]
//
// If email/password are omitted, falls back to INITIAL_USER_EMAIL / INITIAL_USER_PASSWORD env vars.
// This is a BREAK-GLASS operation: it resets the hash in-place. All data is preserved.

import { config } from 'dotenv'
import { join } from 'path'
config({ path: join(__dirname, '../../../../.env') })

import { Pool } from 'pg'
import { resetUserPassword } from '../db/recovery'

async function main() {
  const email    = process.argv[2] || process.env.INITIAL_USER_EMAIL
  const password = process.argv[3] || process.env.INITIAL_USER_PASSWORD

  if (!email || !password) {
    console.error('Usage: tsx src/scripts/reset-password.ts <email> [new-password]')
    console.error('Or set INITIAL_USER_EMAIL and INITIAL_USER_PASSWORD env vars')
    process.exit(1)
  }

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    const { userId } = await resetUserPassword(pool, email, password)
    console.log(`[recovery] password reset for ${email} (user_id: ${userId})`)
    console.log('[recovery] all data preserved — no delete, no recreate, user_id unchanged')
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
