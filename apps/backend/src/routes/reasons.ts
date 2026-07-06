// §8.3 — Reason CRUD routes (identical structure to categories).

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { notFound } from './helpers'
import type { CreateReasonBody, RenameReasonBody } from '@tracker/shared'

export async function reasonRoutes(app: FastifyInstance) {
  // GET /reasons
  app.get('/reasons', async (req, reply) => {
    const reasons = await repos.findReasonsByUser(pool, req.userId)
    return reply.send(reasons)
  })

  // POST /reasons
  app.post('/reasons', async (req, reply) => {
    const body = req.body as CreateReasonBody
    const userId = req.userId
    const reason = await repos.insertReason(pool, { userId, name: body.name })

    await repos.insertEvent(pool, {
      userId,
      eventType: 'reason_created',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: { reasonId: reason.id, name: reason.name },
    })

    return reply.status(201).send(reason)
  })

  // PATCH /reasons/:id/rename
  app.patch('/reasons/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as RenameReasonBody

    const existing = await repos.findReasonById(pool, id, userId)
    if (!existing || existing.archivedAt) return notFound(reply, 'reason')

    const updated = await repos.renameReason(pool, id, userId, body.name)
    if (!updated) return notFound(reply, 'reason')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'reason_renamed',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: { reasonId: id, previousName: existing.name, newName: body.name },
    })

    return reply.send(updated)
  })

  // DELETE /reasons/:id
  app.delete('/reasons/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const archived = await repos.archiveReason(pool, id, userId)
    if (!archived) return notFound(reply, 'reason')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'reason_archived',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: { reasonId: id },
    })

    return reply.status(204).send()
  })
}
