import type { FastifyInstance } from 'fastify'
import type { HealthResponse } from '@tracker/shared'
import { pool } from '../db'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1')
      const body: HealthResponse = { status: 'ok', postgres: 'connected' }
      return reply.send(body)
    } catch (err) {
      app.log.error({ err }, 'Database health check failed')
      const body: HealthResponse = { status: 'error', postgres: 'disconnected' }
      return reply.status(503).send(body)
    }
  })
}
