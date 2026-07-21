// §5.4 / §6 / §8 — Occurrence routes.
// All business logic is in domain functions; routes only orchestrate.

import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { getOccurrencesInRange, getOverdueOccurrences, ensureOccurrenceMaterialized } from '../domain/materialization'
import {
  completeLeaf,
  uncompleteLeaf,
  completeRetroactive,
  completeChild,
  uncompleteChild,
  declareParentPercent,
} from '../domain/completion'
import { skipOccurrenceByUser, excuseOccurrenceByUser, carryForward, clearDispositionByUser } from '../domain/dispositions'
import { notFound, badRequest, enrichOccurrence } from './helpers'
import type { DeclarePercentBody, DispositionBody, CarryForwardBody, RetroactiveBody } from '@tracker/shared'

// An occurrence whose own item has children is a parent node — its completion
// is governed by derived/declared % (§6.1/§6.2), never by a leaf item_completed
// event, regardless of whether it also happens to be someone else's child.
async function occurrenceHasChildren(pool: Pool, itemId: string, userId: string): Promise<boolean> {
  const children = await repos.findChildItems(pool, itemId, userId)
  return children.length > 0
}

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

  // GET /occurrences/overdue?before=YYYY-MM-DD — §8 amendment: the "Overdue"
  // backlog. `before` (today, day-start-bucketed) is supplied by the caller,
  // same convention as ?start/?end on GET /occurrences — this route never
  // computes "today" itself. Surfaces materialized occurrences from earlier
  // days that are still pending (e.g. one-time require_manual tasks, which
  // otherwise sit invisible on their original day forever since Now only
  // shows today and List's other ranges require guessing the exact date).
  app.get('/occurrences/overdue', async (req, reply) => {
    const { before } = req.query as { before?: string }
    if (!before) {
      return badRequest(reply, 'missing_params', 'Query param ?before (YYYY-MM-DD) is required')
    }
    const userId = req.userId
    const stored = await getOverdueOccurrences(pool, userId, before)
    const enriched = await Promise.all(stored.map((o) => enrichOccurrence(pool, o, userId)))
    const pending = enriched.filter((o) => o.disposition.type === 'pending')
    return reply.send(pending)
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

  // POST /occurrences/complete-by-item-day — §5.4 lazy materialization + complete.
  // Used when the occurrence has no stored row yet (id=null on the client).
  // Materializes the row if needed, then runs the same completion logic as /:id/complete.
  app.post('/occurrences/complete-by-item-day', async (req, reply) => {
    const { itemId, appliesToDay } = (req.body ?? {}) as { itemId?: string; appliesToDay?: string }
    if (!itemId || !appliesToDay) {
      return badRequest(reply, 'missing_params', 'itemId and appliesToDay are required')
    }
    const userId = req.userId
    const item = await repos.findItemById(pool, itemId, userId)
    if (!item || item.archivedAt) return notFound(reply, 'item')

    const occ = await ensureOccurrenceMaterialized(pool, item, appliesToDay, userId)

    if (await occurrenceHasChildren(pool, occ.itemId, userId)) {
      await declareParentPercent(pool, occ, userId, 100)
    } else {
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
    }

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // POST /occurrences/:id/complete — §6.1
  app.post('/occurrences/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    // A parent occurrence (has its own children) is completed via the declared-%
    // override (§6.2) — never as a leaf, even if it's also nested under a parent.
    if (await occurrenceHasChildren(pool, occ.itemId, userId)) {
      await declareParentPercent(pool, occ, userId, 100)
    } else {
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

    if (await occurrenceHasChildren(pool, occ.itemId, userId)) {
      await declareParentPercent(pool, occ, userId, 0)
    } else {
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

  // POST /occurrences/:id/clear-disposition — undo a skip/excuse/carry-forward.
  // Not part of the original §8 policy set; added so a mis-clicked disposition
  // is reversible. Only valid from skipped/excused/rescheduled (see
  // clearDispositionByUser's guard) — 400s otherwise.
  app.post('/occurrences/:id/clear-disposition', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    const result = await clearDispositionByUser(pool, occ, userId)
    if (!result.ok) {
      return badRequest(reply, 'disposition_not_clearable', result.error)
    }

    const enriched = await enrichOccurrence(pool, occ, userId)
    return reply.send(enriched)
  })

  // GET /occurrences/:id/sessions — §9.1 individual logged sessions for this
  // occurrence (not its subtree), for the session-manager UI.
  app.get('/occurrences/:id/sessions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const occ = await repos.findOccurrenceById(pool, id, userId)
    if (!occ) return notFound(reply, 'occurrence')

    const sessions = await repos.findSessionsByOccurrence(pool, id, userId)
    return reply.send(sessions.map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt.toISOString(),
      durationMin: s.durationMin,
      source: s.source,
    })))
  })
}
