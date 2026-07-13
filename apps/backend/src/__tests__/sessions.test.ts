// §9.1 — Session-duration domain logic.
// computeLoggedMinutes is pure (TrackerEvent fixtures only, no DB).
// computeSubtreeLoggedMinutes is DB-backed (it walks the containment tree) —
// its tests hit a real database via the test pool, same as completion.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { computeLoggedMinutes, computeSubtreeLoggedMinutes } from '../domain/sessions'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import type { TrackerEvent } from '@tracker/shared'

// Minimal event fixture — only the fields computeLoggedMinutes reads matter.
function ev(eventType: TrackerEvent['eventType'], payload: Record<string, unknown>): TrackerEvent {
  return {
    id: 'e-' + Math.random(),
    userId: 'u1',
    eventType,
    recordedAt: new Date('2025-01-15T04:00:00Z'),
    appliesToDay: '2025-01-15',
    occurrenceId: 'occ-1',
    itemId: 'item-1',
    payload,
  } as TrackerEvent
}

describe('§9.1 — computeLoggedMinutes sums finalized sessions, not in-progress ones', () => {
  it('a single stopped live session contributes its durationMin', () => {
    const events = [
      ev('session_started', { sessionId: 's1' }),
      ev('session_stopped', { sessionId: 's1', stoppedAt: '2025-01-15T04:10:00Z', durationMin: 10 }),
    ]
    expect(computeLoggedMinutes(events)).toBe(10)
  })

  it('§9.1 re-starting the timer is additive: two independent stop/start cycles sum, neither overwrites the other', () => {
    const events = [
      ev('session_started', { sessionId: 's1' }),
      ev('session_stopped', { sessionId: 's1', stoppedAt: '2025-01-15T04:10:00Z', durationMin: 10 }),
      ev('session_started', { sessionId: 's2' }),
      ev('session_stopped', { sessionId: 's2', stoppedAt: '2025-01-15T04:20:00Z', durationMin: 15 }),
    ]
    expect(computeLoggedMinutes(events)).toBe(25)
  })

  it('a started-but-not-stopped session contributes nothing (not yet finalized)', () => {
    const events = [
      ev('session_started', { sessionId: 's1' }),
      ev('session_stopped', { sessionId: 's1', stoppedAt: '2025-01-15T04:10:00Z', durationMin: 10 }),
      ev('session_started', { sessionId: 's2' }),   // still running
    ]
    expect(computeLoggedMinutes(events)).toBe(10)
  })

  it('a manual (backdated) session contributes its durationMin like a live one', () => {
    const events = [
      ev('session_created', { sessionId: 's1', startedAt: '2025-01-15T04:00:00Z', endedAt: '2025-01-15T04:30:00Z', durationMin: 30 }),
    ]
    expect(computeLoggedMinutes(events)).toBe(30)
  })

  it('an edited manual session counts the edit, not the superseded original', () => {
    const events = [
      ev('session_created', { sessionId: 's1', startedAt: '2025-01-15T04:00:00Z', endedAt: '2025-01-15T04:30:00Z', durationMin: 30 }),
      ev('session_edited',  { sessionId: 's1', startedAt: '2025-01-15T04:00:00Z', endedAt: '2025-01-15T04:45:00Z', durationMin: 45 }),
    ]
    expect(computeLoggedMinutes(events)).toBe(45)
  })

  it('no session events at all yields zero', () => {
    expect(computeLoggedMinutes([])).toBe(0)
  })

  it('§9.1 a deleted live session contributes nothing, even though it was stopped', () => {
    const events = [
      ev('session_started', { sessionId: 's1' }),
      ev('session_stopped', { sessionId: 's1', stoppedAt: '2025-01-15T04:10:00Z', durationMin: 10 }),
      ev('session_deleted', { sessionId: 's1' }),
    ]
    expect(computeLoggedMinutes(events)).toBe(0)
  })

  it('§9.1 a deleted manual session contributes nothing, even though it was created', () => {
    const events = [
      ev('session_created', { sessionId: 's1', startedAt: '2025-01-15T04:00:00Z', endedAt: '2025-01-15T04:30:00Z', durationMin: 30 }),
      ev('session_deleted', { sessionId: 's1' }),
    ]
    expect(computeLoggedMinutes(events)).toBe(0)
  })

  it('§9.1 deleting one session in a group of several leaves the others\' totals untouched', () => {
    const events = [
      ev('session_created', { sessionId: 's1', startedAt: '2025-01-15T04:00:00Z', endedAt: '2025-01-15T04:30:00Z', durationMin: 30 }),
      ev('session_created', { sessionId: 's2', startedAt: '2025-01-15T14:00:00Z', endedAt: '2025-01-15T15:00:00Z', durationMin: 60 }),
      ev('session_deleted', { sessionId: 's1' }),
      ev('session_created', { sessionId: 's3', startedAt: '2025-01-15T16:30:00Z', endedAt: '2025-01-15T16:45:00Z', durationMin: 15 }),
    ]
    expect(computeLoggedMinutes(events)).toBe(75)   // s2 (60) + s3 (15); s1 excluded
  })
})

// ── §9.1 — computeSubtreeLoggedMinutes: parent totals roll up the whole subtree ──

describe('§9.1 — computeSubtreeLoggedMinutes rolls up a whole containment subtree', () => {
  beforeAll(async () => { await setupTestDb() })
  afterAll(async () => { await teardownTestDb() })

  const TODAY = '2025-01-15'

  async function makeUser(email: string) {
    return repos.insertUser(getTestPool(), { email })
  }

  it('an item with no children and no sessions returns zero', async () => {
    const u = await makeUser('sessions-domain-empty@test.com')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Solo', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    const total = await computeSubtreeLoggedMinutes(getTestPool(), item.id, TODAY, u.id)
    expect(total).toBe(0)
  })

  it('a grandchild\'s logged time rolls all the way up to the grandparent', async () => {
    const u = await makeUser('sessions-domain-grandchild@test.com')
    const grandparent = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Grandparent', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Parent', recurrenceRule: { type: 'daily' }, parentId: grandparent.id, creationSource: 'planned',
    })
    const child = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Child', recurrenceRule: { type: 'daily' }, parentId: parent.id, creationSource: 'planned',
    })
    await ensureOccurrenceMaterialized(getTestPool(), grandparent, TODAY, u.id)
    await ensureOccurrenceMaterialized(getTestPool(), parent, TODAY, u.id)
    const childOcc = await ensureOccurrenceMaterialized(getTestPool(), child, TODAY, u.id)

    // A single 20-minute manual session logged only on the grandchild-level item.
    await repos.insertEvent(getTestPool(), {
      userId: u.id,
      eventType: 'session_created',
      occurrenceId: childOcc.id,
      itemId: child.id,
      appliesToDay: TODAY,
      payload: {
        sessionId: 'sess-grandchild',
        startedAt: '2025-01-15T04:00:00Z',
        endedAt: '2025-01-15T04:20:00Z',
        durationMin: 20,
      },
    })

    expect(await computeSubtreeLoggedMinutes(getTestPool(), child.id, TODAY, u.id)).toBe(20)
    expect(await computeSubtreeLoggedMinutes(getTestPool(), parent.id, TODAY, u.id)).toBe(20)
    expect(await computeSubtreeLoggedMinutes(getTestPool(), grandparent.id, TODAY, u.id)).toBe(20)
  })
})

// ── §9.1 — findSessionsByOccurrence: per-session listing for the manager UI ──

describe('§9.1 — findSessionsByOccurrence lists individual sessions, excluding deleted ones', () => {
  beforeAll(async () => { await setupTestDb() })
  afterAll(async () => { await teardownTestDb() })

  const TODAY = '2025-01-15'

  async function makeUser(email: string) {
    return repos.insertUser(getTestPool(), { email })
  }

  it('lists multiple manual sessions logged against the same occurrence, and removing one leaves the others intact', async () => {
    const u = await makeUser('sessions-list-multi@test.com')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Piano', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    const windows = [
      { sessionId: 'w1', startedAt: '2025-01-15T10:00:00Z', endedAt: '2025-01-15T10:30:00Z', durationMin: 30 },
      { sessionId: 'w2', startedAt: '2025-01-15T14:00:00Z', endedAt: '2025-01-15T15:00:00Z', durationMin: 60 },
      { sessionId: 'w3', startedAt: '2025-01-15T16:30:00Z', endedAt: '2025-01-15T16:45:00Z', durationMin: 15 },
      { sessionId: 'w4', startedAt: '2025-01-15T18:15:00Z', endedAt: '2025-01-15T18:45:00Z', durationMin: 30 },
    ]
    for (const w of windows) {
      await repos.insertEvent(getTestPool(), {
        userId: u.id, eventType: 'session_created', occurrenceId: occ.id, itemId: item.id,
        appliesToDay: TODAY, payload: w,
      })
    }

    const before = await repos.findSessionsByOccurrence(getTestPool(), occ.id, u.id)
    expect(before.map((s) => s.sessionId).sort()).toEqual(['w1', 'w2', 'w3', 'w4'])

    // Delete the 16:30-16:45 window only.
    await repos.insertEvent(getTestPool(), {
      userId: u.id, eventType: 'session_deleted', occurrenceId: occ.id, itemId: item.id,
      appliesToDay: TODAY, payload: { sessionId: 'w3' },
    })

    const after = await repos.findSessionsByOccurrence(getTestPool(), occ.id, u.id)
    expect(after.map((s) => s.sessionId).sort()).toEqual(['w1', 'w2', 'w4'])
    // The other three windows' recorded durations are untouched by the deletion.
    expect(after.find((s) => s.sessionId === 'w1')!.durationMin).toBe(30)
    expect(after.find((s) => s.sessionId === 'w2')!.durationMin).toBe(60)
    expect(after.find((s) => s.sessionId === 'w4')!.durationMin).toBe(30)
  })

  it('omits an in-progress (started but not stopped) live session', async () => {
    const u = await makeUser('sessions-list-inprogress@test.com')
    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Reading', recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    await repos.insertEvent(getTestPool(), {
      userId: u.id, eventType: 'session_started', occurrenceId: occ.id, itemId: item.id,
      appliesToDay: TODAY, payload: { sessionId: 'running' },
    })

    const sessions = await repos.findSessionsByOccurrence(getTestPool(), occ.id, u.id)
    expect(sessions).toHaveLength(0)
  })
})
