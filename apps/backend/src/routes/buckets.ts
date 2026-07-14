// §6.6 — Bucket CRUD routes.
// Tiling validation only on PATCH /boundaries (not on POST) so users can build
// the bucket set incrementally.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { validateBucketTiling } from '../domain/buckets'
import { notFound, badRequest, todayLocal } from './helpers'
import type { CreateBucketBody, UpdateBucketBoundariesBody } from '@tracker/shared'

export async function bucketRoutes(app: FastifyInstance) {
  // GET /buckets
  app.get('/buckets', async (req, reply) => {
    const buckets = await repos.findBucketsByUser(pool, req.userId)
    return reply.send(buckets)
  })

  // POST /buckets — create (no tiling validation; user builds set incrementally)
  app.post('/buckets', async (req, reply) => {
    const body = req.body as CreateBucketBody
    const userId = req.userId
    const bucket = await repos.insertBucket(pool, {
      userId,
      name: body.name,
      startTime: body.startTime,
      endTime: body.endTime,
      sortOrder: body.sortOrder ?? 0,
    })
    return reply.status(201).send(bucket)
  })

  // PATCH /buckets/:id/boundaries — §6.6: validate tiling before accepting
  app.patch('/buckets/:id/boundaries', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as UpdateBucketBoundariesBody

    const current = await repos.findBucketById(pool, id, userId)
    if (!current) return notFound(reply, 'bucket')

    // Build the proposed full set: replace the current bucket with proposed values
    const allBuckets = await repos.findBucketsByUser(pool, userId)
    const proposedBuckets = allBuckets.map((b) =>
      b.id === id ? { ...b, startTime: body.startTime, endTime: body.endTime } : b
    )

    // Get effective day-start; fall back to '00:00' if not configured (§6.6)
    const dayStartEntry = await repos.findEffectiveDayStart(pool, userId, todayLocal())
    const dayStart = dayStartEntry?.value ?? '00:00'

    const tilingError = validateBucketTiling(proposedBuckets, dayStart)
    if (tilingError) {
      return badRequest(reply, 'invalid_tiling', tilingError)
    }

    const updated = await repos.updateBucketBoundaries(pool, id, userId, body.startTime, body.endTime)
    if (!updated) return notFound(reply, 'bucket')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'bucket_boundaries_changed',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: {
        bucketId: id,
        previousStartTime: current.startTime,
        previousEndTime: current.endTime,
        newStartTime: body.startTime,
        newEndTime: body.endTime,
      },
    })

    return reply.send(updated)
  })
}
