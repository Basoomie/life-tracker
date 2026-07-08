// §13.1 — Break-glass password recovery.
//
// HIGHEST-STAKES RULE: this MUST NOT lose or orphan data.
// Recovery resets the password of an EXISTING user in-place.
// It finds the user by email and does UPDATE users SET password_hash = $1 WHERE id = $2.
//
// It MUST NEVER: delete the user row, recreate the user, change user_id, or cascade-delete
// anything. The user_id is immutable and everything the user owns is foreign-keyed to it.
//
// Bootstrap (create-if-none) and recovery (update-existing-in-place) are DISTINCT operations.
// Do NOT call bootstrap as a recovery path.

import type { Pool } from 'pg'
import * as bcrypt from 'bcryptjs'
import { findUserByEmail, updatePasswordHash } from './repos/users'

const BCRYPT_ROUNDS = 10

export async function resetUserPassword(
  pool: Pool,
  email: string,
  newPassword: string
): Promise<{ userId: string }> {
  const user = await findUserByEmail(pool, email)
  if (!user) {
    throw new Error(
      `No user found with email: ${email}. ` +
      `Recovery resets an EXISTING user only — use bootstrap for first-run.`
    )
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  // UPDATE only the password_hash column; user_id, email, created_at are untouched
  await updatePasswordHash(pool, user.id, passwordHash)

  return { userId: user.id }
}
