// §6.7 — Day-start timeline routes.
// Changes are forward-only: effectiveFrom must be >= today.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { badRequest } from './helpers'
import { todayLocal } from '../domain/day'
import type { CreateDayStartBody } from '@tracker/shared'

export async function dayStartRoutes(app: FastifyInstance) {
  // GET /day-start — full timeline in ascending order
  app.get('/day-start', async (req, reply) => {
    const timeline = await repos.findDayStartTimeline(pool, req.userId)
    return reply.send(timeline)
  })

  // POST /day-start — append new entry (forward-only per §6.7)
  app.post('/day-start', async (req, reply) => {
    const body = req.body as CreateDayStartBody
    const userId = req.userId
    const today = todayLocal()

    // §6.7 — no retroactive changes: effectiveFrom must be >= today
    if (body.effectiveFrom < today) {
      return badRequest(
        reply,
        'past_effective_date',
        `effectiveFrom must be today (${today}) or in the future; got "${body.effectiveFrom}"`
      )
    }

    // Capture previous value for the event log
    const prevEntry = await repos.findEffectiveDayStart(pool, userId, body.effectiveFrom)
    const previousValue = prevEntry?.value ?? null

    const entry = await repos.insertDayStartEntry(pool, {
      userId,
      startsOn: body.effectiveFrom,
      value: body.value,
    })

    await repos.insertEvent(pool, {
      userId,
      eventType: 'day_start_changed',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: {
        newValue: body.value,
        effectiveFrom: body.effectiveFrom,
        previousValue,
      },
    })

    return reply.status(201).send(entry)
  })
}
