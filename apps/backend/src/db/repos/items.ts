import type { Pool } from 'pg'
import type {
  Item,
  ItemPrerequisite,
  CreationSource,
  DispositionPolicy,
  Priority,
  QuotaTarget,
  Valence,
} from '@tracker/shared'

// §5.5 — recurrence rule, anchor day, timing and planned duration moved to
// item_schedules (migration 0014).  They are deliberately absent here: a second copy
// on `items` would be a second source of truth for the item's timing.
interface ItemRow {
  id: string
  user_id: string
  name: string
  description: string | null
  category_id: string | null
  valence: Valence | null
  priority: Priority | null
  quota_target: QuotaTarget | null
  parent_id: string | null
  sort_order: number
  disposition_policy: DispositionPolicy
  creation_source: CreationSource
  deactivated_at: Date | null
  archived_at: Date | null
  created_at: Date
}

interface PrerequisiteRow {
  item_id: string
  prerequisite_id: string
  user_id: string
  created_at: Date
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    valence: row.valence,
    priority: row.priority,
    quotaTarget: row.quota_target,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    dispositionPolicy: row.disposition_policy,
    creationSource: row.creation_source,
    deactivatedAt: row.deactivated_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  }
}

function toItemPrerequisite(row: PrerequisiteRow): ItemPrerequisite {
  return {
    itemId: row.item_id,
    prerequisiteId: row.prerequisite_id,
    userId: row.user_id,
    createdAt: row.created_at,
  }
}

export type InsertItemData = {
  userId: string
  name: string
  description?: string | null
  categoryId?: string | null
  valence?: Valence | null
  priority?: Priority | null
  quotaTarget?: QuotaTarget | null
  parentId?: string | null
  sortOrder?: number
  dispositionPolicy?: DispositionPolicy
  creationSource?: CreationSource
}

export async function insertItem(
  pool: Pool,
  data: InsertItemData
): Promise<Item> {
  const { rows } = await pool.query<ItemRow>(
    `INSERT INTO items (
       user_id, name, description, category_id, valence, priority,
       quota_target, parent_id, sort_order, disposition_policy, creation_source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.userId,
      data.name,
      data.description ?? null,
      data.categoryId ?? null,
      data.valence ?? null,
      data.priority ?? null,
      data.quotaTarget ? JSON.stringify(data.quotaTarget) : null,
      data.parentId ?? null,
      data.sortOrder ?? 0,
      data.dispositionPolicy ?? 'skip',
      data.creationSource ?? 'planned',
    ]
  )
  return toItem(rows[0])
}

// Every item the user has not deleted — INCLUDING inactive ones (§5.6).
//
// This is the right list for anything that reads history: an item paused last week
// still has months of real occurrences behind it, and dropping it here would make it
// vanish from its own statistics.  Scheduling paths want findActiveItemsByUser instead.
export async function findItemsByUser(
  pool: Pool,
  userId: string
): Promise<Item[]> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at`,
    [userId]
  )
  return rows.map(toItem)
}

// §5.6 — Items that are neither deleted nor paused: the ones that are actually
// scheduled right now.  Every materialization and due-day path uses this, so a
// deactivated item stops producing occurrences without any caller having to remember.
export async function findActiveItemsByUser(
  pool: Pool,
  userId: string
): Promise<Item[]> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items
     WHERE user_id = $1 AND archived_at IS NULL AND deactivated_at IS NULL
     ORDER BY created_at`,
    [userId]
  )
  return rows.map(toItem)
}

// §5.6 — The paused items, most recently paused first: what the user browses when
// looking for something to switch back on.
export async function findInactiveItemsByUser(
  pool: Pool,
  userId: string
): Promise<Item[]> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items
     WHERE user_id = $1 AND archived_at IS NULL AND deactivated_at IS NOT NULL
     ORDER BY deactivated_at DESC`,
    [userId]
  )
  return rows.map(toItem)
}

// Includes archived; needed to resolve historical events that reference deleted items
export async function findItemById(
  pool: Pool,
  id: string,
  userId: string
): Promise<Item | null> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toItem(rows[0]) : null
}

// §5.6 — Pause an item.  Guarded on deactivated_at IS NULL so a repeat call is a
// no-op returning null rather than silently moving the timestamp: the caller uses
// that to decide whether an event should be logged at all.
export async function deactivateItem(
  pool: Pool,
  id: string,
  userId: string
): Promise<Item | null> {
  const { rows } = await pool.query<ItemRow>(
    `UPDATE items SET deactivated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deactivated_at IS NULL AND archived_at IS NULL
     RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toItem(rows[0]) : null
}

// §5.6 — Switch an item back on.  Mirror of deactivateItem, including the no-op guard.
export async function reactivateItem(
  pool: Pool,
  id: string,
  userId: string
): Promise<Item | null> {
  const { rows } = await pool.query<ItemRow>(
    `UPDATE items SET deactivated_at = NULL
     WHERE id = $1 AND user_id = $2 AND deactivated_at IS NOT NULL AND archived_at IS NULL
     RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toItem(rows[0]) : null
}

export async function archiveItem(
  pool: Pool,
  id: string,
  userId: string
): Promise<Item | null> {
  const { rows } = await pool.query<ItemRow>(
    `UPDATE items SET archived_at = NOW()
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
     RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toItem(rows[0]) : null
}

export async function findPrerequisitesByItem(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<ItemPrerequisite[]> {
  const { rows } = await pool.query<PrerequisiteRow>(
    `SELECT * FROM item_prerequisites WHERE item_id = $1 AND user_id = $2`,
    [itemId, userId]
  )
  return rows.map(toItemPrerequisite)
}

export async function insertPrerequisite(
  pool: Pool,
  itemId: string,
  prerequisiteId: string,
  userId: string
): Promise<ItemPrerequisite> {
  const { rows } = await pool.query<PrerequisiteRow>(
    `INSERT INTO item_prerequisites (item_id, prerequisite_id, user_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [itemId, prerequisiteId, userId]
  )
  return toItemPrerequisite(rows[0])
}

// Fields that can be changed by a template edit.  All are optional — only the
// provided keys are updated; the rest are left as-is.
export type UpdateItemData = Partial<{
  name: string
  description: string | null
  categoryId: string | null
  valence: Valence | null
  priority: Priority | null
  quotaTarget: QuotaTarget | null
  parentId: string | null
  dispositionPolicy: DispositionPolicy
}>

const COLUMN_MAP: Record<string, string> = {
  name:              'name',
  description:       'description',
  categoryId:        'category_id',
  valence:           'valence',
  priority:          'priority',
  quotaTarget:       'quota_target',
  parentId:          'parent_id',
  dispositionPolicy: 'disposition_policy',
}

// JSONB fields that need JSON.stringify when non-null
const JSON_FIELDS = new Set(['quotaTarget'])

// §5.3 — Apply a partial update to an item template (forward-only; regenerating
// affected future occurrences is the caller's responsibility).
export async function updateItem(
  pool: Pool,
  id: string,
  userId: string,
  updates: UpdateItemData
): Promise<Item | null> {
  const setClauses: string[] = []
  const values: any[] = []  // pg.query accepts any[]
  let idx = 1

  for (const [key, col] of Object.entries(COLUMN_MAP)) {
    if (!(key in updates)) continue
    const raw = updates[key as keyof UpdateItemData]
    setClauses.push(`${col} = $${idx++}`)
    if (JSON_FIELDS.has(key) && raw !== null && raw !== undefined) {
      values.push(JSON.stringify(raw))
    } else {
      values.push(raw ?? null)
    }
  }

  if (setClauses.length === 0) {
    // Nothing to update; return the current row
    return findItemById(pool, id, userId)
  }

  values.push(id, userId)
  const { rows } = await pool.query<ItemRow>(
    `UPDATE items SET ${setClauses.join(', ')}
     WHERE id = $${idx++} AND user_id = $${idx++}
     RETURNING *`,
    values
  )
  return rows[0] ? toItem(rows[0]) : null
}

// §4.1 — Direct children in the containment tree (items where parent_id = parentId).
// sort_order first (manual drag-and-drop order); created_at as a stable tiebreak
// for items that tie at the default 0 (i.e. nobody has reordered them yet).
export async function findChildItems(
  pool: Pool,
  parentId: string,
  userId: string
): Promise<Item[]> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items
     WHERE parent_id = $1 AND user_id = $2 AND archived_at IS NULL
     ORDER BY sort_order, created_at`,
    [parentId, userId]
  )
  return rows.map(toItem)
}

// Where a newly created child should land by default: after all existing
// siblings, not colliding at 0 with them.
export async function nextChildSortOrder(
  pool: Pool,
  parentId: string,
  userId: string
): Promise<number> {
  const { rows } = await pool.query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM items
     WHERE parent_id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [parentId, userId]
  )
  return rows[0].next
}

// Top-level items (no parent) — sort_order first (manual drag-and-drop
// order), created_at as a stable tiebreak, same pattern as findChildItems
// but scoped to parent_id IS NULL.
export async function findRootItems(
  pool: Pool,
  userId: string
): Promise<Item[]> {
  const { rows } = await pool.query<ItemRow>(
    `SELECT * FROM items
     WHERE parent_id IS NULL AND user_id = $1 AND archived_at IS NULL
     ORDER BY sort_order, created_at`,
    [userId]
  )
  return rows.map(toItem)
}

// Where a newly created root item should land by default: after all
// existing root items, not colliding at 0 with them — same reasoning as
// nextChildSortOrder (once someone has manually reordered, a fresh 0 would
// jump the new item to the front instead of appending it).
export async function nextRootSortOrder(
  pool: Pool,
  userId: string
): Promise<number> {
  const { rows } = await pool.query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM items
     WHERE parent_id IS NULL AND user_id = $1 AND archived_at IS NULL`,
    [userId]
  )
  return rows[0].next
}

// This item's live position among its siblings and its live containment edge
// (§4.1), for enrichOccurrence. Both are properties of the item as it stands
// now, NOT of the occurrence's frozen snapshot — an occurrence materialized
// before a reparent still carries the old parentId in its snapshot, and a
// client that trusts that will disagree with the reorder endpoints, which read
// items.parent_id. The parent's name is joined in the same round trip so a
// detached child (§4.1 — parent not due today) can name its parent without the
// caller holding every item.
export type ItemOrderContext = {
  sortOrder: number
  parentItemId: string | null
  parentName: string | null
}

export async function findItemOrderContext(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<ItemOrderContext> {
  const { rows } = await pool.query<{
    sort_order: number
    parent_id: string | null
    parent_name: string | null
  }>(
    `SELECT i.sort_order, i.parent_id, p.name AS parent_name
       FROM items i
       LEFT JOIN items p ON p.id = i.parent_id AND p.user_id = i.user_id
      WHERE i.id = $1 AND i.user_id = $2`,
    [itemId, userId]
  )
  const row = rows[0]
  return {
    sortOrder: row?.sort_order ?? 0,
    parentItemId: row?.parent_id ?? null,
    parentName: row?.parent_name ?? null,
  }
}

// Manual drag-and-drop reorder. Caller (route) is responsible for validating
// orderedChildItemIds is exactly the current children's id set — this just
// applies the requested order. Sequential statements, no explicit
// transaction: matches this codebase's existing style (no other domain
// function wraps multi-statement writes in BEGIN/COMMIT either), and a
// sibling list is small.
export async function reorderChildren(
  pool: Pool,
  parentId: string,
  userId: string,
  orderedChildItemIds: string[]
): Promise<Item[]> {
  for (let i = 0; i < orderedChildItemIds.length; i++) {
    await pool.query(
      `UPDATE items SET sort_order = $1 WHERE id = $2 AND parent_id = $3 AND user_id = $4`,
      [i, orderedChildItemIds[i], parentId, userId]
    )
  }
  return findChildItems(pool, parentId, userId)
}

// Manual drag-and-drop reorder for a single top-level item, spliced into
// position among ALL root items — not just whatever subset the caller could
// see. Unlike reorderChildren (which trusts the caller's full posted order
// because a card's children list is never filtered), unscheduled root items
// are routinely shown through a filtered/tiered subset, so the caller can
// only ever say "put this one after that one." The full root order is
// recomputed here and densely renumbered 0..n-1, same scheme as
// reorderChildren, just derived instead of posted. Caller (route) validates
// itemId/afterItemId are both real root items belonging to this user.
export async function reorderRootItem(
  pool: Pool,
  userId: string,
  itemId: string,
  afterItemId: string | null
): Promise<Item[]> {
  const current = await findRootItems(pool, userId)
  const moved = current.find((i) => i.id === itemId)
  if (!moved) return current

  const withoutMoved = current.filter((i) => i.id !== itemId)
  const insertAt = afterItemId === null
    ? 0
    : withoutMoved.findIndex((i) => i.id === afterItemId) + 1
  withoutMoved.splice(insertAt, 0, moved)

  for (let i = 0; i < withoutMoved.length; i++) {
    await pool.query(
      `UPDATE items SET sort_order = $1 WHERE id = $2 AND parent_id IS NULL AND user_id = $3`,
      [i, withoutMoved[i].id, userId]
    )
  }
  return findRootItems(pool, userId)
}

export async function deletePrerequisite(
  pool: Pool,
  itemId: string,
  prerequisiteId: string,
  userId: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM item_prerequisites
     WHERE item_id = $1 AND prerequisite_id = $2 AND user_id = $3`,
    [itemId, prerequisiteId, userId]
  )
  return (rowCount ?? 0) > 0
}
