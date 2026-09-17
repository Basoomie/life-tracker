// §6.7 — Day-start timeline routes.
// Changes are forward-only: effectiveFrom must be >= today.
//
// A day-start change also carries the bucket set's edge with it (§6.6/§6.7 re-anchoring):
// the day-start defines the window, the buckets partition it, so moving the window's
// edge without moving the buckets' edge leaves an hour of the day in no bucket at all.
// Only the two edge buckets move — every interior seam stays where the user put it —
// and the move is written as its own event.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { badRequest } from './helpers'
import { todayLocal } from '../domain/day'
import { planDayStartReanchor } from '../domain/buckets'
import type { CreateDayStartBody, CreateDayStartResponse } from '@tracker/shared'

export async function dayStartRoutes(app: FastifyInstance) {
  // GET /day-start — full timeline in ascending order
  app.get('/day-start', async (req, reply) => {
    const timeline = await repos.findDayStartTimeline(pool, req.userId)
    return reply.send(timeline)
  })

  // POST /day-start — append new entry (forward-only per §6.7), re-anchoring buckets
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

    // Plan the bucket move before writing anything: a day-start that would land inside a
    // non-edge bucket is refused outright rather than accepted into an inconsistent state.
    const buckets = await repos.findBucketsByUser(pool, userId)
    const plan = planDayStartReanchor(buckets, previousValue ?? '00:00', body.value)
    if (plan.status === 'blocked') {
      return badRequest(reply, 'day_start_splits_bucket', plan.error!)
    }

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

    // Known v1 seam: the day-start timeline is dated, bucket boundaries are not. A
    // future-dated change therefore re-anchors the buckets *now*, not on effectiveFrom.
    // Accepted deliberately rather than versioning buckets by date; the settings UI says
    // so before the user submits.
    let resultBuckets = buckets
    if (plan.status === 'moved') {
      const firstBucketId = plan.firstBucketId!   // now starts at the new day-start
      const lastBucketId = plan.lastBucketId!     // now ends at it

      resultBuckets = await repos.moveBucketSeam(
        pool,
        userId,
        lastBucketId,
        firstBucketId,
        body.value
      )

      await repos.insertEvent(pool, {
        userId,
        eventType: 'buckets_reanchored',
        occurrenceId: null,
        itemId: null,
        appliesToDay: null,
        payload: {
          previousDayStart: previousValue,
          newDayStart: body.value,
          previousSeamTime: plan.previousSeamTime!,
          firstBucketId,
          lastBucketId,
        },
      })
    }

    const response: CreateDayStartResponse = {
      entry,
      buckets: resultBuckets,
      reanchor: { status: plan.status, changed: plan.changed },
    }
    return reply.status(201).send(response)
  })
}
