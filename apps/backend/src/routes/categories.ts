// §7 — Category CRUD routes.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import { notFound } from './helpers'
import type { CreateCategoryBody, RenameCategoryBody } from '@tracker/shared'

export async function categoryRoutes(app: FastifyInstance) {
  // GET /categories
  app.get('/categories', async (req, reply) => {
    const categories = await repos.findCategoriesByUser(pool, req.userId)
    return reply.send(categories)
  })

  // POST /categories
  app.post('/categories', async (req, reply) => {
    const body = req.body as CreateCategoryBody
    const userId = req.userId
    const category = await repos.insertCategory(pool, { userId, name: body.name })

    await repos.insertEvent(pool, {
      userId,
      eventType: 'category_created',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: { categoryId: category.id, name: category.name },
    })

    return reply.status(201).send(category)
  })

  // PATCH /categories/:id/rename
  app.patch('/categories/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as RenameCategoryBody

    const existing = await repos.findCategoryById(pool, id, userId)
    if (!existing || existing.archivedAt) return notFound(reply, 'category')

    const updated = await repos.renameCategory(pool, id, userId, body.name)
    if (!updated) return notFound(reply, 'category')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'category_renamed',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: { categoryId: id, previousName: existing.name, newName: body.name },
    })

    return reply.send(updated)
  })

  // DELETE /categories/:id
  app.delete('/categories/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const archived = await repos.archiveCategory(pool, id, userId)
    if (!archived) return notFound(reply, 'category')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'category_archived',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: { categoryId: id },
    })

    return reply.status(204).send()
  })
}
