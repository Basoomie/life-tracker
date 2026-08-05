// §3.1 / §5 — Item (template) CRUD routes.
// Routes are thin: all mutation logic lives in domain functions.

import type { FastifyInstance } from 'fastify'
import { pool } from '../db'
import * as repos from '../db/repos/index'
import {
  ensureOccurrenceMaterialized,
  regenerateFutureOccurrences,
  snapshotFromItem,
  topUpMaterializationForItem,
} from '../domain/materialization'
import { createItemWithSchedule, soleSchedule } from '../domain/items'
import { addPrerequisite, removePrerequisite } from '../domain/prerequisites'
import { notFound, badRequest } from './helpers'
import { logicalToday } from '../domain/day'
import type {
  CreateItemBody,
  UpdateItemBody,
  SetPriorityBody,
  AddPrerequisiteBody,
  ReorderChildrenBody,
  ReorderRootBody,
  ItemWithSchedules,
  ItemDetail,
} from '@tracker/shared'

// §5.5 — which keys of the flat item body belong to the item and which to its
// schedule. Listed explicitly (rather than "everything not in the other list") so
// that adding a field to either type is a deliberate choice, not an accident of
// whichever list happens to be the fallback.
const SCHEDULE_FIELDS = [
  'recurrenceRule',
  'anchorDay',
  'timingPrecision',
  'timingBucketId',
  'timingStartTime',
  'timingEndTime',
  'plannedDurationMin',
] as const satisfies readonly (keyof UpdateItemBody)[]

const ITEM_FIELDS = [
  'name',
  'description',
  'categoryId',
  'valence',
  'priority',
  'quotaTarget',
  'parentId',
  'dispositionPolicy',
] as const satisfies readonly (keyof UpdateItemBody)[]

export async function itemRoutes(app: FastifyInstance) {
  // GET /items — list all active items for the user, each with its schedules (§5.5).
  // Schedules travel with the item because without them a client cannot tell when the
  // item happens or whether it recurs.
  app.get('/items', async (req, reply) => {
    const userId = req.userId
    const [items, schedules] = await Promise.all([
      repos.findItemsByUser(pool, userId),
      repos.findSchedulesByUser(pool, userId),
    ])
    const byItem = new Map<string, typeof schedules>()
    for (const s of schedules) {
      const list = byItem.get(s.itemId)
      if (list) list.push(s)
      else byItem.set(s.itemId, [s])
    }
    const result: ItemWithSchedules[] = items.map((item) => ({
      ...item,
      schedules: byItem.get(item.id) ?? [],
    }))
    return reply.send(result)
  })

  // POST /items — create item + fire template_created + materialize if one-time
  app.post('/items', async (req, reply) => {
    const body = req.body as CreateItemBody
    const userId = req.userId

    // New children/root items append after existing siblings rather than
    // colliding at 0 (which would jump them to the front once manual order exists).
    const sortOrder = body.parentId
      ? await repos.nextChildSortOrder(pool, body.parentId, userId)
      : await repos.nextRootSortOrder(pool, userId)

    // §5.5 — the item and its first slot are created together.
    const { item, schedule } = await createItemWithSchedule(pool, {
      userId,
      name: body.name,
      description: body.description ?? null,
      categoryId: body.categoryId ?? null,
      valence: body.valence ?? null,
      priority: body.priority ?? null,
      quotaTarget: body.quotaTarget ?? null,
      parentId: body.parentId ?? null,
      sortOrder,
      // §8.1 default: recurring habits default to 'skip' (the spec's stated
      // default for "most habits"); one-time tasks (no recurrenceRule) default
      // to 'require_manual' instead — a missed one-off is far more often "I
      // haven't gotten to it yet" than "I'm choosing to skip it."
      dispositionPolicy: body.dispositionPolicy ?? (body.recurrenceRule ? 'skip' : 'require_manual'),
      creationSource: body.creationSource ?? 'planned',
      recurrenceRule: body.recurrenceRule ?? null,
      anchorDay: body.anchorDay ?? null,
      timingPrecision: body.timingPrecision ?? 'none',
      timingBucketId: body.timingBucketId ?? null,
      timingStartTime: body.timingStartTime ?? null,
      timingEndTime: body.timingEndTime ?? null,
      plannedDurationMin: body.plannedDurationMin ?? null,
    })

    // §10.2 — template_created event with full snapshot (no occurrence for template
    // events). The snapshot describes the item as created, i.e. with its first slot;
    // later slots record themselves via schedule_added (§5.5).
    const snapshot = snapshotFromItem(item, schedule, [])
    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_created',
      itemId: item.id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { creationSource: item.creationSource, snapshot },
    })

    // One-time tasks (no recurrenceRule) materialize their single occurrence immediately.
    // Recurring items top up their near-term horizon immediately too (mirrors the
    // regeneration that happens on template edit — §5.3), so today's occurrence
    // (if due) is stored right away instead of waiting for the nightly background job.
    if (!schedule.recurrenceRule) {
      const day = body.day ?? (await logicalToday(pool, userId))
      await ensureOccurrenceMaterialized(pool, item, schedule, day, userId)
    } else {
      await topUpMaterializationForItem(pool, item, userId, await logicalToday(pool, userId))
    }

    return reply.status(201).send(item)
  })

  // GET /items/:id — fetch item with children and prerequisites
  app.get('/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const item = await repos.findItemById(pool, id, userId)
    if (!item) return notFound(reply, 'item')

    const [children, prerequisites, schedules] = await Promise.all([
      repos.findChildItems(pool, id, userId),
      repos.findPrerequisitesByItem(pool, id, userId),
      repos.findSchedulesByItem(pool, id, userId),
    ])

    const detail: ItemDetail = { ...item, schedules, children, prerequisites }
    return reply.send(detail)
  })

  // PATCH /items/:id — template edit (forward-only per §5.3)
  app.patch('/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    // Pass through the keys Fastify actually received — updateItem/updateSchedule's
    // "if key in updates" guard correctly skips omitted fields. Spreading into a new
    // literal would insert undefined values for every absent key, causing them to be
    // NULLed out; the split below therefore copies keys only when present.
    const body = req.body as UpdateItemBody

    // §5.5 — this endpoint edits the item AND its single slot, which is what the
    // flat body has always meant. Items with several slots edit each one through
    // /items/:id/schedules/:scheduleId instead; soleSchedule throws rather than
    // guessing which slot a flat body was aimed at.
    const scheduleUpdates: import('../db/repos/item-schedules').UpdateScheduleData = {}
    for (const key of SCHEDULE_FIELDS) {
      if (key in body) (scheduleUpdates as Record<string, unknown>)[key] = body[key]
    }
    const itemUpdates: import('../db/repos/items').UpdateItemData = {}
    for (const key of ITEM_FIELDS) {
      if (key in body) (itemUpdates as Record<string, unknown>)[key] = body[key]
    }

    const updated = await repos.updateItem(pool, id, userId, itemUpdates)
    if (!updated) return notFound(reply, 'item')

    let scheduleId: string | undefined
    if (Object.keys(scheduleUpdates).length > 0) {
      const schedule = await soleSchedule(pool, id, userId)
      await repos.updateSchedule(pool, schedule.id, userId, scheduleUpdates)
      scheduleId = schedule.id
    }

    // §10.2 — template_edited event records what changed
    await repos.insertEvent(pool, {
      userId,
      eventType: 'template_edited',
      itemId: id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { changes: body },
    })

    // §5.3 — regenerate untouched future occurrences with the new snapshot.
    // An item-level change (name, category…) alters every slot's snapshot, so the
    // regeneration is unscoped unless the edit touched only the schedule.
    const onlyScheduleChanged =
      scheduleId !== undefined && Object.keys(itemUpdates).length === 0
    await regenerateFutureOccurrences(
      pool, updated, userId, await logicalToday(pool, userId),
      onlyScheduleChanged ? scheduleId : undefined
    )

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

  // PATCH /items/:id/reorder-children — manual drag-and-drop child order.
  // Body must contain exactly the current children's ids (no missing/extra/
  // duplicate) — this endpoint applies an order, it doesn't add/remove edges.
  app.patch('/items/:id/reorder-children', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as ReorderChildrenBody

    const current = await repos.findChildItems(pool, id, userId)
    const currentIds = current.map((c) => c.id)
    const requestedIds = body.childItemIds

    const currentSet = new Set(currentIds)
    const requestedSet = new Set(requestedIds)
    const sameSet =
      requestedIds.length === currentIds.length &&
      requestedSet.size === requestedIds.length &&
      requestedIds.every((cid) => currentSet.has(cid))

    if (!sameSet) {
      return badRequest(reply, 'reorder_mismatch', 'childItemIds must be exactly the current children, no missing/extra/duplicate ids')
    }

    const updated = await repos.reorderChildren(pool, id, userId, requestedIds)

    await repos.insertEvent(pool, {
      userId,
      eventType: 'children_reordered',
      itemId: id,
      occurrenceId: null,
      appliesToDay: null,
      payload: { parentId: id, previousOrder: currentIds, newOrder: requestedIds },
    })

    return reply.send(updated)
  })

  // PATCH /items/:id/reorder-root — manual drag-and-drop order for top-level
  // (parentless) items, e.g. dragging an unscheduled item to a new position.
  // Unlike reorder-children, the caller supplies only where the item should
  // land (afterItemId) rather than the full sibling set — unscheduled items
  // are routinely shown through a filtered/tiered subset across Now/List/
  // Calendar, so the client can't be trusted to know the complete root order.
  app.patch('/items/:id/reorder-root', async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.userId
    const body = req.body as ReorderRootBody

    const item = await repos.findItemById(pool, id, userId)
    if (!item) return notFound(reply, 'item')
    if (item.parentId !== null) {
      return badRequest(reply, 'not_root_item', 'reorder-root only applies to top-level items; use reorder-children for a child')
    }

    if (body.afterItemId !== null) {
      if (body.afterItemId === id) {
        return badRequest(reply, 'reorder_self', 'afterItemId cannot be the item being moved')
      }
      const afterItem = await repos.findItemById(pool, body.afterItemId, userId)
      if (!afterItem || afterItem.parentId !== null) {
        return badRequest(reply, 'reorder_invalid_neighbor', 'afterItemId must be an existing top-level item')
      }
    }

    const previousOrder = (await repos.findRootItems(pool, userId)).map((i) => i.id)
    const updated = await repos.reorderRootItem(pool, userId, id, body.afterItemId)

    await repos.insertEvent(pool, {
      userId,
      eventType: 'root_items_reordered',
      itemId: id,
      occurrenceId: null,
      appliesToDay: null,
      payload: {
        itemId: id,
        afterItemId: body.afterItemId,
        previousOrder,
        newOrder: updated.map((i) => i.id),
      },
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
