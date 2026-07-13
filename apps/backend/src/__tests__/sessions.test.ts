// §9.1 — Pure session-duration domain logic. No DB: TrackerEvent fixtures only.

import { describe, it, expect } from 'vitest'
import { computeLoggedMinutes } from '../domain/sessions'
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
})
