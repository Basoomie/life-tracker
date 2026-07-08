// §13.1 — Auth routes: login, logout, change-password.
// No registration endpoint — accounts are created by bootstrap only.
// Login is excluded from the auth preHandler by the seam in app.ts.

import type { FastifyInstance } from 'fastify'
import * as bcrypt from 'bcryptjs'
import { pool } from '../db'
import * as userRepos from '../db/repos/users'
import * as sessionRepos from '../db/repos/auth_sessions'

const SESSION_COOKIE_NAME = 'session'
const SESSION_MAX_AGE     = 30 * 24 * 60 * 60  // 30 days in seconds
const BCRYPT_ROUNDS       = 10

function cookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    // Set COOKIE_SECURE=true only when serving over HTTPS.
    // Omitting it (the default) keeps the cookie working on plain HTTP deployments.
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict' as const,
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
  }
}

// Dummy hash for constant-time compare when email not found (prevents user enumeration)
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/login — public (excluded from auth preHandler)
  // Registered under prefix /auth, so the full path is /auth/login
  app.post('/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string }
    const { email, password } = body

    if (!email || !password) {
      return reply.status(400).send({ error: 'missing_credentials', message: 'Email and password are required' })
    }

    const userWithHash = await userRepos.findUserByEmailWithHash(pool, email)
    const hash = userWithHash?.passwordHash ?? DUMMY_HASH
    const valid = await bcrypt.compare(password, hash)

    if (!userWithHash || !valid || !userWithHash.passwordHash) {
      return reply.status(401).send({ error: 'invalid_credentials', message: 'Invalid email or password' })
    }

    const sessionId = await sessionRepos.createSession(pool, userWithHash.id)

    reply.setCookie(SESSION_COOKIE_NAME, sessionId, cookieOptions(SESSION_MAX_AGE))

    return reply.send({
      user: { id: userWithHash.id, email: userWithHash.email, createdAt: userWithHash.createdAt },
    })
  })

  // POST /auth/logout — authenticated (req.userId is set by preHandler)
  app.post('/logout', async (req, reply) => {
    const sessionId = (req.cookies as Record<string, string | undefined>)?.[SESSION_COOKIE_NAME]
    if (sessionId) {
      await sessionRepos.invalidateSession(pool, sessionId)
    }
    reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions())
    return reply.send({ ok: true })
  })

  // POST /auth/change-password — authenticated
  app.post('/change-password', async (req, reply) => {
    const body = req.body as { currentPassword?: string; newPassword?: string }
    const { currentPassword, newPassword } = body

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'missing_fields', message: 'currentPassword and newPassword are required' })
    }

    const userWithHash = await userRepos.findUserByIdWithHash(pool, req.userId)
    if (!userWithHash?.passwordHash) {
      return reply.status(401).send({ error: 'invalid_current_password', message: 'Current password is incorrect' })
    }

    const valid = await bcrypt.compare(currentPassword, userWithHash.passwordHash)
    if (!valid) {
      return reply.status(401).send({ error: 'invalid_current_password', message: 'Current password is incorrect' })
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    await userRepos.updatePasswordHash(pool, req.userId, newHash)

    return reply.send({ ok: true })
  })
}
