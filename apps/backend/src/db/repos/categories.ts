import type { Pool } from 'pg'
import type { Category } from '@tracker/shared'

interface CategoryRow {
  id: string
  user_id: string
  name: string
  archived_at: Date | null
  created_at: Date
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  }
}

export async function insertCategory(
  pool: Pool,
  data: { userId: string; name: string }
): Promise<Category> {
  const { rows } = await pool.query<CategoryRow>(
    `INSERT INTO categories (user_id, name) VALUES ($1, $2) RETURNING *`,
    [data.userId, data.name]
  )
  return toCategory(rows[0])
}

// Returns only active (non-archived) categories for the user
export async function findCategoriesByUser(
  pool: Pool,
  userId: string
): Promise<Category[]> {
  const { rows } = await pool.query<CategoryRow>(
    `SELECT * FROM categories
     WHERE user_id = $1 AND archived_at IS NULL
     ORDER BY name`,
    [userId]
  )
  return rows.map(toCategory)
}

// Includes archived; used when resolving historical event references
export async function findCategoryById(
  pool: Pool,
  id: string,
  userId: string
): Promise<Category | null> {
  const { rows } = await pool.query<CategoryRow>(
    `SELECT * FROM categories WHERE id = $1 AND user_id = $2`,
    [id, userId]
  )
  return rows[0] ? toCategory(rows[0]) : null
}

export async function renameCategory(
  pool: Pool,
  id: string,
  userId: string,
  name: string
): Promise<Category | null> {
  const { rows } = await pool.query<CategoryRow>(
    `UPDATE categories
     SET name = $3
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
     RETURNING *`,
    [id, userId, name]
  )
  return rows[0] ? toCategory(rows[0]) : null
}

export async function archiveCategory(
  pool: Pool,
  id: string,
  userId: string
): Promise<Category | null> {
  const { rows } = await pool.query<CategoryRow>(
    `UPDATE categories
     SET archived_at = NOW()
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL
     RETURNING *`,
    [id, userId]
  )
  return rows[0] ? toCategory(rows[0]) : null
}
