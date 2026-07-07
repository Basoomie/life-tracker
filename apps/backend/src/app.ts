// §13.4 — Application bootstrap with pluggable user-context resolver.
//
// The resolveUserId seam:
//   - Production: read a real auth token (step 5).
//   - v1 default: look up 'default@tracker.local' from the DB.
//   - Tests: inject async () => testUserId directly.
//
// All routes are registered under /api (except /health which stays at the root).

import Fastify, { type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import { pool } from './db'
import * as repos from './db/repos/index'
import { healthRoutes } from './routes/health'
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

// ── Type augmentation: add userId to every request ────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

// ── Default user (v1 single-user) ─────────────────────────────────────────────

const DEFAULT_USER_EMAIL = 'default@tracker.local'

async function defaultResolveUserId(_req: FastifyRequest): Promise<string> {
  const user = await repos.findUserByEmail(pool, DEFAULT_USER_EMAIL)
  if (!user) {
    throw new Error(
      `Default user (${DEFAULT_USER_EMAIL}) not found — run the seed script first.`
    )
  }
  return user.id
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
    await app.register(cors, { origin: true })
  }

  // ── User-context seam (§13.4) ──────────────────────────────────────────────

  app.decorateRequest('userId', '')
  const resolver = resolveUserId ?? defaultResolveUserId
  app.addHook('preHandler', async (req) => {
    req.userId = await resolver(req)
  })

  // ── Routes ────────────────────────────────────────────────────────────────

  // Health check at root (not under /api — used by Docker health checks)
  await app.register(healthRoutes)

  // GET /me — user info
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
