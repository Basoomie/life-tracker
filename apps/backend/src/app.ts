import Fastify from 'fastify'
import cors from '@fastify/cors'
import { healthRoutes } from './routes/health'

export async function buildApp() {
  const app = Fastify({ logger: { level: 'info' } })

  // CORS permissive in development so the Vite dev server can reach the API
  if (process.env.NODE_ENV !== 'production') {
    await app.register(cors, { origin: true })
  }

  await app.register(healthRoutes)

  // In production the built frontend is served as static files
  if (process.env.NODE_ENV === 'production') {
    const { default: staticFiles } = await import('@fastify/static')
    const { join } = await import('path')
    // __dirname = apps/backend/src → go up 3 levels to project root, then apps/frontend/dist
    await app.register(staticFiles, {
      root: join(__dirname, '../../../apps/frontend/dist'),
      prefix: '/',
      wildcard: false,
    })
    // Catch-all: serve index.html for SPA client-side routing
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html')
    })
  }

  return app
}
