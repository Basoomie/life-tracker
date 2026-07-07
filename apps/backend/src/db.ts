import './db/pg-setup'
import { Pool } from 'pg'

// In test environments TEST_DATABASE_URL takes precedence so the app pool and
// the test pool both hit the same isolated database (never the production DB).
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required')
}

export const pool = new Pool({ connectionString })
