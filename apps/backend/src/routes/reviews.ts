// v2 §9.5.2 — Reviews: headless read API. No UI this step (per CLAUDE.md scope for
// step 3b); generation is scheduled (see routes/admin.ts), never requested here.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { notFound } from './helpers'
import type { ReviewCadence } from '@tracker/shared'

const VALID_CADENCES = new Set<ReviewCadence>(['weekly', 'monthly', 'quarterly'])

export async function reviewRoutes(app: FastifyInstance) {
  // GET /reviews?cadence=weekly — chronological history, newest first (§9.5.2).
  app.get('/reviews', async (req, reply) => {
    const { cadence } = req.query as { cadence?: string }
    const filter = cadence && VALID_CADENCES.has(cadence as ReviewCadence) ? (cadence as ReviewCadence) : undefined
    const reviews = await repos.findReviewsByUser(pool, req.userId, filter)
    return reply.send(reviews)
  })

  // GET /reviews/:id
  app.get('/reviews/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const review = await repos.findReviewById(pool, id, req.userId)
    if (!review) return notFound(reply, 'review')
    return reply.send(review)
  })
}
