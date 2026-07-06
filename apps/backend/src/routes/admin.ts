// §8.4 — Admin / background-job routes.
// In v1 these are triggered manually; in production a cron job would call them.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { runBackgroundJob } from '../domain/materialization'
import type { RunBackgroundJobBody } from '@tracker/shared'

export async function adminRoutes(app: FastifyInstance) {
  // POST /admin/background-job — run topup + dispositions for a specific day
  app.post('/admin/background-job', async (req, reply) => {
    const body = req.body as RunBackgroundJobBody
    const userId = req.userId
    await runBackgroundJob(pool, userId, body.day)
    return reply.send({ ok: true, day: body.day })
  })
}
