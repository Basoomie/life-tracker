// §13.4 — Application bootstrap with pluggable user-context resolver.
//
// The resolveUserId seam:
//   - Production: sessionResolveUserId reads the 'session' httpOnly cookie.
//   - Tests: inject async () => testUserId directly (bypasses auth entirely).
//
// All routes are registered under /api (except /health and /auth/* which are at root).

import Fastify, { type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { pool } from './db'
import * as repos from './db/repos/index'
import { sessionResolveUserId } from './auth/session-resolver'
import { healthRoutes } from './routes/health'
import { authRoutes } from './routes/auth'
import { occurrenceRoutes } from './routes/occurrences'
import { itemRoutes } from './routes/items'
import { sessionRoutes } from './routes/sessions'
import { adHocRoutes } from './routes/ad-hoc'
import { categoryRoutes } from './routes/categories'
import { reasonRoutes } from './routes/reasons'
import { bucketRoutes } from './routes/buckets'
import { dayStartRoutes } from './routes/day-start'
import { adminRoutes } from './routes/admin'
import { preferencesRoutes } from './routes/preferences'
import { statsRoutes } from './routes/stats'
import { evidenceRoutes } from './routes/evidence'
import { reviewRoutes } from './routes/reviews'

// ── Type augmentation: add userId to every request ────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

// ── Auth guard: only protect routes that need a user identity ────────────────
// Everything else (health, static files, 404→index.html) is implicitly public.
// /auth/login is the only /auth/* route that is public.

function requiresAuth(routerPath: string | undefined): boolean {
  if (!routerPath) return false  // unmatched route (404) — no route to protect
  if (routerPath === '/me') return true
  if (routerPath.startsWith('/api')) return true
  if (routerPath.startsWith('/auth') && routerPath !== '/auth/login') return true
  return false
}

// ── App factory ───────────────────────────────────────────────────────────────

export async function buildApp(
  resolveUserId?: (req: FastifyRequest) => Promise<string>
) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: 'info' },
  })

  // CORS — permissive in development so the Vite dev server can reach the API
  if (process.env.NODE_ENV !== 'production') {
    await app.register(cors, { origin: true, credentials: true })
  }

  // Cookie parsing — required for session auth
  await app.register(cookie)

  app.decorateRequest('userId', '')

  // ── User-context seam (§13.4) ──────────────────────────────────────────────
  // In production: sessionResolveUserId (validates session cookie → user_id).
  // In tests: caller injects a resolver that returns the test user_id directly.

  const resolver = resolveUserId ?? sessionResolveUserId
  app.addHook('preHandler', async (req) => {
    if (!requiresAuth(req.routerPath as string)) return
    req.userId = await resolver(req)
  })

  // ── Routes ────────────────────────────────────────────────────────────────

  // Health check at root (not under /api — used by Docker health checks)
  await app.register(healthRoutes)

  // Auth routes at /auth (login is public; logout + change-password need req.userId)
  await app.register(authRoutes, { prefix: '/auth' })

  // GET /me — user info (authenticated)
  app.get('/me', async (req, reply) => {
    const user = await repos.findUserById(pool, req.userId)
    return reply.send(user)
  })

  // All other routes under /api prefix
  await app.register(async (api) => {
    await api.register(occurrenceRoutes)
    await api.register(itemRoutes)
    await api.register(sessionRoutes)
    await api.register(adHocRoutes)
    await api.register(categoryRoutes)
    await api.register(reasonRoutes)
    await api.register(bucketRoutes)
    await api.register(dayStartRoutes)
    await api.register(adminRoutes)
    await api.register(preferencesRoutes)
    await api.register(statsRoutes)
    await api.register(evidenceRoutes)
    await api.register(reviewRoutes)
  }, { prefix: '/api' })

  // In production the built frontend is served as static files
  if (process.env.NODE_ENV === 'production') {
    const { default: staticFiles } = await import('@fastify/static')
    const { join } = await import('path')
    await app.register(staticFiles, {
      root: join(__dirname, '../../../apps/frontend/dist'),
      prefix: '/',
      wildcard: false,
    })
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html')
    })
  }

  return app
}
