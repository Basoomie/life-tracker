// Seed script — populates realistic sample data for the default user.
// From §14.2: Night Routine (daily parent) → MWF Tretinoin child,
//             4×/week Workout with quota target,
//             day-trading range item (04:00–06:30),
//             one-time ad-hoc gaming item.
// Plus the categories, reasons, buckets, and day-start they need.
//
// Idempotent on the default user's email: skips seeding if the user already exists.

import { Pool } from 'pg'
import * as repos from './repos/index'

const DEFAULT_USER_EMAIL = 'default@tracker.local'

export async function seed(pool: Pool): Promise<void> {
  // ── User ──────────────────────────────────────────────────────────────────
  let user = await repos.findUserByEmail(pool, DEFAULT_USER_EMAIL)
  if (user) {
    console.log(`[seed] default user already exists (${user.id}), skipping`)
    return
  }
  user = await repos.insertUser(pool, { email: DEFAULT_USER_EMAIL })
  console.log(`[seed] created user ${user.id}`)

  // ── Categories ────────────────────────────────────────────────────────────
  const catHealth  = await repos.insertCategory(pool, { userId: user.id, name: 'Health' })
  const catFitness = await repos.insertCategory(pool, { userId: user.id, name: 'Fitness' })
  const catTrading = await repos.insertCategory(pool, { userId: user.id, name: 'Trading' })
  const catGaming  = await repos.insertCategory(pool, { userId: user.id, name: 'Gaming' })

  // ── Reasons ───────────────────────────────────────────────────────────────
  await repos.insertReason(pool, { userId: user.id, name: 'Sick' })
  await repos.insertReason(pool, { userId: user.id, name: 'Traveling' })
  await repos.insertReason(pool, { userId: user.id, name: 'Rest day' })

  // ── Day-start ─────────────────────────────────────────────────────────────
  // 04:00 so late-night activity lands on the correct day (§6.7)
  await repos.insertDayStartEntry(pool, {
    userId: user.id,
    startsOn: '2024-01-01',
    value: '04:00',
  })

  // ── Buckets ───────────────────────────────────────────────────────────────
  // Tile the 04:00→04:00 window with no gaps or overlaps (§6.6)
  await repos.insertBucket(pool, { userId: user.id, name: 'Early Morning', startTime: '04:00', endTime: '09:00', sortOrder: 1 })
  await repos.insertBucket(pool, { userId: user.id, name: 'Morning',       startTime: '09:00', endTime: '12:00', sortOrder: 2 })
  await repos.insertBucket(pool, { userId: user.id, name: 'Afternoon',     startTime: '12:00', endTime: '17:00', sortOrder: 3 })
  await repos.insertBucket(pool, { userId: user.id, name: 'Evening',       startTime: '17:00', endTime: '22:00', sortOrder: 4 })
  // Night wraps past midnight back to day-start; domain logic (step 2) handles end<start
  await repos.insertBucket(pool, { userId: user.id, name: 'Night',         startTime: '22:00', endTime: '04:00', sortOrder: 5 })

  // ── Items ─────────────────────────────────────────────────────────────────

  // Night Routine — daily parent, auto-close policy (§8.1 auto_close)
  const nightRoutine = await repos.insertItem(pool, {
    userId:            user.id,
    name:              'Night Routine',
    categoryId:        catHealth.id,
    recurrenceRule:    { type: 'daily' },
    timingPrecision:   'none',
    dispositionPolicy: 'auto_close',
    creationSource:    'planned',
  })

  // Tretinoin — MWF child of Night Routine (§4.1 containment)
  await repos.insertItem(pool, {
    userId:            user.id,
    name:              'Tretinoin',
    categoryId:        catHealth.id,
    recurrenceRule:    { type: 'days_of_week', days: [1, 3, 5] },  // Mon/Wed/Fri
    timingPrecision:   'none',
    dispositionPolicy: 'skip',
    parentId:          nightRoutine.id,
    creationSource:    'planned',
  })

  // Workout — 4×/week quota; Mon/Tue/Thu/Sat scheduled days (§5.2)
  await repos.insertItem(pool, {
    userId:            user.id,
    name:              'Workout',
    categoryId:        catFitness.id,
    recurrenceRule:    { type: 'days_of_week', days: [1, 2, 4, 6] },  // Mon/Tue/Thu/Sat
    quotaTarget:       { count: 4, period: 'week' },
    timingPrecision:   'none',
    dispositionPolicy: 'skip',
    creationSource:    'planned',
  })

  // Day-trading — range item 04:00–06:30 (§6.5 range precision)
  await repos.insertItem(pool, {
    userId:            user.id,
    name:              'Day Trading',
    categoryId:        catTrading.id,
    recurrenceRule:    { type: 'days_of_week', days: [1, 2, 3, 4, 5] },  // weekdays
    timingPrecision:   'range',
    timingStartTime:   '04:00',
    timingEndTime:     '06:30',
    plannedDurationMin: 150,   // 2.5 hours, implied by the range
    dispositionPolicy: 'skip',
    creationSource:    'planned',
  })

  // Gaming — one-time ad-hoc item (§9.2 ad-hoc capture)
  await repos.insertItem(pool, {
    userId:            user.id,
    name:              'Gaming session',
    categoryId:        catGaming.id,
    recurrenceRule:    null,   // one-time task
    timingPrecision:   'none',
    dispositionPolicy: 'skip',
    creationSource:    'ad_hoc',
  })

  console.log('[seed] done')
}

// Allow running directly: tsx src/db/seed.ts
if (require.main === module) {
  ;(async () => {
    const { config } = await import('dotenv')
    config()
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      await seed(pool)
    } finally {
      await pool.end()
    }
  })()
}
