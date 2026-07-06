// §5.4 / §6 / §8 — Occurrence routes.
// All business logic is in domain functions; routes only orchestrate.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { getOccurrencesInRange } from '../domain/materialization'
import {
  completeLeaf,
  uncompleteLeaf,
  completeRetroactive,
  completeChild,
  uncompleteChild,
  declareParentPercent,
} from '../domain/completion'
import { skipOccurrenceByUser, excuseOccurrenceByUser, carryForward } from '../domain/dispositions'
import { notFound, badRequest, todayUTC, enrichOccurrence } from './helpers'
import type { DeclarePercentBody, DispositionBody, CarryForwardBody, RetroactiveBody } from '@tracker/shared'

export async function occurrenceRoutes(app: FastifyInstance) {
  // GET /occurrences?start=YYYY-MM-DD&end=YYYY-MM-DD
  app.get('/occurrences', async (req, reply) => {
    const { start, end } = req.query as { start?: string; end?: string }
    if (!start || !end) {
      return badRequest(reply, 'missing_params', 'Query params ?start and ?end (YYYY-MM-DD) are required')
    }
    const userId = req.userId
    const occs = await getOccurrencesInRange(pool, userId, start, end)
    const enriched = await Promise.all(occs.map((o) => enrichOccurrence(pool, o, userId)))
    return reply.send(enriched)
  })

  // GET /occurrences/today — shortcut for start=end=today
  app.get('/occurrences/today', async (req, reply) => {
    const today = todayUTC()
    const userId = req.userId
    const occs = await getOccurrencesInRange(pool, userId, today, today)
    const enriched = await Promise.all(occs.map((o) => enrichOccurrence(pool, o, userId)))
    return reply.send(enriched)
  })

  // GET /occurrences/:id
  app.get('/occurrences/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')
    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/complete — §6.1
  app.post('/occurrences/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    // Route to child or leaf completion based on parentId in snapshot (§6.1)
    const parentItemId = occ.snapshot.parentId
    if (parentItemId) {
      const parentOcc = await repos.findOccurrenceByItemAndDay(pool, parentItemId, occ.appliesToDay, userId)
      if (parentOcc) {
        await completeChild(pool, occ, parentOcc, userId)
      } else {
        await completeLeaf(pool, occ, userId)
      }
    } else {
      await completeLeaf(pool, occ, userId)
    }

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/uncomplete — §6.1
  app.post('/occurrences/:id/uncomplete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    const parentItemId = occ.snapshot.parentId
    if (parentItemId) {
      const parentOcc = await repos.findOccurrenceByItemAndDay(pool, parentItemId, occ.appliesToDay, userId)
      if (parentOcc) {
        await uncompleteChild(pool, occ, parentOcc, userId)
      } else {
        await uncompleteLeaf(pool, occ, userId)
      }
    } else {
      await uncompleteLeaf(pool, occ, userId)
    }

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/complete-retroactive — §6.4
  app.post('/occurrences/:id/complete-retroactive', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as RetroactiveBody | undefined
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    const recordedAt = body?.recordedAt ? new Date(body.recordedAt) : undefined
    await completeRetroactive(pool, occ, userId, recordedAt)

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/declare-percent — §6.2
  app.post('/occurrences/:id/declare-percent', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as DeclarePercentBody
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    await declareParentPercent(pool, occ, userId, body.percent)

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/skip — §8
  app.post('/occurrences/:id/skip', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = (req.body ?? {}) as DispositionBody
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    await skipOccurrenceByUser(pool, occ, userId, {
      reasonId: body.reasonId ?? null,
      comment: body.comment ?? null,
    })

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/excuse — §8
  app.post('/occurrences/:id/excuse', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = (req.body ?? {}) as DispositionBody
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    await excuseOccurrenceByUser(pool, occ, userId, {
      reasonId: body.reasonId ?? null,
      comment: body.comment ?? null,
    })

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/carry-forward — §8.2
  app.post('/occurrences/:id/carry-forward', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as CarryForwardBody
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    if (!body.targetDay) {
      return badRequest(reply, 'missing_params', 'targetDay is required')
    }

    const result = await carryForward(pool, occ, body.targetDay, userId, {
      reasonId: body.reasonId ?? null,
      comment: body.comment ?? null,
    })

    return reply.send(result)
  })
}
