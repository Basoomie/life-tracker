import './pg-setup'

// Custom migration runner — no external dependency.
// Tracks applied migrations in a 'schema_migrations' table.
// Each migration exports { name, up, down } SQL strings.

import type { Pool } from 'pg'
import { migrations } from './migrations/index'

const MIGRATIONS_TABLE = 'schema_migrations'

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

export async function migrateUp(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool)

  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`
  )
  const applied = new Set(rows.map((r) => r.name))

  for (const m of migrations) {
    if (!applied.has(m.name)) {
      await pool.query(m.up)
      await pool.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1)`,
        [m.name]
      )
      console.log(`[migrate] applied: ${m.name}`)
    }
  }
}

export async function migrateDown(pool: Pool): Promise<void> {
  // schema_migrations may not exist yet on a fresh DB — nothing to roll back
  const { rows: tables } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
    [MIGRATIONS_TABLE]
  )
  if (tables.length === 0) return

  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name DESC`
  )

  for (const { name } of rows) {
    const m = migrations.find((m) => m.name === name)
    if (m) {
      await pool.query(m.down)
      await pool.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`, [name])
      console.log(`[migrate] rolled back: ${name}`)
    }
  }

  await pool.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
}

// Drops all known tables then re-runs all migrations.  Used in tests for a clean slate.
export async function resetDatabase(pool: Pool): Promise<void> {
  // Drop in reverse FK dependency order; CASCADE handles anything we miss
  await pool.query(`DROP TABLE IF EXISTS user_preferences    CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS events              CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS occurrences         CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS item_prerequisites  CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS items               CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS day_start_timeline  CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS buckets             CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS reasons             CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS categories          CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS users               CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE} CASCADE`)
  await migrateUp(pool)
}
