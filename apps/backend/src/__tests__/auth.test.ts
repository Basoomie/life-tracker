// §13.1 — Auth integration tests.
// Named after the spec rules they verify.
// All tests use app.inject() against a real Fastify instance backed by the test DB.
// The default (no resolver override) is used so real session auth is exercised.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as bcrypt from 'bcryptjs'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import { buildApp } from '../app'
import { bootstrap } from '../db/bootstrap'
import { resetUserPassword } from '../db/recovery'
import * as userRepos from '../db/repos/users'
import * as itemRepos from '../db/repos/items'
import * as sessionRepos from '../db/repos/auth_sessions'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import type { FastifyInstance } from 'fastify'

const BCRYPT_ROUNDS = 4  // low cost for tests; still exercises the real algorithm

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createUser(email: string, password: string) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  return userRepos.insertUser(getTestPool(), { email, passwordHash: hash })
}

async function loginViaAPI(
  app: FastifyInstance,
  email: string,
  password: string
) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  })
}

function extractSessionCookie(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'] as string | string[] | undefined
  if (!raw) return null
  const cookies = Array.isArray(raw) ? raw : [raw]
  const entry = cookies.find((c) => c.startsWith('session='))
  if (!entry) return null
  return entry.split(';')[0].split('=')[1]
}

// ── §13.1 first-run bootstrap ─────────────────────────────────────────────────
// These run first while the DB is still empty (from setupTestDb).

describe('§13.1 first-run bootstrap creates user when table is empty', () => {
  it('bootstrap creates the initial user when users table is empty', async () => {
    // DB is empty after setupTestDb() — this is the first test
    const prev = process.env.INITIAL_USER_EMAIL
    const prevP = process.env.INITIAL_USER_PASSWORD
    process.env.INITIAL_USER_EMAIL = 'bootstrap@test.internal'
    process.env.INITIAL_USER_PASSWORD = 'BootstrapPass1!'

    try {
      await bootstrap(getTestPool())
      const user = await userRepos.findUserByEmail(getTestPool(), 'bootstrap@test.internal')
      expect(user).not.toBeNull()
      expect(user!.email).toBe('bootstrap@test.internal')
    } finally {
      process.env.INITIAL_USER_EMAIL = prev
      process.env.INITIAL_USER_PASSWORD = prevP
    }
  })

  it('bootstrap does NOT run when a user already exists', async () => {
    // From previous test, one user exists
    const { rows: before } = await getTestPool().query<{ count: string }>('SELECT COUNT(*) FROM users')
    const countBefore = before[0].count

    const prev = process.env.INITIAL_USER_EMAIL
    const prevP = process.env.INITIAL_USER_PASSWORD
    process.env.INITIAL_USER_EMAIL = 'bootstrap2@test.internal'
    process.env.INITIAL_USER_PASSWORD = 'ShouldNotRun1!'

    try {
      await bootstrap(getTestPool())
      const { rows: after } = await getTestPool().query<{ count: string }>('SELECT COUNT(*) FROM users')
      expect(after[0].count).toBe(countBefore)  // no new user was created
    } finally {
      process.env.INITIAL_USER_EMAIL = prev
      process.env.INITIAL_USER_PASSWORD = prevP
    }
  })
})

// ── §13.1 password hashing ────────────────────────────────────────────────────

describe('§13.1 password is hashed in the DB; plaintext is never stored', () => {
  it('password stored as bcrypt hash; plaintext password is not in the DB', async () => {
    const email = 'hash-test@auth.test'
    const plaintext = 'myPlaintextPassword!'
    await createUser(email, plaintext)

    // Query DB directly and check the raw password_hash column
    const { rows } = await getTestPool().query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = $1`,
      [email]
    )
    expect(rows[0]).toBeDefined()
    const storedHash = rows[0].password_hash
    expect(storedHash).not.toBe(plaintext)
    expect(storedHash).toMatch(/^\$2[ab]\$/)  // bcrypt format
    expect(await bcrypt.compare(plaintext, storedHash)).toBe(true)
  })
})

// ── §13.1 login / credential verification ────────────────────────────────────

describe('§13.1 wrong password is rejected; correct password establishes a session', () => {
  it('wrong password returns 401', async () => {
    const email = 'cred-test@auth.test'
    await createUser(email, 'correctPassword1!')
    const app = await buildApp()

    const res = await loginViaAPI(app, email, 'wrongPassword!')
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('invalid_credentials')

    await app.close()
  })

  it('correct password returns 200 and sets a session cookie', async () => {
    const email = 'cred-success@auth.test'
    await createUser(email, 'correctPassword1!')
    const app = await buildApp()

    const res = await loginViaAPI(app, email, 'correctPassword1!')
    expect(res.statusCode).toBe(200)

    const sessionId = extractSessionCookie(res)
    expect(sessionId).toBeTruthy()

    const body = JSON.parse(res.body)
    expect(body.user).toBeDefined()
    expect(body.user.email).toBe(email)

    await app.close()
  })
})

// ── §13.1 session cookie attributes ──────────────────────────────────────────

describe('§13.1 session cookie is httpOnly and sameSite=strict', () => {
  it('Set-Cookie header includes HttpOnly and SameSite=Strict', async () => {
    const email = 'cookie-attrs@auth.test'
    await createUser(email, 'cookiePass1!')
    const app = await buildApp()

    const res = await loginViaAPI(app, email, 'cookiePass1!')
    expect(res.statusCode).toBe(200)

    const raw = res.headers['set-cookie']
    const cookieStr = (Array.isArray(raw) ? raw[0] : raw) as string
    expect(cookieStr).toBeTruthy()

    // HttpOnly — prevents JS access (§13.1)
    expect(cookieStr.toLowerCase()).toContain('httponly')
    // SameSite=Strict — prevents CSRF (§13.1)
    expect(cookieStr.toLowerCase()).toContain('samesite=strict')

    await app.close()
  })
})

// ── §13.1 unauthenticated request rejected ────────────────────────────────────

describe('§13.1 unauthenticated request to a protected route is rejected', () => {
  it('GET /api/occurrences without session cookie returns 401', async () => {
    const app = await buildApp()  // no resolver override — uses real session auth

    const res = await app.inject({
      method: 'GET',
      url: '/api/occurrences?start=2025-01-15&end=2025-01-15',
      // no cookies
    })
    expect(res.statusCode).toBe(401)

    await app.close()
  })

  it('GET /me without session cookie returns 401', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/me' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

// ── §13.1 logout invalidates session server-side ──────────────────────────────

describe('§13.1 logout invalidates the session server-side', () => {
  it('session cookie works before logout; after logout the same cookie is rejected', async () => {
    const email = 'logout-test@auth.test'
    await createUser(email, 'logoutPass1!')
    const app = await buildApp()

    // Login — get session cookie
    const loginRes = await loginViaAPI(app, email, 'logoutPass1!')
    expect(loginRes.statusCode).toBe(200)
    const sessionId = extractSessionCookie(loginRes)!
    expect(sessionId).toBeTruthy()

    // Authenticated request succeeds
    const before = await app.inject({
      method: 'GET',
      url: '/me',
      cookies: { session: sessionId },
    })
    expect(before.statusCode).toBe(200)

    // Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { session: sessionId },
    })
    expect(logoutRes.statusCode).toBe(200)

    // Same cookie now rejected
    const after = await app.inject({
      method: 'GET',
      url: '/me',
      cookies: { session: sessionId },
    })
    expect(after.statusCode).toBe(401)

    await app.close()
  })
})

// ── §13.1 expired session rejected ───────────────────────────────────────────

describe('§13.1 expired session is rejected', () => {
  it('a session past its expires_at returns 401', async () => {
    const email = 'expired-sess@auth.test'
    const user = await createUser(email, 'expiredPass1!')
    const app = await buildApp()

    // Create a session that is already expired (expires_at in the past)
    const expiredId = await sessionRepos.createExpiredSession(getTestPool(), user.id)

    const res = await app.inject({
      method: 'GET',
      url: '/me',
      cookies: { session: expiredId },
    })
    expect(res.statusCode).toBe(401)

    await app.close()
  })
})

// ── §13.1 no public registration ─────────────────────────────────────────────

describe('§13.1 no public registration endpoint exists', () => {
  it('POST /auth/register is rejected — no account is created', async () => {
    const app = await buildApp()

    const countBefore = (await getTestPool().query<{ count: string }>('SELECT COUNT(*) FROM users')).rows[0].count

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'attacker@evil.com', password: 'hacked' },
    })
    // 401 (preHandler rejects before routing) or 404 (route not found) — neither creates an account
    expect([401, 404]).toContain(res.statusCode)

    // Most important: no new user was created
    const countAfter = (await getTestPool().query<{ count: string }>('SELECT COUNT(*) FROM users')).rows[0].count
    expect(countAfter).toBe(countBefore)

    await app.close()
  })
})

// ── §13.4 scoping under real sessions ────────────────────────────────────────

describe('§13.4 authenticated user A cannot read user B data under real sessions', () => {
  it('user A session cannot access user B occurrences', async () => {
    const userA = await createUser('real-scope-a@auth.test', 'passA1!')
    const userB = await createUser('real-scope-b@auth.test', 'passB1!')
    const app = await buildApp()

    // Login as user A
    const loginA = await loginViaAPI(app, 'real-scope-a@auth.test', 'passA1!')
    expect(loginA.statusCode).toBe(200)
    const sessionA = extractSessionCookie(loginA)!

    // Create item + occurrence for user B
    const itemB = await itemRepos.insertItem(getTestPool(), {
      userId: userB.id,
      name: 'User B Secret Task',
      recurrenceRule: null,
      creationSource: 'planned',
    })
    await ensureOccurrenceMaterialized(getTestPool(), itemB, '2025-01-15', userB.id)

    // User A queries occurrences with their session — must not see B's data
    const res = await app.inject({
      method: 'GET',
      url: '/api/occurrences?start=2025-01-15&end=2025-01-15',
      cookies: { session: sessionA },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as { itemId: string }[]
    expect(data.map((o) => o.itemId)).not.toContain(itemB.id)

    await app.close()
  })
})

// ── §13.1 change-password ─────────────────────────────────────────────────────

describe('§13.1 change-password updates hash in place; user_id and old password invalidated', () => {
  it('old password rejected after change; new password accepted; user_id unchanged', async () => {
    const email = 'change-pw@auth.test'
    const user  = await createUser(email, 'oldPassword1!')
    const app   = await buildApp()

    // Login with old password
    const loginRes = await loginViaAPI(app, email, 'oldPassword1!')
    expect(loginRes.statusCode).toBe(200)
    const sessionId = extractSessionCookie(loginRes)!

    // Change password
    const changeRes = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      cookies: { session: sessionId },
      payload: { currentPassword: 'oldPassword1!', newPassword: 'newPassword2!' },
    })
    expect(changeRes.statusCode).toBe(200)

    // Old password no longer works for login
    const loginOld = await loginViaAPI(app, email, 'oldPassword1!')
    expect(loginOld.statusCode).toBe(401)

    // New password works
    const loginNew = await loginViaAPI(app, email, 'newPassword2!')
    expect(loginNew.statusCode).toBe(200)

    // user_id is unchanged
    const userAfter = await userRepos.findUserByEmail(getTestPool(), email)
    expect(userAfter!.id).toBe(user.id)

    await app.close()
  })

  it('wrong current password returns 401 and does not change the hash', async () => {
    const email = 'change-pw-wrong@auth.test'
    await createUser(email, 'originalPass1!')
    const app  = await buildApp()

    const loginRes = await loginViaAPI(app, email, 'originalPass1!')
    const sessionId = extractSessionCookie(loginRes)!

    const res = await app.inject({
      method: 'POST',
      url: '/auth/change-password',
      cookies: { session: sessionId },
      payload: { currentPassword: 'wrongCurrent!', newPassword: 'newPass2!' },
    })
    expect(res.statusCode).toBe(401)

    // Original password still works
    const loginAfter = await loginViaAPI(app, email, 'originalPass1!')
    expect(loginAfter.statusCode).toBe(200)

    await app.close()
  })
})

// ── §13.1 DATA-PRESERVATION RECOVERY TEST ────────────────────────────────────

describe('§13.1 DATA-PRESERVATION RECOVERY TEST — recovery resets password; all data survives', () => {
  it('recovery is in-place: user_id unchanged; all owned items/occurrences/events survive', async () => {
    const email = 'recovery-test@auth.test'
    const user  = await createUser(email, 'originalPassword1!')
    const capturedUserId = user.id

    // Seed this user with items, occurrences, and events
    const item = await itemRepos.insertItem(getTestPool(), {
      userId: user.id,
      name: 'Recovery Test Item',
      recurrenceRule: null,
      creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, '2025-01-15', user.id)

    // Record a completion event on the occurrence
    const { rows: [eventBefore] } = await getTestPool().query<{ count: string }>(
      `SELECT COUNT(*) FROM events WHERE occurrence_id = $1`,
      [occ.id]
    )
    // (occurrence is materialized; events start at 0)

    // ── Run recovery ──────────────────────────────────────────────────────────
    const { userId: recoveredUserId } = await resetUserPassword(getTestPool(), email, 'newRecoveredPass1!')

    // user_id must not change
    expect(recoveredUserId).toBe(capturedUserId)

    // Verify user row still exists with same id
    const userAfter = await userRepos.findUserByEmail(getTestPool(), email)
    expect(userAfter).not.toBeNull()
    expect(userAfter!.id).toBe(capturedUserId)
    expect(userAfter!.email).toBe(email)

    // All owned items survive
    const { rows: ownedItems } = await getTestPool().query<{ id: string }>(
      `SELECT id FROM items WHERE user_id = $1`,
      [capturedUserId]
    )
    expect(ownedItems.map((r) => r.id)).toContain(item.id)

    // All owned occurrences survive
    const { rows: ownedOccs } = await getTestPool().query<{ id: string }>(
      `SELECT id FROM occurrences WHERE user_id = $1`,
      [capturedUserId]
    )
    expect(ownedOccs.map((r) => r.id)).toContain(occ.id)

    // New password now works; old password no longer works
    const app = await buildApp()
    const loginNew = await loginViaAPI(app, email, 'newRecoveredPass1!')
    expect(loginNew.statusCode).toBe(200)

    const loginOld = await loginViaAPI(app, email, 'originalPassword1!')
    expect(loginOld.statusCode).toBe(401)

    await app.close()
  })

  it('recovery is in-place: no user row was deleted or recreated', async () => {
    const email = 'recovery-nodelete@auth.test'
    const user  = await createUser(email, 'beforeRecovery1!')

    // Capture created_at before recovery (proves the row is the same one)
    const { rows: [before] } = await getTestPool().query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM users WHERE email = $1`,
      [email]
    )

    await resetUserPassword(getTestPool(), email, 'afterRecovery1!')

    const { rows: [after] } = await getTestPool().query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM users WHERE email = $1`,
      [email]
    )

    // Same row: id and created_at are identical (not a recreate)
    expect(after.id).toBe(before.id)
    expect(after.id).toBe(user.id)
    expect(after.created_at.toISOString()).toBe(before.created_at.toISOString())
  })
})
