// §6.6 — Bucket CRUD routes.
//
// Boundaries are edited as **seams**, not as individual buckets. "Early Morning ends at
// 09:00" and "Morning starts at 09:00" are the same fact stored on two rows, so an
// endpoint that moved one row's boundary could only ever produce a gap or an overlap —
// the very thing the tiling rule rejects. PATCH /:id/seam moves both rows together.
//
// Tiling validation still runs as a backstop before the write, so a set that somehow
// reached an invalid state cannot be made worse through this route.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import {
  buildBucketCycle,
  validateSeamMove,
  applySeamMove,
  validateBucketTiling,
} from '../domain/buckets'
import { notFound, badRequest } from './helpers'
import { todayLocal } from '../domain/day'
import type { CreateBucketBody, MoveBucketSeamBody } from '@tracker/shared'

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

  // PATCH /buckets/:id/seam — §6.6: move the seam that *ends* bucket :id.
  // Both adjacent buckets move; returns the whole updated set.
  app.patch('/buckets/:id/seam', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as MoveBucketSeamBody

    const current = await repos.findBucketById(pool, id, userId)
    if (!current) return notFound(reply, 'bucket')

    const buckets = await repos.findBucketsByUser(pool, userId)

    // Effective day-start; fall back to '00:00' if not configured (§6.6)
    const dayStartEntry = await repos.findEffectiveDayStart(pool, userId, todayLocal())
    const dayStart = dayStartEntry?.value ?? '00:00'

    // The seam is only well-defined if the set forms a cycle at all.
    const cycleResult = buildBucketCycle(buckets, dayStart)
    if (!cycleResult.ok) return badRequest(reply, 'invalid_tiling', cycleResult.error)

    const seam = cycleResult.cycle.seams.find((s) => s.beforeBucketId === id)
    if (!seam) return notFound(reply, 'seam')

    const moveError = validateSeamMove(cycleResult.cycle, seam, body.time)
    if (moveError) return badRequest(reply, 'invalid_seam', moveError)

    // Backstop: the proposed set must still tile the day. validateSeamMove already
    // guarantees this for a valid cycle; the check costs nothing and means no write
    // here can ever be the thing that breaks the invariant.
    const proposed = applySeamMove(buckets, seam, body.time)
    const tilingError = validateBucketTiling(proposed, dayStart)
    if (tilingError) return badRequest(reply, 'invalid_tiling', tilingError)

    const updated = await repos.moveBucketSeam(
      pool,
      userId,
      seam.beforeBucketId,
      seam.afterBucketId,
      body.time
    )

    // One event for one user action, even though two rows changed (§6.6).
    await repos.insertEvent(pool, {
      userId,
      eventType: 'bucket_seam_moved',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: {
        beforeBucketId: seam.beforeBucketId,
        afterBucketId: seam.afterBucketId,
        previousTime: seam.time,
        newTime: body.time,
      },
    })

    return reply.send(updated)
  })
}
