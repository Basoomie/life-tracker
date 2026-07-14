// §9.2 — Ad-hoc one-tap capture.
// Creates an item, materializes its occurrence, and starts a live timer in one atomic action.

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import { logicalToday } from '../domain/day'
import type { AdHocCaptureBody, ItemSnapshot } from '@tracker/shared'

export async function adHocRoutes(app: FastifyInstance) {
  // POST /ad-hoc — one-tap: create + materialize + start timer
  app.post('/ad-hoc', async (req, reply) => {
    const body = req.body as AdHocCaptureBody
    const userId = req.userId
    const today = await logicalToday(pool, userId)

    // §9.2: ad_hoc items use creationSource 'ad_hoc', no recurrence, skip disposition
    const item = await repos.insertItem(pool, {
      userId,
      name: body.name,
      categoryId: body.categoryId ?? null,
      valence: body.valence ?? null,
      recurrenceRule: null,         // one-time task
      creationSource: 'ad_hoc',
      timingPrecision: 'none',
      dispositionPolicy: 'skip',
    })

    // §10.2 — template_created event
    const snapshot: ItemSnapshot = {
      name: item.name,
      description: item.description,
      categoryId: item.categoryId,
      valence: item.valence,
      priority: item.priority,
      recurrenceRule: item.recurrenceRule,
      quotaTarget: item.quotaTarget,
      timingPrecision: item.timingPrecision,
      timingBucketId: item.timingBucketId,
      timingStartTime: item.timingStartTime,
      timingEndTime: item.timingEndTime,
      plannedDurationMin: item.plannedDurationMin,
      dispositionPolicy: item.dispositionPolicy,
      parentId: item.parentId,
      prerequisiteIds: [],
    }
    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_created',
      itemId: item.id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { creationSource: item.creationSource, snapshot },
    })

    // Materialize the occurrence for today
    const occurrence = await ensureOccurrenceMaterialized(pool, item, today, userId)

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
