// §11 + §13.3 + §13.5 — Step 6: deployment hardening + verified backup/restore.
// Tests named after the spec rules they verify.
//
// RESTORE ROUND-TRIP TEST (critical §11 requirement):
// Seed known data → pg_dump → wipe → psql restore → assert every row identical
// with correct user_id and event history intact.
//
// pg_dump/psql are invoked via `docker compose exec db` (mirrors the production
// backup path). Falls back to native pg_dump/psql if Docker is not available
// (e.g., CI environments with a native Postgres install).
//
// Prerequisites: the Postgres db container must be reachable (same requirement
// as all other integration tests which connect to localhost:5432).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Pool } from 'pg'
import * as bcrypt from 'bcryptjs'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as userRepos from '../db/repos/users'
import * as itemRepos from '../db/repos/items'
import * as sessionRepos from '../db/repos/auth_sessions'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import { insertEvent } from '../db/repos/events'
import { resetDatabase, migrateUp } from '../db/migrate'

const PROJECT_ROOT = join(__dirname, '../../../../')
const BCRYPT_ROUNDS = 4

// ── pg_dump / psql helpers ────────────────────────────────────────────────────

interface DbConn {
  host: string
  port: string
  user: string
  password: string
  database: string
}

function parseDbUrl(url: string): DbConn {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  }
}

// Returns true if `docker compose exec -T db pg_isready` succeeds (db container is running).
function isDockerDbRunning(): boolean {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready'], {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
  })
  return r.status === 0 && !r.error
}

// Dump the named database as plain SQL (--clean --if-exists).
// Tries docker compose exec first; falls back to native pg_dump.
function pgDump(conn: DbConn): Buffer {
  if (isDockerDbRunning()) {
    // Production-equivalent path: same mechanism as backup-entrypoint.sh
    // Unix-socket connection inside the container uses trust auth (no password needed).
    const r = spawnSync(
      'docker',
      [
        'compose', 'exec', '-T', 'db',
        'pg_dump', '-U', conn.user,
        '--clean', '--if-exists', '--no-owner', '--no-acl',
        conn.database,
      ],
      { cwd: PROJECT_ROOT, maxBuffer: 100 * 1024 * 1024 },
    )
    if (r.status === 0) return r.stdout
    throw new Error(
      `docker compose exec pg_dump failed (is tracker_db running?):\n${r.stderr?.toString() ?? ''}`,
    )
  }

  // Fallback: native pg_dump (CI or native Postgres install)
  const r = spawnSync(
    'pg_dump',
    [
      '-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database,
      '--clean', '--if-exists', '--no-owner', '--no-acl',
    ],
    { env: { ...process.env, PGPASSWORD: conn.password }, maxBuffer: 100 * 1024 * 1024 },
  )
  if (r.status !== 0 || r.error) {
    throw new Error(
      'pg_dump unavailable. Install postgresql-client or start the Docker compose stack.\n' +
      (r.stderr?.toString() ?? r.error?.message ?? ''),
    )
  }
  return r.stdout
}

// Pipe SQL into psql to restore (compatible with dumps produced by pgDump above).
function psqlRestore(sql: Buffer, conn: DbConn): void {
  if (isDockerDbRunning()) {
    const r = spawnSync(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-U', conn.user, conn.database],
      { cwd: PROJECT_ROOT, input: sql, maxBuffer: 100 * 1024 * 1024 },
    )
    if (r.status === 0) return
    throw new Error(
      `docker compose exec psql restore failed:\n${r.stderr?.toString() ?? ''}`,
    )
  }

  // Fallback: native psql
  const r = spawnSync(
    'psql',
    ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database],
    {
      input: sql,
      env: { ...process.env, PGPASSWORD: conn.password },
      maxBuffer: 100 * 1024 * 1024,
    },
  )
  if (r.status !== 0 || r.error) {
    throw new Error(
      'psql restore failed.\n' + (r.stderr?.toString() ?? r.error?.message ?? ''),
    )
  }
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb()
})

afterAll(async () => {
  await teardownTestDb()
})

// ── §13.5 Rename-proofing ─────────────────────────────────────────────────────

describe('§13.5 rename-proofing holds — no branded names in DB or volume identifiers', () => {
  it('docker-compose.yml container_name and named volume identifiers contain no branded name', () => {
    const compose = readFileSync(join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8')

    const containerNames = [...compose.matchAll(/container_name:\s*(\S+)/g)].map((m) => m[1])
    expect(containerNames.length).toBeGreaterThan(0)
    for (const name of containerNames) {
      expect(name).not.toMatch(/life.?tracker/i)
    }

    // Top-level volumes section
    const volumeSection = compose.match(/^volumes:\n([\s\S]*)$/m)?.[1] ?? ''
    expect(volumeSection).not.toMatch(/life.?tracker/i)

    // POSTGRES_DB value
    const dbMatches = [...compose.matchAll(/POSTGRES_DB[:\s=]+([^\n}]+)/g)].map((m) =>
      m[1].trim(),
    )
    for (const db of dbMatches) {
      expect(db).not.toMatch(/life.?tracker/i)
    }
  })

  it('migration files contain no life_tracker_ table or schema identifiers', () => {
    const migrationsDir = join(PROJECT_ROOT, 'apps/backend/src/db/migrations')
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = readFileSync(join(migrationsDir, file), 'utf8')
      expect(content).not.toMatch(/life.?tracker/i)
    }
  })
})

// ── §13.3 .env.example completeness ──────────────────────────────────────────

describe('§13.3 .env.example documents all required vars; secrets use :?required for fast-fail', () => {
  it('all required secrets in docker-compose.yml use the :?required fast-fail syntax', () => {
    const compose = readFileSync(join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8')
    // Every required secret must use ${VAR:?required} so a missing var fails at compose-up
    const requiredSecrets = [
      'POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_DB',
      'INITIAL_USER_EMAIL', 'INITIAL_USER_PASSWORD', 'APP_HOST_PORT',
    ]
    for (const secret of requiredSecrets) {
      expect(compose).toContain(`\${${secret}:?required}`)
    }
  })

  it('.env.example documents BACKUP_DIR, BACKUP_SCHEDULE, BACKUP_KEEP_DAYS', () => {
    const envExample = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8')
    expect(envExample).toContain('BACKUP_DIR')
    expect(envExample).toContain('BACKUP_SCHEDULE')
    expect(envExample).toContain('BACKUP_KEEP_DAYS')
  })

  it('.env.example documents INITIAL_USER_EMAIL, INITIAL_USER_PASSWORD, and break-glass note', () => {
    const envExample = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8')
    expect(envExample).toContain('INITIAL_USER_EMAIL')
    expect(envExample).toContain('INITIAL_USER_PASSWORD')
    // Break-glass note must be present
    expect(envExample).toContain('reset-password')
  })
})

// ── §11 RESTORE ROUND-TRIP TEST ───────────────────────────────────────────────
//
// Spec requirement: populate DB with known data → run backup → wipe →
// restore into a clean DB → assert every row is back, identical, and correctly
// owned (user_id intact, event history intact).
//
// This is the non-negotiable heart of step 6. A backup that cannot be proven
// to restore is worthless.

describe('§11 RESTORE ROUND-TRIP TEST — known data survives backup → wipe → restore', () => {
  it('user, items, occurrences, events, and sessions all survive a pg_dump → wipe → psql restore', async () => {
    const pool = getTestPool()
    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
    const conn  = parseDbUrl(dbUrl)

    // ── 1. Seed known data ────────────────────────────────────────────────────

    const hash = await bcrypt.hash('round-trip-pass1!', BCRYPT_ROUNDS)
    const user = await userRepos.insertUser(pool, {
      email:        'round-trip@backup.test',
      passwordHash: hash,
    })

    const item = await itemRepos.insertItem(pool, {
      userId:         user.id,
      name:           'Round-trip Test Item',
      recurrenceRule: null,
      creationSource: 'planned',
    })

    const occ = await ensureOccurrenceMaterialized(pool, item, '2026-01-15', user.id)

    const event = await insertEvent(pool, {
      userId:       user.id,
      eventType:    'item_completed',
      occurrenceId: occ.id,
      itemId:       item.id,
      appliesToDay: '2026-01-15',
      payload:      { completionPercent: 100, source: 'derived' },
    })

    const sessionId = await sessionRepos.createSession(pool, user.id)

    // Capture IDs that must survive the round-trip
    const seededIds = {
      userId:    user.id,
      itemId:    item.id,
      occId:     occ.id,
      eventId:   event.id,
      sessionId,
    }

    // ── 2. Dump ───────────────────────────────────────────────────────────────

    const sql = pgDump(conn)
    expect(sql.length).toBeGreaterThan(0)

    // ── 3. Wipe ───────────────────────────────────────────────────────────────
    // resetDatabase drops all tables and re-runs migrations → clean slate.
    // The dump's --clean --if-exists will drop them again and recreate from backup.

    await resetDatabase(pool)

    // Verify the wipe: seeded user must be gone
    const { rows: afterWipe } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM users WHERE id = $1',
      [seededIds.userId],
    )
    expect(afterWipe[0].count).toBe('0')

    // ── 4. Restore ────────────────────────────────────────────────────────────

    psqlRestore(sql, conn)

    // ── 5. Verify ─────────────────────────────────────────────────────────────
    // Open a fresh pool (avoids stale connection/transaction state from above).

    const verifyPool = new Pool({ connectionString: dbUrl })
    try {
      // User survives with same id
      const { rows: [restoredUser] } = await verifyPool.query<{ id: string; email: string }>(
        'SELECT id, email FROM users WHERE id = $1',
        [seededIds.userId],
      )
      expect(restoredUser).toBeDefined()
      expect(restoredUser.id).toBe(seededIds.userId)
      expect(restoredUser.email).toBe('round-trip@backup.test')

      // Item survives with correct user_id
      const { rows: [restoredItem] } = await verifyPool.query<{ id: string; user_id: string; name: string }>(
        'SELECT id, user_id, name FROM items WHERE id = $1',
        [seededIds.itemId],
      )
      expect(restoredItem).toBeDefined()
      expect(restoredItem.id).toBe(seededIds.itemId)
      expect(restoredItem.user_id).toBe(seededIds.userId)
      expect(restoredItem.name).toBe('Round-trip Test Item')

      // Occurrence survives with correct user_id
      const { rows: [restoredOcc] } = await verifyPool.query<{ id: string; user_id: string; item_id: string }>(
        'SELECT id, user_id, item_id FROM occurrences WHERE id = $1',
        [seededIds.occId],
      )
      expect(restoredOcc).toBeDefined()
      expect(restoredOcc.id).toBe(seededIds.occId)
      expect(restoredOcc.user_id).toBe(seededIds.userId)
      expect(restoredOcc.item_id).toBe(seededIds.itemId)

      // Event (history) survives with correct user_id
      const { rows: [restoredEvent] } = await verifyPool.query<{
        id: string; user_id: string; event_type: string; occurrence_id: string
      }>(
        'SELECT id, user_id, event_type, occurrence_id FROM events WHERE id = $1',
        [seededIds.eventId],
      )
      expect(restoredEvent).toBeDefined()
      expect(restoredEvent.id).toBe(seededIds.eventId)
      expect(restoredEvent.user_id).toBe(seededIds.userId)
      expect(restoredEvent.event_type).toBe('item_completed')
      expect(restoredEvent.occurrence_id).toBe(seededIds.occId)

      // Session survives with correct user_id
      const { rows: [restoredSession] } = await verifyPool.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM auth_sessions WHERE id = $1',
        [seededIds.sessionId],
      )
      expect(restoredSession).toBeDefined()
      expect(restoredSession.id).toBe(seededIds.sessionId)
      expect(restoredSession.user_id).toBe(seededIds.userId)

    } finally {
      await verifyPool.end()
    }
  }, 60_000) // pg_dump + restore can take a moment

  it('restored database passes migrateUp without errors (schema_migrations intact)', async () => {
    // After the round-trip test above, the DB is in the restored state.
    // migrateUp must be a no-op (all migrations already applied from the dump).
    const pool = getTestPool()
    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
    const conn  = parseDbUrl(dbUrl)

    // Re-seed and re-dump for a clean test (the previous test left the DB in restored state)
    const hash = await bcrypt.hash('migrate-check-pass!', BCRYPT_ROUNDS)
    const user = await userRepos.insertUser(pool, {
      email:        'migrate-check@backup.test',
      passwordHash: hash,
    })
    const sql = pgDump(conn)

    // Wipe + restore
    await resetDatabase(pool)
    psqlRestore(sql, conn)

    // migrateUp on a correctly restored DB must apply 0 new migrations
    const verifyPool = new Pool({ connectionString: dbUrl })
    try {
      const { rows: before } = await verifyPool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      )
      const countBefore = before.length
      expect(countBefore).toBeGreaterThan(0) // migrations are in the restored dump

      // migrateUp (imported from migrate.ts) must be idempotent
      const { migrateUp } = await import('../db/migrate')
      await migrateUp(verifyPool)

      const { rows: after } = await verifyPool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      )
      expect(after.length).toBe(countBefore) // no new migrations applied
    } finally {
      await verifyPool.end()
    }
  }, 60_000)
})

// ── §11 backup file output ────────────────────────────────────────────────────

describe('§11 backup produces a non-empty dump file when run manually', () => {
  it('pgDump produces a non-empty SQL dump containing expected table CREATE statements', async () => {
    const pool = getTestPool()

    // Seed minimal data so the dump is meaningful
    const hash = await bcrypt.hash('dump-test-pass!', BCRYPT_ROUNDS)
    await userRepos.insertUser(pool, { email: 'dump-test@backup.test', passwordHash: hash })

    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
    const conn  = parseDbUrl(dbUrl)
    const sql   = pgDump(conn)

    const sqlStr = sql.toString('utf8')

    // Must be non-empty and contain essential table names
    expect(sqlStr.length).toBeGreaterThan(500)
    expect(sqlStr).toContain('CREATE TABLE')
    expect(sqlStr).toContain('users')
    expect(sqlStr).toContain('items')
    expect(sqlStr).toContain('events')
    expect(sqlStr).toContain('occurrences')
    expect(sqlStr).toContain('auth_sessions')
    // --clean flag: DROP TABLE IF EXISTS statements are present
    expect(sqlStr).toContain('DROP TABLE IF EXISTS')
  }, 30_000)
})

// ── §11 backup rotation ───────────────────────────────────────────────────────

describe('§11 backup entrypoint prunes files older than BACKUP_KEEP_DAYS', () => {
  it('backup-entrypoint.sh contains a find -mtime prune command', () => {
    const script = readFileSync(
      join(PROJECT_ROOT, 'scripts/backup-entrypoint.sh'),
      'utf8',
    )
    // Must have retention/pruning logic
    expect(script).toContain('BACKUP_KEEP_DAYS')
    expect(script).toContain('find /backups')
    expect(script).toContain('-mtime')
    expect(script).toContain('-delete')
  })

  it('backup-entrypoint.sh includes an initial backup on startup (not just cron)', () => {
    const script = readFileSync(
      join(PROJECT_ROOT, 'scripts/backup-entrypoint.sh'),
      'utf8',
    )
    // Must call do-backup on startup, not only via crond
    expect(script).toContain('initial backup')
    expect(script).toContain('/usr/local/bin/do-backup')
    // And install a cron job for the schedule
    expect(script).toContain('crontab')
    expect(script).toContain('BACKUP_SCHEDULE')
  })
})
