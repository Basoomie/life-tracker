// User preference routes — GET /preferences (all), PUT /preferences/:key (upsert one).

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { getAllUserPreferences, setUserPreference } from '../db/repos/preferences'
import { badRequest } from './helpers'

export async function preferencesRoutes(app: FastifyInstance) {
  app.get('/preferences', async (req, reply) => {
    const prefs = await getAllUserPreferences(pool, req.userId)
    return reply.send(prefs)
  })

  app.put('/preferences/:key', async (req, reply) => {
    const { key } = req.params as { key: string }
    const body = req.body as { value?: unknown }
    if (typeof body?.value !== 'string') {
      return badRequest(reply, 'invalid_value', 'body.value must be a string')
    }
    await setUserPreference(pool, req.userId, key, body.value)
    return reply.send({ ok: true })
  })
}
