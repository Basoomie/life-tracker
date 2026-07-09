// v2 Layer 1 / 1.5 — Stats routes.
// Thin routes: all logic in stats/index.ts calculators and observation builders.
// All routes are user_id-scoped through the existing preHandler choke point (§13.4).

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { notFound, badRequest } from './helpers'
import type { DateWindow } from '@tracker/shared'
import {
  getItemAdherence,
  getItemStreak,
  getItemTimeStats,
  getAdHocShare,
  getCategoryTimeStats,
  getItemProcrastination,
  getItemDataQuality,
  getUserDataQuality,
} from '../stats/index'
import {
  getContextStability,
  getAutocorrelation,
  getTrajectory,
  getDayOfWeek,
  getTwoCondition,
} from '../stats/layer2'

function parseWindow(qs: Record<string, unknown>): DateWindow | null {
  const { startDay, endDay } = qs
  if (typeof startDay !== 'string' || typeof endDay !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(endDay)) return null
  if (startDay > endDay) return null
  return { startDay, endDay }
}

export async function statsRoutes(app: FastifyInstance) {
  // ── Per-item routes ────────────────────────────────────────────────────────

  app.get('/stats/items/:itemId/adherence', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay (YYYY-MM-DD) are required and startDay must be ≤ endDay')
    try {
      return reply.send(await getItemAdherence(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  app.get('/stats/items/:itemId/streaks', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getItemStreak(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  app.get('/stats/items/:itemId/time', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getItemTimeStats(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  app.get('/stats/items/:itemId/procrastination', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getItemProcrastination(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  app.get('/stats/items/:itemId/quality', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getItemDataQuality(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  // ── Cross-item routes ──────────────────────────────────────────────────────

  // GET /api/stats/time — ad-hoc share (cross-item, planned vs. unplanned)
  app.get('/stats/time', async (req, reply) => {
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    return reply.send(await getAdHocShare(pool, req.userId, window))
  })

  // GET /api/stats/quality — user-wide data quality
  app.get('/stats/quality', async (req, reply) => {
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    return reply.send(await getUserDataQuality(pool, req.userId, window))
  })

  // ── Category route ─────────────────────────────────────────────────────────

  app.get('/stats/categories/:categoryId/time', async (req, reply) => {
    const { categoryId } = req.params as { categoryId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    return reply.send(await getCategoryTimeStats(pool, req.userId, categoryId, window))
  })

  // ── Layer 2 routes ─────────────────────────────────────────────────────────
  // All routes are user_id-scoped through the preHandler choke point (§13.4).
  // Thin routes; all logic in layer2.ts and calculators.

  // GET /api/stats/items/:itemId/context-stability
  app.get('/stats/items/:itemId/context-stability', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getContextStability(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  // GET /api/stats/items/:itemId/autocorrelation
  app.get('/stats/items/:itemId/autocorrelation', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getAutocorrelation(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  // GET /api/stats/items/:itemId/trajectory
  app.get('/stats/items/:itemId/trajectory', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getTrajectory(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  // GET /api/stats/items/:itemId/day-of-week
  app.get('/stats/items/:itemId/day-of-week', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getDayOfWeek(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })

  // GET /api/stats/items/:itemId/weekday-vs-weekend
  app.get('/stats/items/:itemId/weekday-vs-weekend', async (req, reply) => {
    const { itemId } = req.params as { itemId: string }
    const window = parseWindow(req.query as Record<string, unknown>)
    if (!window) return badRequest(reply, 'invalid_window', 'startDay and endDay are required')
    try {
      return reply.send(await getTwoCondition(pool, req.userId, itemId, window))
    } catch {
      return notFound(reply, 'item')
    }
  })
}
