// §9.1 — Time-tracking session routes.
// Live sessions: start → pause* → resume* → stop.
// Manual sessions: create with explicit times; patch to edit.

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import { computeSessionDurationMin } from '../domain/sessions'
import { notFound, todayUTC } from './helpers'
import type { StartSessionBody, ManualSessionBody, EditSessionBody } from '@tracker/shared'

export async function sessionRoutes(app: FastifyInstance) {
  // POST /sessions/start — begin a live timer for an item
  app.post('/sessions/start', async (req, reply) => {
    const body = req.body as StartSessionBody
    const userId = req.userId

    const item = await repos.findItemById(pool, body.itemId, userId)
    if (!item) return notFound(reply, 'item')

    const day = body.day ?? todayUTC()
    const occ = await ensureOccurrenceMaterialized(pool, item, day, userId)

    const sessionId = randomUUID()
    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_started',
      occurrenceId: occ.id,
      itemId: item.id,
      appliesToDay: day,
      payload: { sessionId },
    })

    return reply.status(201).send({ sessionId, occurrenceId: occ.id })
  })

  // POST /sessions/:sessionId/pause
  app.post('/sessions/:sessionId/pause', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const userId = req.userId

    const sessionEvents = await repos.findEventsBySessionId(pool, sessionId, userId)
    const startEvent = sessionEvents.find((e) => e.eventType === 'session_started')
    if (!startEvent || !startEvent.occurrenceId) return notFound(reply, 'session')

    const now = new Date()
    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_paused',
      occurrenceId: startEvent.occurrenceId,
      itemId: startEvent.itemId,
      appliesToDay: startEvent.appliesToDay,
      payload: { sessionId, pausedAt: now.toISOString() },
    })

    return reply.send({ ok: true })
  })

  // POST /sessions/:sessionId/resume
  app.post('/sessions/:sessionId/resume', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const userId = req.userId

    const sessionEvents = await repos.findEventsBySessionId(pool, sessionId, userId)
    const startEvent = sessionEvents.find((e) => e.eventType === 'session_started')
    if (!startEvent || !startEvent.occurrenceId) return notFound(reply, 'session')

    const now = new Date()
    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_resumed',
      occurrenceId: startEvent.occurrenceId,
      itemId: startEvent.itemId,
      appliesToDay: startEvent.appliesToDay,
      payload: { sessionId, resumedAt: now.toISOString() },
    })

    return reply.send({ ok: true })
  })

  // POST /sessions/:sessionId/stop
  app.post('/sessions/:sessionId/stop', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const userId = req.userId

    const sessionEvents = await repos.findEventsBySessionId(pool, sessionId, userId)
    const startEvent = sessionEvents.find((e) => e.eventType === 'session_started')
    if (!startEvent || !startEvent.occurrenceId) return notFound(reply, 'session')

    const now = new Date()
    const durationMin = computeSessionDurationMin(sessionEvents, now)

    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_stopped',
      occurrenceId: startEvent.occurrenceId,
      itemId: startEvent.itemId,
      appliesToDay: startEvent.appliesToDay,
      payload: { sessionId, stoppedAt: now.toISOString(), durationMin },
    })

    return reply.send({ sessionId, durationMin })
  })

  // POST /sessions/manual — create a manual (backdated) session
  app.post('/sessions/manual', async (req, reply) => {
    const body = req.body as ManualSessionBody
    const userId = req.userId

    const item = await repos.findItemById(pool, body.itemId, userId)
    if (!item) return notFound(reply, 'item')

    const day = body.day ?? todayUTC()
    const occ = await ensureOccurrenceMaterialized(pool, item, day, userId)

    const startedAt = new Date(body.startedAt)
    const endedAt   = new Date(body.endedAt)
    const durationMin = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000))
    const sessionId = randomUUID()

    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_created',
      occurrenceId: occ.id,
      itemId: item.id,
      appliesToDay: day,
      payload: {
        sessionId,
        startedAt: body.startedAt,
        endedAt: body.endedAt,
        durationMin,
      },
    })

    return reply.status(201).send({ sessionId, occurrenceId: occ.id, durationMin })
  })

  // PATCH /sessions/:sessionId — edit start/end times of any session
  app.patch('/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const userId = req.userId
    const body = req.body as EditSessionBody

    const sessionEvents = await repos.findEventsBySessionId(pool, sessionId, userId)
    if (sessionEvents.length === 0) return notFound(reply, 'session')

    // Get the occurrence from any event in this session
    const anyEvent = sessionEvents[0]
    if (!anyEvent.occurrenceId) return notFound(reply, 'session')

    const startedAt = new Date(body.startedAt)
    const endedAt   = new Date(body.endedAt)
    const durationMin = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000))

    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_edited',
      occurrenceId: anyEvent.occurrenceId,
      itemId: anyEvent.itemId,
      appliesToDay: anyEvent.appliesToDay,
      payload: {
        sessionId,
        startedAt: body.startedAt,
        endedAt: body.endedAt,
        durationMin,
      },
    })

    return reply.send({ sessionId, durationMin })
  })

  // DELETE /sessions/:sessionId — §9.1 correction, not a mutation: appends a
  // session_deleted event so the session is excluded from every downstream
  // duration computation while its original events stay on the record.
  app.delete('/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }
    const userId = req.userId

    const sessionEvents = await repos.findEventsBySessionId(pool, sessionId, userId)
    if (sessionEvents.length === 0) return notFound(reply, 'session')

    const anyEvent = sessionEvents[0]
    if (!anyEvent.occurrenceId) return notFound(reply, 'session')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_deleted',
      occurrenceId: anyEvent.occurrenceId,
      itemId: anyEvent.itemId,
      appliesToDay: anyEvent.appliesToDay,
      payload: { sessionId },
    })

    return reply.send({ ok: true })
  })
}
