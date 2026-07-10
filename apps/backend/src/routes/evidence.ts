// v2 §9.4.1 / §9.4.1 "Approval UI (minimal)" — the human approve/reject surface.
// Thin routes: all logic in evidence/pipeline.ts. user_id-scoped via the existing
// preHandler choke point (§13.4). No route accepts a candidate to propose — that
// entry point (proposeEvidenceEntry) is driven by a script/fixture in step 3a;
// wiring it to a real LLM caller is step 3b's concern.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { notFound, badRequest } from './helpers'
import { approveEvidenceEntry, rejectEvidenceEntry } from '../evidence/pipeline'
import type { ApproveEvidenceBody } from '@tracker/shared'

export async function evidenceRoutes(app: FastifyInstance) {
  // GET /evidence/pending-approval — verified, not-yet-approved, not archived.
  app.get('/evidence/pending-approval', async (req, reply) => {
    const entries = await repos.findPendingApproval(pool, req.userId)
    return reply.send(entries)
  })

  // POST /evidence/:id/approve
  // abstractVisible is diagnostic only (§9.4.1 follow-up) — omitting it is fine,
  // approval is never blocked or altered by its value. See evidence/pipeline.ts.
  app.post('/evidence/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as Partial<ApproveEvidenceBody>
    try {
      const updated = await approveEvidenceEntry(pool, req.userId, id, body.abstractVisible === true)
      return reply.send(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found')) return notFound(reply, 'evidence entry')
      return badRequest(reply, 'not_verified', message)
    }
  })

  // POST /evidence/:id/reject
  app.post('/evidence/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const updated = await rejectEvidenceEntry(pool, req.userId, id)
      return reply.send(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found')) return notFound(reply, 'evidence entry')
      return badRequest(reply, 'not_verified', message)
    }
  })
}
