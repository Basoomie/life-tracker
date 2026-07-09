// §3.3 Time — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// Covers:
//   per-item total time and session count
//   planned-vs-actual delta
//   session start-time distribution
//   ad-hoc share (planned vs unplanned)
//   unplanned time by valence
//   live vs manual sessions
//   per-category time aggregation
//   raw counts on every finding

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { getItemTimeStats, getAdHocShare, getCategoryTimeStats } from '../../stats/index'
import type { DateWindow } from '@tracker/shared'
import { randomUUID } from 'crypto'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

const MON = '2025-02-03'
const TUE = '2025-02-04'
const WED = '2025-02-05'

const WEEK: DateWindow = { startDay: MON, endDay: WED }

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `time-${suffix}@test.com` })
}

// Insert a completed manual session for an item on a given day.
// Uses the session_created event type (no live pair needed).
async function insertManualSession(
  userId: string, itemId: string, day: string,
  durationMin: number, startedAtISO?: string
) {
  const sessionId = randomUUID()
  const startedAt = startedAtISO ?? `${day}T09:00:00.000Z`
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'session_created',
    itemId, appliesToDay: day,
    payload: { sessionId, startedAt, durationMin },
  })
  return sessionId
}

// Insert a live session (started + stopped pair).
async function insertLiveSession(
  userId: string, itemId: string, day: string,
  durationMin: number, startedAtISO?: string
) {
  const sessionId = randomUUID()
  const startedAt = startedAtISO ?? `${day}T10:00:00.000Z`
  // Simulate start recorded at startedAt
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'session_started',
    itemId, appliesToDay: day,
    recordedAt: new Date(startedAt),
    payload: { sessionId },
  })
  // Stop recorded after durationMin
  const stoppedAt = new Date(new Date(startedAt).getTime() + durationMin * 60_000)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'session_stopped',
    itemId, appliesToDay: day,
    recordedAt: stoppedAt,
    payload: { sessionId, durationMin },
  })
  return sessionId
}

// ── §3.3 Per-item total time ──────────────────────────────────────────────────

describe('§3.3 per-item total time and session count', () => {
  it('§3.3 totalMin sums all sessions for the item in the window', async () => {
    const u = await makeUser('total-min')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Reading',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    await insertManualSession(u.id, item.id, MON, 30)
    await insertManualSession(u.id, item.id, TUE, 45)
    await insertManualSession(u.id, item.id, WED, 15)

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.type).toBe('time_stats')
    expect(finding.totalMin).toBe(90)
    expect(finding.rawCounts.sessionCount).toBe(3)
  })

  it('§3.3 sessions from other users are excluded', async () => {
    const ua = await makeUser('time-scope-a')
    const ub = await makeUser('time-scope-b')
    const itemA = await repos.insertItem(getTestPool(), {
      userId: ua.id, name: 'Work', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const itemB = await repos.insertItem(getTestPool(), {
      userId: ub.id, name: 'Work', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    await insertManualSession(ua.id, itemA.id, MON, 60)
    await insertManualSession(ub.id, itemB.id, MON, 120)

    const findingA = await getItemTimeStats(getTestPool(), ua.id, itemA.id, WEEK)
    const findingB = await getItemTimeStats(getTestPool(), ub.id, itemB.id, WEEK)
    expect(findingA.totalMin).toBe(60)
    expect(findingB.totalMin).toBe(120)
  })
})

// ── §3.3 Live vs manual sessions ─────────────────────────────────────────────

describe('§3.3 live and manual sessions are both counted', () => {
  it('§3.3 live sessions contribute to totalMin and rawCounts.liveSessions', async () => {
    const u = await makeUser('live-sessions')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Meditation',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    await insertLiveSession(u.id, item.id, MON, 20)
    await insertManualSession(u.id, item.id, TUE, 15)

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.rawCounts.liveSessions).toBe(1)
    expect(finding.rawCounts.manualSessions).toBe(1)
    expect(finding.totalMin).toBe(35)
  })

  it('§3.3 incomplete live sessions (started but not stopped) are omitted', async () => {
    const u = await makeUser('incomplete-live')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Study',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    // Start a session but never stop it
    const sessionId = randomUUID()
    await repos.insertEvent(getTestPool(), {
      userId: u.id, eventType: 'session_started',
      itemId: item.id, appliesToDay: MON,
      payload: { sessionId },
    })

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.rawCounts.sessionCount).toBe(0)
    expect(finding.totalMin).toBe(0)
  })
})

// ── §3.3 Planned-vs-actual delta ─────────────────────────────────────────────

describe('§3.3 planned-vs-actual delta is computed when item has plannedDurationMin', () => {
  it('§3.3 plannedVsActualDeltaMin = totalMin minus plannedMin*sessionDays', async () => {
    const u = await makeUser('planned-actual')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Exercise',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
      plannedDurationMin: 30,
    })

    // Two session days: Mon 40min, Wed 20min → total 60
    // Planned: 30 * 2 days = 60 → delta = 0
    await insertManualSession(u.id, item.id, MON, 40)
    await insertManualSession(u.id, item.id, WED, 20)

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.plannedDurationMin).toBe(30)
    expect(finding.plannedVsActualDeltaMin).toBe(0)  // 60 - (30*2) = 0
  })

  it('§3.3 plannedVsActualDeltaMin is null when item has no plannedDurationMin', async () => {
    const u = await makeUser('no-planned')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Reading',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    await insertManualSession(u.id, item.id, MON, 25)

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.plannedVsActualDeltaMin).toBeNull()
  })
})

// ── §3.3 Session start-time distribution ──────────────────────────────────────

describe('§3.3 session start-time distribution by UTC hour', () => {
  it('§3.3 sessionStartDistribution groups sessions by UTC start hour', async () => {
    const u = await makeUser('start-dist')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Focus', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    // 3 sessions at UTC hour 9, 1 at UTC hour 14
    await insertManualSession(u.id, item.id, MON, 30, `${MON}T09:00:00.000Z`)
    await insertManualSession(u.id, item.id, TUE, 45, `${TUE}T09:15:00.000Z`)
    await insertManualSession(u.id, item.id, WED, 20, `${WED}T09:30:00.000Z`)
    await insertManualSession(u.id, item.id, MON, 60, `${MON}T14:00:00.000Z`)

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    const dist = finding.sessionStartDistribution

    const hour9 = dist.find(e => e.hour === 9)
    const hour14 = dist.find(e => e.hour === 14)

    expect(hour9).toBeDefined()
    expect(hour9!.count).toBe(3)
    expect(hour9!.totalMin).toBe(95)  // 30+45+20
    expect(hour14).toBeDefined()
    expect(hour14!.count).toBe(1)
    expect(hour14!.totalMin).toBe(60)
  })

  it('§3.3 sessionStartDistribution is empty when no sessions', async () => {
    const u = await makeUser('dist-empty')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Empty', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.sessionStartDistribution).toEqual([])
  })
})

// ── §3.3 Ad-hoc share: planned vs unplanned time ─────────────────────────────

describe('§3.3 ad-hoc share — planned vs. unplanned time', () => {
  it('§3.3 adHocShare = adHocMin / totalTrackedMin', async () => {
    const u = await makeUser('adhoc-share')
    const planned = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Planned Study',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const adhoc = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Ad Hoc Browse',
      recurrenceRule: null, creationSource: 'ad_hoc',
    })

    await insertManualSession(u.id, planned.id, MON, 60)
    await insertManualSession(u.id, adhoc.id, MON, 40)

    const finding = await getAdHocShare(getTestPool(), u.id, WEEK)
    expect(finding.type).toBe('adhoc_share')
    expect(finding.totalTrackedMin).toBe(100)
    expect(finding.plannedMin).toBe(60)
    expect(finding.adHocMin).toBe(40)
    expect(finding.adHocShare).toBeCloseTo(0.4)
  })

  it('§3.3 adHocShare = 0 when no sessions', async () => {
    const u = await makeUser('adhoc-zero')
    const finding = await getAdHocShare(getTestPool(), u.id, WEEK)
    expect(finding.adHocShare).toBe(0)
    expect(finding.rawCounts.totalSessions).toBe(0)
  })
})

// ── §3.3 Unplanned time by valence ───────────────────────────────────────────

describe('§3.3 unplanned time split by valence', () => {
  it('§3.3 adHocByValence accumulates minutes for each valence bucket', async () => {
    const u = await makeUser('valence')
    const productive = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Side Project',
      recurrenceRule: null, creationSource: 'ad_hoc', valence: 'productive',
    })
    const unproductive = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Doom Scroll',
      recurrenceRule: null, creationSource: 'ad_hoc', valence: 'unproductive',
    })
    const neutral = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Reading News',
      recurrenceRule: null, creationSource: 'ad_hoc', valence: 'neutral',
    })

    await insertManualSession(u.id, productive.id, MON, 30)
    await insertManualSession(u.id, unproductive.id, MON, 15)
    await insertManualSession(u.id, neutral.id, MON, 20)

    const finding = await getAdHocShare(getTestPool(), u.id, WEEK)
    expect(finding.adHocByValence.productive).toBe(30)
    expect(finding.adHocByValence.unproductive).toBe(15)
    expect(finding.adHocByValence.neutral).toBe(20)
    expect(finding.adHocByValence.unclassified).toBe(0)
  })

  it('§3.3 planned sessions do not contribute to adHocByValence', async () => {
    const u = await makeUser('valence-planned')
    const planned = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Workout',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned', valence: 'productive',
    })

    await insertManualSession(u.id, planned.id, MON, 45)

    const finding = await getAdHocShare(getTestPool(), u.id, WEEK)
    // Planned sessions don't contribute to adHocByValence
    expect(finding.adHocByValence.productive).toBe(0)
    expect(finding.adHocMin).toBe(0)
  })
})

// ── §3.3 Per-category time ────────────────────────────────────────────────────

describe('§3.3 per-category time aggregates sessions across items in that category', () => {
  it('§3.3 getCategoryTimeStats sums only sessions for items in that category', async () => {
    const u = await makeUser('cat-time')
    const cat = await repos.insertCategory(getTestPool(), { userId: u.id, name: 'Health' })

    const item1 = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Workout', categoryId: cat.id,
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const item2 = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Meal Prep', categoryId: cat.id,
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const other = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Work',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    await insertManualSession(u.id, item1.id, MON, 45)
    await insertManualSession(u.id, item2.id, TUE, 30)
    await insertManualSession(u.id, other.id, MON, 60)  // different category

    const finding = await getCategoryTimeStats(getTestPool(), u.id, cat.id, WEEK)
    expect(finding.totalMin).toBe(75)  // item1+item2 only
    expect(finding.rawCounts.sessionCount).toBe(2)
  })
})

// ── §3.3 Raw counts on every finding ─────────────────────────────────────────

describe('§3.3 every time finding includes rawCounts', () => {
  it('§3.3 time_stats rawCounts has sessionCount, liveSessions, manualSessions', async () => {
    const u = await makeUser('time-raw')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Test',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })

    const finding = await getItemTimeStats(getTestPool(), u.id, item.id, WEEK)
    expect(finding.rawCounts).toMatchObject({
      sessionCount: expect.any(Number),
      liveSessions: expect.any(Number),
      manualSessions: expect.any(Number),
    })
  })

  it('§3.3 adhoc_share rawCounts has totalSessions, plannedSessions, adHocSessions', async () => {
    const u = await makeUser('adhoc-raw')
    const finding = await getAdHocShare(getTestPool(), u.id, WEEK)
    expect(finding.rawCounts).toMatchObject({
      totalSessions: expect.any(Number),
      plannedSessions: expect.any(Number),
      adHocSessions: expect.any(Number),
    })
  })
})
