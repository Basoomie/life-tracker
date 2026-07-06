// §3.1 / §5 — Item (template) CRUD routes.
// Routes are thin: all mutation logic lives in domain functions.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import {
  ensureOccurrenceMaterialized,
  regenerateFutureOccurrences,
} from '../domain/materialization'
import { addPrerequisite, removePrerequisite } from '../domain/prerequisites'
import { notFound, badRequest, todayUTC } from './helpers'
import type {
  CreateItemBody,
  UpdateItemBody,
  SetPriorityBody,
  AddPrerequisiteBody,
  ItemSnapshot,
} from '@tracker/shared'

// Build the item snapshot inline (same fields as snapshotFromItem in materialization.ts).
// Used for template_created and template_edited events.
function buildSnapshot(item: {
  name: string
  description: string | null
  categoryId: string | null
  valence: import('@tracker/shared').Valence | null
  priority: import('@tracker/shared').Priority | null
  recurrenceRule: import('@tracker/shared').RecurrenceRule | null
  quotaTarget: import('@tracker/shared').QuotaTarget | null
  timingPrecision: import('@tracker/shared').TimingPrecision
  timingBucketId: string | null
  timingStartTime: string | null
  timingEndTime: string | null
  plannedDurationMin: number | null
  dispositionPolicy: import('@tracker/shared').DispositionPolicy
  parentId: string | null
}, prerequisiteIds: string[]): ItemSnapshot {
  return {
    name: item.name,
    description: item.description,
    categoryId: item.categoryId,
    valence: item.valence,
    priority: item.priority,
    recurrenceRule: item.recurrenceRule,
    quotaTarget: item.quotaTarget,
    timingPrecision: item.timingPrecision,
    timingBucketId: item.timingBucketId,
    timingStartTime: item.timingStartTime,
    timingEndTime: item.timingEndTime,
    plannedDurationMin: item.plannedDurationMin,
    dispositionPolicy: item.dispositionPolicy,
    parentId: item.parentId,
    prerequisiteIds,
  }
}

export async function itemRoutes(app: FastifyInstance) {
  // GET /items — list all active items for the user
  app.get('/items', async (req, reply) => {
    const items = await repos.findItemsByUser(pool, req.userId)
    return reply.send(items)
  })

  // POST /items — create item + fire template_created + materialize if one-time
  app.post('/items', async (req, reply) => {
    const body = req.body as CreateItemBody
    const userId = req.userId

    const item = await repos.insertItem(pool, {
      userId,
      name: body.name,
      description: body.description ?? null,
      categoryId: body.categoryId ?? null,
      valence: body.valence ?? null,
      priority: body.priority ?? null,
      recurrenceRule: body.recurrenceRule ?? null,
      quotaTarget: body.quotaTarget ?? null,
      timingPrecision: body.timingPrecision ?? 'none',
      timingBucketId: body.timingBucketId ?? null,
      timingStartTime: body.timingStartTime ?? null,
      timingEndTime: body.timingEndTime ?? null,
      plannedDurationMin: body.plannedDurationMin ?? null,
      parentId: body.parentId ?? null,
      dispositionPolicy: body.dispositionPolicy ?? 'skip',
      creationSource: body.creationSource ?? 'planned',
    })

    // §10.2 — template_created event with full snapshot (no occurrence for template events)
    const snapshot = buildSnapshot(item, [])
    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_created',
      itemId: item.id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { creationSource: item.creationSource, snapshot },
    })

    // One-time tasks (no recurrenceRule) materialize their single occurrence immediately.
    if (!item.recurrenceRule) {
      const day = body.day ?? todayUTC()
      await ensureOccurrenceMaterialized(pool, item, day, userId)
    }

    return reply.status(201).send(item)
  })

  // GET /items/:id — fetch item with children and prerequisites
  app.get('/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const item = await repos.findItemById(pool, id, userId)
    if (!item) return notFound(reply, 'item')

    const [children, prerequisites] = await Promise.all([
      repos.findChildItems(pool, id, userId),
      repos.findPrerequisitesByItem(pool, id, userId),
    ])

    return reply.send({ ...item, children, prerequisites })
  })

  // PATCH /items/:id — template edit (forward-only per §5.3)
  app.patch('/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    // Pass the body directly — Fastify only includes keys present in the JSON, so
    // updateItem's "if key in updates" guard correctly skips omitted fields.
    // Spreading into a new literal would insert undefined values for every absent key,
    // causing updateItem to NULL them out.
    const body = req.body as UpdateItemBody

    const updated = await repos.updateItem(pool, id, userId, body as import('../db/repos/items').UpdateItemData)

    if (!updated) return notFound(reply, 'item')

    // §10.2 — template_edited event records what changed
    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_edited',
      itemId: id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { changes: body },
    })

    // §5.3 — regenerate untouched future occurrences with the new snapshot
    await regenerateFutureOccurrences(pool, updated, userId, todayUTC())

    return reply.send(updated)
  })

  // DELETE /items/:id — soft-delete (archive) + event
  app.delete('/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const item = await repos.archiveItem(pool, id, userId)
    if (!item) return notFound(reply, 'item')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_soft_deleted',
      itemId: id,
      occurrenceId: null,
      appliesToDay: null,
      payload: {},
    })

    return reply.status(204).send()
  })

  // PATCH /items/:id/priority — §7.1
  app.patch('/items/:id/priority', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as SetPriorityBody

    const current = await repos.findItemById(pool, id, userId)
    if (!current) return notFound(reply, 'item')

    const previousPriority = current.priority
    const updated = await repos.updateItem(pool, id, userId, { priority: body.priority })
    if (!updated) return notFound(reply, 'item')

    await repos.insertEvent(pool, {
      userId,
      eventType: 'priority_changed',
      itemId: id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { previousPriority, newPriority: body.priority },
    })

    return reply.send(updated)
  })

  // POST /items/:id/prerequisites — §4.2
  app.post('/items/:id/prerequisites', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as AddPrerequisiteBody

    const [item, prereqItem] = await Promise.all([
      repos.findItemById(pool, id, userId),
      repos.findItemById(pool, body.prerequisiteItemId, userId),
    ])

    if (!item) return notFound(reply, 'item')
    if (!prereqItem) return notFound(reply, 'prerequisite item')

    const result = await addPrerequisite(pool, item, prereqItem, userId)
    if (!result.ok) {
      // Classify the error so tests can assert on the code
      const isHabitError = result.error.includes('recurring habit')
      const errorCode = isHabitError ? 'habit_as_prerequisite' : 'cycle_rejected'
      return badRequest(reply, errorCode, result.error)
    }

    return reply.status(201).send(result.edge)
  })

  // DELETE /items/:id/prerequisites/:prereqId — §4.2
  app.delete('/items/:id/prerequisites/:prereqId', async (req, reply) => {
    const { id, prereqId } = req.params as { id: string; prereqId: string }
    const userId = req.userId
    const event = await removePrerequisite(pool, id, prereqId, userId)
    if (!event) return notFound(reply, 'prerequisite')
    return reply.status(204).send()
  })
}
