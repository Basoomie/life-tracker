// §14.2 rule: "migrations apply cleanly and are reversible"
//
// Tests verify that all migrations can be applied (up) and fully rolled back (down)
// against a live Postgres instance, leaving no tables behind.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { config } from 'dotenv'
import { resolve } from 'path'
import { migrateUp, migrateDown } from '../db/migrate'
import { migrations } from '../db/migrations/index'

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
  'item_schedules',
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
  await pool.query(`DROP TABLE IF EXISTS item_schedules      CASCADE`)
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

// ── §5.5 — migration 0014's backfill ─────────────────────────────────────────
//
// The one irreversible step in the schedules split: existing rows are rewritten in
// place, so "did every item get a slot, and every occurrence a schedule_id?" has to
// be answered against data that predates the migration — not against a fresh schema
// where the question is vacuous.

describe('§5.5 migration 0014 backfills existing data', () => {
  // Apply every migration BEFORE 0014, so we can seed pre-split rows.
  async function migrateThrough(name: string): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    for (const m of migrations) {
      await pool.query(m.up)
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [m.name])
      if (m.name === name) return
    }
  }

  beforeAll(async () => {
    await dropAllForTest(pool)
    await migrateThrough('0013_item_sort_order')

    // Pre-split data: two items (one archived) and their occurrences, written with
    // the old flat columns and the old (item, day) occurrence identity.
    const { rows: [user] } = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('backfill@test.com') RETURNING id`
    )
    const mkItem = async (name: string, rule: string | null, archived: boolean) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO items (user_id, name, recurrence_rule, timing_precision,
                            timing_start_time, planned_duration_min, anchor_day, archived_at)
         VALUES ($1, $2, $3::jsonb, 'point', '08:30', 45, '2024-01-01',
                 CASE WHEN $4 THEN NOW() ELSE NULL END)
         RETURNING id`,
        [user.id, name, rule, archived]
      )
      return rows[0].id
    }
    const daily    = await mkItem('Daily', '{"type":"daily"}', false)
    const oneOff   = await mkItem('One-off', null, false)
    const archived = await mkItem('Archived', '{"type":"daily"}', true)

    const snapshot = JSON.stringify({ name: 'x', prerequisiteIds: [] })
    for (const [itemId, day] of [
      [daily, '2025-01-01'], [daily, '2025-01-02'], [oneOff, '2025-01-01'], [archived, '2024-12-01'],
    ]) {
      await pool.query(
        `INSERT INTO occurrences (user_id, item_id, applies_to_day, snapshot)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [user.id, itemId, day, snapshot]
      )
    }

    // Now apply 0014 on top of that pre-split data.
    await migrateUp(pool)
  })

  it('§5.5 every pre-existing item gets exactly one schedule', async () => {
    const { rows } = await pool.query<{ item_id: string; count: string }>(
      `SELECT i.id AS item_id, COUNT(s.id) AS count
         FROM items i LEFT JOIN item_schedules s ON s.item_id = i.id
        GROUP BY i.id`
    )
    expect(rows.length).toBe(3)   // including the archived item
    expect(rows.every((r) => r.count === '1')).toBe(true)
  })

  it("§5.5 the backfilled schedule carries the item's old recurrence and timing verbatim", async () => {
    const { rows } = await pool.query<{
      recurrence_rule: unknown; timing_precision: string
      timing_start_time: string; planned_duration_min: number; anchor_day: string
    }>(
      `SELECT s.recurrence_rule, s.timing_precision, s.timing_start_time,
              s.planned_duration_min, s.anchor_day
         FROM item_schedules s JOIN items i ON i.id = s.item_id
        WHERE i.name = 'Daily'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].recurrence_rule).toEqual({ type: 'daily' })
    expect(rows[0].timing_precision).toBe('point')
    expect(rows[0].timing_start_time).toBe('08:30:00')
    expect(rows[0].planned_duration_min).toBe(45)
    // DATE columns come back as YYYY-MM-DD strings (see db/pg-setup.ts)
    expect(rows[0].anchor_day).toBe('2024-01-01')
  })

  it('§5.5 every pre-existing occurrence is pointed at its item\'s schedule', async () => {
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT COUNT(*) AS orphans FROM occurrences o
        WHERE o.schedule_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM item_schedules s
              WHERE s.id = o.schedule_id AND s.item_id = o.item_id
           )`
    )
    expect(rows[0].orphans).toBe('0')

    const { rows: total } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM occurrences`
    )
    expect(total[0].count).toBe('4')
  })

  it('§5.5 a one-time item is backfilled with a null-rule schedule, not skipped', async () => {
    const { rows } = await pool.query<{ recurrence_rule: unknown }>(
      `SELECT s.recurrence_rule FROM item_schedules s
         JOIN items i ON i.id = s.item_id WHERE i.name = 'One-off'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].recurrence_rule).toBeNull()
  })

  it("§5.5 an archived item's slot is left active — removal of a slot is a different fact", async () => {
    const { rows } = await pool.query<{ archived_at: Date | null }>(
      `SELECT s.archived_at FROM item_schedules s
         JOIN items i ON i.id = s.item_id WHERE i.name = 'Archived'`
    )
    expect(rows[0].archived_at).toBeNull()
  })

  it('§5.5 the occurrences UNIQUE constraint now includes the schedule', async () => {
    const { rows } = await pool.query<{ constraint_name: string }>(
      `SELECT c.conname AS constraint_name
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'occurrences' AND c.contype = 'u'`
    )
    expect(rows.map((r) => r.constraint_name)).toEqual(['occurrences_item_day_schedule_key'])
  })
})
