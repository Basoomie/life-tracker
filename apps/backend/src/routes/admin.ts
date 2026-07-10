// §8.4 / v2 §9.3 — Admin / background-job routes.
// In v1 these are triggered manually; in production a cron job would call them.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { runBackgroundJob } from '../domain/materialization'
import { runScheduledReviews } from '../review/generate'
import type { RunBackgroundJobBody } from '@tracker/shared'

export async function adminRoutes(app: FastifyInstance) {
  // POST /admin/background-job — run topup + dispositions for a specific day
  app.post('/admin/background-job', async (req, reply) => {
    const body = req.body as RunBackgroundJobBody
    const userId = req.userId
    await runBackgroundJob(pool, userId, body.day)
    return reply.send({ ok: true, day: body.day })
  })

  // POST /admin/generate-reviews — v2 §9.3: scheduled review generation, keyed to the
  // logical day (already day-start-bucketed by the caller, same as background-job's
  // `day`). Deliberately a SEPARATE route from /admin/background-job rather than folded
  // into it: review generation calls the Anthropic API, and background-job's existing
  // test suite must never risk a live network call just because a test happened to run
  // on a day that is a period boundary. A production cron would call both endpoints on
  // its daily tick.
  app.post('/admin/generate-reviews', async (req, reply) => {
    const body = req.body as RunBackgroundJobBody
    const userId = req.userId
    const reviews = await runScheduledReviews(pool, userId, body.day)
    return reply.send({ ok: true, day: body.day, reviewIds: reviews.map((r) => r.id) })
  })
}
