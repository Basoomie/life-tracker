// v2 §9.4.1 — Seeds the known-good levers (§6.3) into the evidence base for a user.
// Run manually:
//   docker compose exec app tsx src/scripts/seed-evidence.ts <email>
//
// Each seed traverses the identical propose → verify pipeline as any AI-proposed
// candidate would in step 3b (evidence/pipeline.ts) — including a real outbound
// call to PubMed. Verified entries still land in the approval queue: seeding does
// NOT auto-approve (§9.4.1: approval is a human step, always).

import { config } from 'dotenv'
import { join } from 'path'
config({ path: join(__dirname, '../../../../.env') })

import { Pool } from 'pg'
import * as repos from '../db/repos/index'
import { proposeEvidenceEntry } from '../evidence/pipeline'
import { KNOWN_GOOD_LEVERS } from '../evidence/seed-data'

async function main() {
  const email = process.argv[2] || process.env.INITIAL_USER_EMAIL
  if (!email) {
    console.error('Usage: tsx src/scripts/seed-evidence.ts <email>')
    process.exit(1)
  }

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    const user = await repos.findUserByEmail(pool, email!)
    if (!user) throw new Error(`no user found for email: ${email}`)

    for (const candidate of KNOWN_GOOD_LEVERS) {
      const entry = await proposeEvidenceEntry(pool, user.id, candidate, 'seeded')
      console.log(
        `[seed-evidence] "${entry.claim.slice(0, 60)}…" → ${entry.verificationStatus}` +
          (entry.verificationStatus === 'rejected' ? ` (${entry.rejectionReason}: ${entry.rejectionDetail})` : '')
      )
    }
    console.log('[seed-evidence] done — verified entries await human approval, not auto-approved')
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
