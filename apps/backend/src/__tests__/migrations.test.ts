// §14.2 rule: "migrations apply cleanly and are reversible"
//
// Tests verify that all migrations can be applied (up) and fully rolled back (down)
// against a live Postgres instance, leaving no tables behind.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { config } from 'dotenv'
import { resolve } from 'path'
import { migrateUp, migrateDown } from '../db/migrate'

config({ path: resolve(__dirname, '../../../../.env') })

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
if (!DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set')

// Tables created by the migrations, in dependency order
const EXPECTED_TABLES = [
  'users',
  'auth_sessions',
  'categories',
  'reasons',
  'buckets',
  'day_start_timeline',
  'items',
  'item_prerequisites',
  'occurrences',
  'events',
  'user_preferences',
  'evidence_entries',
  'reviews',
]

async function getPublicTables(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )
  return rows.map((r) => r.tablename)
}

async function dropAllForTest(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS reviews             CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS evidence_entries    CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS user_preferences    CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS events              CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS occurrences         CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS item_prerequisites  CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS items               CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS day_start_timeline  CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS buckets             CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS reasons             CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS categories          CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS auth_sessions       CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS users               CASCADE`)
  await pool.query(`DROP TABLE IF EXISTS schema_migrations   CASCADE`)
}

let pool: Pool

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL })
  await dropAllForTest(pool)
})

afterAll(async () => {
  await pool.end()
})

describe('migrations are cleanly applicable and reversible', () => {
  it('applies all migrations (up) and creates the expected tables', async () => {
    await migrateUp(pool)
    const tables = await getPublicTables(pool)
    for (const t of EXPECTED_TABLES) {
      expect(tables, `expected table '${t}' to exist after migrateUp`).toContain(t)
    }
    expect(tables).toContain('schema_migrations')
  })

  it('running migrateUp again is idempotent (no duplicate migration error)', async () => {
    await expect(migrateUp(pool)).resolves.toBeUndefined()
  })

  it('rolls back all migrations (down) leaving only an empty public schema', async () => {
    await migrateDown(pool)
    const tables = await getPublicTables(pool)
    for (const t of EXPECTED_TABLES) {
      expect(tables, `expected table '${t}' to be gone after migrateDown`).not.toContain(t)
    }
    expect(tables).not.toContain('schema_migrations')
  })

  it('can be applied again after full rollback', async () => {
    await migrateUp(pool)
    const tables = await getPublicTables(pool)
    for (const t of EXPECTED_TABLES) {
      expect(tables).toContain(t)
    }
  })
})
