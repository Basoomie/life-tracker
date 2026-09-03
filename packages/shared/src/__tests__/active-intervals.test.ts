// §5.6 — Active / inactive items: the paused-interval replay.
//
// Tests are named after the spec's stated rules.
//
// This module is the reason a pause does not read as failure: every v2 window is
// filtered through it (design-v2 §9.1.1.b), so a wrong answer here silently reshapes
// adherence, streaks, day-of-week, trajectory and autocorrelation at once. It is pure,
// so it is tested exhaustively here rather than through the database.

import { describe, it, expect } from 'vitest'
import { pausedIntervalsFromEvents, isDayPaused } from '../domain/active-intervals'
import type { TrackerEvent } from '../types/events'

// Minimal event builders. Only eventType, recordedAt and appliesToDay matter to the
// replay; the rest is filled to satisfy the type.
let seq = 0
function transition(
  eventType: 'template_deactivated' | 'template_reactivated',
  appliesToDay: string | null,
  recordedAt = new Date(`${appliesToDay ?? '2025-01-01'}T12:00:00Z`)
): TrackerEvent {
  const base = {
    id: `e-${seq++}`,
    userId: 'u1',
    recordedAt,
    appliesToDay,
    occurrenceId: null,
    itemId: 'item-a',
  }
  return eventType === 'template_deactivated'
    ? { ...base, eventType, payload: { cascadedFrom: null, clearedFutureOccurrences: 0 } }
    : { ...base, eventType, payload: { cascadedFrom: null } }
}

// An unrelated template event, to prove the filter is doing its job.
function noise(): TrackerEvent {
  return {
    id: `e-${seq++}`,
    userId: 'u1',
    recordedAt: new Date('2025-02-01T12:00:00Z'),
    appliesToDay: null,
    occurrenceId: null,
    itemId: 'item-a',
    eventType: 'template_edited',
    payload: { changes: { name: 'renamed' } },
  }
}

describe('§5.6 — paused intervals are derived by replay, not read from a flag', () => {
  it('an item that was never deactivated has no paused intervals', () => {
    expect(pausedIntervalsFromEvents([])).toEqual([])
    expect(pausedIntervalsFromEvents([noise()])).toEqual([])
  })

  it('a deactivation with no reactivation is an open-ended interval', () => {
    const intervals = pausedIntervalsFromEvents([transition('template_deactivated', '2025-03-03')])
    expect(intervals).toEqual([{ start: '2025-03-03', end: null }])
  })

  it('a deactivate/reactivate pair is a closed interval', () => {
    const intervals = pausedIntervalsFromEvents([
      transition('template_deactivated', '2025-03-03'),
      transition('template_reactivated', '2025-04-10'),
    ])
    expect(intervals).toEqual([{ start: '2025-03-03', end: '2025-04-10' }])
  })

  it('several pauses over an item lifetime replay as several intervals', () => {
    const intervals = pausedIntervalsFromEvents([
      transition('template_deactivated', '2025-01-05'),
      transition('template_reactivated', '2025-01-20'),
      transition('template_deactivated', '2025-06-01'),
      transition('template_reactivated', '2025-07-01'),
      transition('template_deactivated', '2025-12-01'),
    ])
    expect(intervals).toEqual([
      { start: '2025-01-05', end: '2025-01-20' },
      { start: '2025-06-01', end: '2025-07-01' },
      { start: '2025-12-01', end: null },
    ])
  })

  it('replays in recorded order regardless of the order events arrive in', () => {
    const deactivated = transition('template_deactivated', '2025-03-03')
    const reactivated = transition('template_reactivated', '2025-04-10')
    expect(pausedIntervalsFromEvents([reactivated, deactivated])).toEqual([
      { start: '2025-03-03', end: '2025-04-10' },
    ])
  })

  it('ignores events that are not deactivation transitions', () => {
    const intervals = pausedIntervalsFromEvents([
      noise(),
      transition('template_deactivated', '2025-03-03'),
      noise(),
    ])
    expect(intervals).toEqual([{ start: '2025-03-03', end: null }])
  })
})

describe('§5.6 — the derivation absorbs an untidy log rather than trusting it', () => {
  it('a second deactivation while already paused does not restart the interval', () => {
    const intervals = pausedIntervalsFromEvents([
      transition('template_deactivated', '2025-03-03'),
      transition('template_deactivated', '2025-03-20'),
      transition('template_reactivated', '2025-04-10'),
    ])
    expect(intervals).toEqual([{ start: '2025-03-03', end: '2025-04-10' }])
  })

  it('a reactivation while already active is a no-op', () => {
    const intervals = pausedIntervalsFromEvents([
      transition('template_reactivated', '2025-02-01'),
      transition('template_deactivated', '2025-03-03'),
    ])
    expect(intervals).toEqual([{ start: '2025-03-03', end: null }])
  })

  it('a transition with no applies-to day is skipped, never placed by guesswork', () => {
    const intervals = pausedIntervalsFromEvents([
      transition('template_deactivated', null),
      transition('template_deactivated', '2025-03-03'),
    ])
    expect(intervals).toEqual([{ start: '2025-03-03', end: null }])
  })
})

describe('§5.6 — intervals are half-open: the start day is paused, the end day is not', () => {
  const intervals = pausedIntervalsFromEvents([
    transition('template_deactivated', '2025-03-03'),
    transition('template_reactivated', '2025-04-10'),
  ])

  it('the day before the pause is not paused', () => {
    expect(isDayPaused('2025-03-02', intervals)).toBe(false)
  })

  it('the deactivation day itself is paused', () => {
    expect(isDayPaused('2025-03-03', intervals)).toBe(true)
  })

  it('a day inside the pause is paused', () => {
    expect(isDayPaused('2025-03-21', intervals)).toBe(true)
  })

  it('the reactivation day is already active again', () => {
    expect(isDayPaused('2025-04-10', intervals)).toBe(false)
  })

  it('deactivating and reactivating on the same day pauses nothing', () => {
    const sameDay = pausedIntervalsFromEvents([
      transition('template_deactivated', '2025-03-03', new Date('2025-03-03T09:00:00Z')),
      transition('template_reactivated', '2025-03-03', new Date('2025-03-03T17:00:00Z')),
    ])
    expect(sameDay).toEqual([{ start: '2025-03-03', end: '2025-03-03' }])
    expect(isDayPaused('2025-03-03', sameDay)).toBe(false)
  })

  it('an open-ended pause covers every day from its start onward', () => {
    const open = pausedIntervalsFromEvents([transition('template_deactivated', '2025-03-03')])
    expect(isDayPaused('2025-03-03', open)).toBe(true)
    expect(isDayPaused('2099-01-01', open)).toBe(true)
    expect(isDayPaused('2025-03-02', open)).toBe(false)
  })
})
