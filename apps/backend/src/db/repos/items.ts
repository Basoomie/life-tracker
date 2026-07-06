import type { Pool } from 'pg'
import type {
  Item,
  ItemPrerequisite,
  CreationSource,
  DispositionPolicy,
  Priority,
  QuotaTarget,
  RecurrenceRule,
  TimingPrecision,
  Valence,
} from '@tracker/shared'

interface ItemRow {
  id: string
  user_id: string
  name: string
  description: string | null
  category_id: string | null
  valence: Valence | null
  priority: Priority | null
  recurrence_rule: RecurrenceRule | null
  quota_target: QuotaTarget | null
  timing_precision: TimingPrecision
  timing_bucket_id: string | null
  timing_start_time: string | null
  timing_end_time: string | null
  planned_duration_min: number | null
  parent_id: string | null
  disposition_policy: DispositionPolicy
  creation_source: CreationSource
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
    recurrenceRule: row.recurrence_rule,
    quotaTarget: row.quota_target,
    timingPrecision: row.timing_precision,
    timingBucketId: row.timing_bucket_id,
    timingStartTime: row.timing_start_time,
    timingEndTime: row.timing_end_time,
    plannedDurationMin: row.planned_duration_min,
    parentId: row.parent_id,
    dispositionPolicy: row.disposition_policy,
    creationSource: row.creation_source,
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
  recurrenceRule?: RecurrenceRule | null
  quotaTarget?: QuotaTarget | null
  timingPrecision?: TimingPrecision
  timingBucketId?: string | null
  timingStartTime?: string | null
  timingEndTime?: string | null
  plannedDurationMin?: number | null
  parentId?: string | null
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
       recurrence_rule, quota_target, timing_precision, timing_bucket_id,
       timing_start_time, timing_end_time, planned_duration_min,
       parent_id, disposition_policy, creation_source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      data.userId,
      data.name,
      data.description ?? null,
      data.categoryId ?? null,
      data.valence ?? null,
      data.priority ?? null,
      data.recurrenceRule ? JSON.stringify(data.recurrenceRule) : null,
      data.quotaTarget ? JSON.stringify(data.quotaTarget) : null,
      data.timingPrecision ?? 'none',
      data.timingBucketId ?? null,
      data.timingStartTime ?? null,
      data.timingEndTime ?? null,
      data.plannedDurationMin ?? null,
      data.parentId ?? null,
      data.dispositionPolicy ?? 'skip',
      data.creationSource ?? 'planned',
    ]
  )
  return toItem(rows[0])
}

// Active (non-archived) items for the user
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
  recurrenceRule: RecurrenceRule | null
  quotaTarget: QuotaTarget | null
  timingPrecision: TimingPrecision
  timingBucketId: string | null
  timingStartTime: string | null
  timingEndTime: string | null
  plannedDurationMin: number | null
  parentId: string | null
  dispositionPolicy: DispositionPolicy
}>

const COLUMN_MAP: Record<string, string> = {
  name:              'name',
  description:       'description',
  categoryId:        'category_id',
  valence:           'valence',
  priority:          'priority',
  recurrenceRule:    'recurrence_rule',
  quotaTarget:       'quota_target',
  timingPrecision:   'timing_precision',
  timingBucketId:    'timing_bucket_id',
  timingStartTime:   'timing_start_time',
  timingEndTime:     'timing_end_time',
  plannedDurationMin: 'planned_duration_min',
  parentId:          'parent_id',
  dispositionPolicy: 'disposition_policy',
}

// JSONB fields that need JSON.stringify when non-null
const JSON_FIELDS = new Set(['recurrenceRule', 'quotaTarget'])

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
