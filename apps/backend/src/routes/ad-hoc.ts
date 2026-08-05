// §9.2 — Ad-hoc one-tap capture.
// Creates an item, materializes its occurrence, and starts a live timer in one atomic action.

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { ensureOccurrenceMaterialized, snapshotFromItem } from '../domain/materialization'
import { createItemWithSchedule } from '../domain/items'
import { logicalToday } from '../domain/day'
import type { AdHocCaptureBody } from '@tracker/shared'

export async function adHocRoutes(app: FastifyInstance) {
  // POST /ad-hoc — one-tap: create + materialize + start timer
  app.post('/ad-hoc', async (req, reply) => {
    const body = req.body as AdHocCaptureBody
    const userId = req.userId
    const today = body.day ?? (await logicalToday(pool, userId))

    // §9.2 / §8.1: ad_hoc items are one-time tasks (no recurrence) — same default
    // as any other one-time task (routes/items.ts): 'require_manual', not 'skip'.
    const { item, schedule } = await createItemWithSchedule(pool, {
      userId,
      name: body.name,
      categoryId: body.categoryId ?? null,
      valence: body.valence ?? null,
      recurrenceRule: null,         // one-time task
      creationSource: 'ad_hoc',
      timingPrecision: 'none',
      dispositionPolicy: 'require_manual',
    })

    // §10.2 — template_created event
    const snapshot = snapshotFromItem(item, schedule, [])
    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_created',
      itemId: item.id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { creationSource: item.creationSource, snapshot },
    })

    // Materialize the occurrence for today
    const occurrence = await ensureOccurrenceMaterialized(pool, item, schedule, today, userId)

    // §9.2 — start the live timer immediately
    const sessionId = randomUUID()
    await repos.insertEvent(pool, {
      userId,
      eventType: 'session_started',
      occurrenceId: occurrence.id,
      itemId: item.id,
      appliesToDay: today,
      payload: { sessionId },
    })

    return reply.status(201).send({ item, occurrence, sessionId })
  })
}
