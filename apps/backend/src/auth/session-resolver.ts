// §13.1 — Session-based user resolver.
// Reads the 'session' httpOnly cookie, validates it against auth_sessions,
// extends the rolling expiry, and returns the user_id.
// Throws 401 if no cookie, session not found, expired, or invalidated.

import type { FastifyRequest } from 'fastify'
import { pool } from '../db'
import * as sessionRepos from '../db/repos/auth_sessions'

const SESSION_COOKIE_NAME = 'session'

export async function sessionResolveUserId(req: FastifyRequest): Promise<string> {
  const sessionId = (req.cookies as Record<string, string | undefined>)?.[SESSION_COOKIE_NAME]

  if (!sessionId) {
    const err = new Error('Authentication required') as Error & { statusCode: number }
    err.statusCode = 401
    throw err
  }

  const session = await sessionRepos.findActiveSession(pool, sessionId)

  if (!session) {
    const err = new Error('Session invalid or expired') as Error & { statusCode: number }
    err.statusCode = 401
    throw err
  }

  await sessionRepos.extendSession(pool, sessionId)

  return session.userId
}
