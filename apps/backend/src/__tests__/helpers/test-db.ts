// Shared test-database helpers.
// Integration tests call setupTestDb() in beforeAll and teardownTestDb() in afterAll.
// Uses TEST_DATABASE_URL if set, falls back to DATABASE_URL.
// WARNING: setupTestDb() calls resetDatabase() which drops and recreates all tables.

import { Pool } from 'pg'
import { resetDatabase } from '../../db/migrate'

let _pool: Pool | null = null

export function getTestPool(): Pool {
  if (!_pool) throw new Error('Call setupTestDb() first')
  return _pool
}

export async function setupTestDb(): Promise<Pool> {
  const url =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://tracker:dev_password_change_before_deploy@localhost:5432/tracker'

  _pool = new Pool({ connectionString: url })
  await resetDatabase(_pool)
  return _pool
}

export async function teardownTestDb(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
