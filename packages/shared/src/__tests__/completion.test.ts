// §6.1–6.4 — Unit tests for pure completion-state functions.
// Named after the spec's stated rules so skimming the test list reads the design back.

import { describe, it, expect } from 'vitest'
import {
  deriveLeafCompletion,
  computeDerivedPercent,
  findDeclaredPercent,
  buildParentCompletionState,
} from '../domain/completion'
import type { TrackerEvent } from '../types/events'

// Minimal event factory — only the fields our pure functions inspect
function makeEvent(
  overrides: Partial<TrackerEvent> & { eventType: TrackerEvent['eventType'] }
): TrackerEvent {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    userId: 'user-1',
    recordedAt: new Date('2025-01-15T10:00:00Z'),
    appliesToDay: '2025-01-15',
    occurrenceId: 'occ-1',
    itemId: 'item-1',
    payload: {},
    ...overrides,
  } as TrackerEvent
}

// ── §6.1 Leaf completion ───────────────────────────────────────────────────────

describe('§6.1 leaf completion is binary — 0% or 100%', () => {
  it('§6.1 leaf starts at 0% when no completion events exist', () => {
    const state = deriveLeafCompletion([])
    expect(state.completionPercent).toBe(0)
    expect(state.completedAt).toBeNull()
    expect(state.wasRetroactive).toBe(false)
  })

  it('§6.1 leaf is 100% when item_completed fires with completionPercent: 100', () => {
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'item_completed',
        payload: { completionPercent: 100, completionKind: 'declared' },
      }),
    ]
    const state = deriveLeafCompletion(events)
    expect(state.completionPercent).toBe(100)
    expect(state.completedAt).toBeInstanceOf(Date)
    expect(state.wasRetroactive).toBe(false)
  })

  it('§6.1 leaf is 0% when latest item_completed has completionPercent: 0 (unchecked)', () => {
    const t1 = new Date('2025-01-15T09:00:00Z')
    const t2 = new Date('2025-01-15T11:00:00Z')
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'item_completed',
        recordedAt: t1,
        payload: { completionPercent: 100, completionKind: 'declared' },
      }),
      makeEvent({
        eventType: 'item_completed',
        recordedAt: t2,
        payload: { completionPercent: 0, completionKind: 'declared' },
      }),
    ]
    const state = deriveLeafCompletion(events)
    expect(state.completionPercent).toBe(0)
  })

  it('§6.1 latest event wins when multiple item_completed events exist', () => {
    const t1 = new Date('2025-01-15T09:00:00Z')
    const t2 = new Date('2025-01-15T10:00:00Z')
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'item_completed',
        recordedAt: t2,
        payload: { completionPercent: 100, completionKind: 'declared' },
      }),
      makeEvent({
        eventType: 'item_completed',
        recordedAt: t1,
        payload: { completionPercent: 0, completionKind: 'declared' },
      }),
    ]
    // Latest by recordedAt is t2 → 100%
    const state = deriveLeafCompletion(events)
    expect(state.completionPercent).toBe(100)
  })
})

// ── §6.4 Retroactive completion ───────────────────────────────────────────────

describe('§6.4 retroactive_completion event is treated as a completion event', () => {
  it('§6.4 retroactive_completion produces 100% completion and sets wasRetroactive', () => {
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'retroactive_completion',
        recordedAt: new Date('2025-01-16T08:00:00Z'),  // next morning
        appliesToDay: '2025-01-15',                      // yesterday's day
        payload: { completionPercent: 100, completionKind: 'declared' },
      }),
    ]
    const state = deriveLeafCompletion(events)
    expect(state.completionPercent).toBe(100)
    expect(state.wasRetroactive).toBe(true)
    expect(state.completedAt).toEqual(new Date('2025-01-16T08:00:00Z'))
  })

  it('§6.4 latest event wins when item_completed fires after retroactive_completion', () => {
    const tRetro  = new Date('2025-01-16T08:00:00Z')
    const tNormal = new Date('2025-01-16T09:00:00Z')
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'retroactive_completion',
        recordedAt: tRetro,
        payload: { completionPercent: 100, completionKind: 'declared' },
      }),
      makeEvent({
        eventType: 'item_completed',
        recordedAt: tNormal,
        payload: { completionPercent: 0, completionKind: 'declared' },
      }),
    ]
    // tNormal is later → item_completed at 0% wins → not retroactive, not complete
    const state = deriveLeafCompletion(events)
    expect(state.completionPercent).toBe(0)
    expect(state.wasRetroactive).toBe(false)
  })
})

// ── §6.1 Derived parent % ─────────────────────────────────────────────────────

describe('§6.1 computeDerivedPercent: correct derivation from child counts', () => {
  it('§6.1 zero due children → 100% (parent complete when no children are scheduled)', () => {
    expect(computeDerivedPercent(0, 0)).toBe(100)
  })

  it('§6.1 all due children completed → 100%', () => {
    expect(computeDerivedPercent(3, 3)).toBe(100)
  })

  it('§6.1 no due children completed → 0%', () => {
    expect(computeDerivedPercent(3, 0)).toBe(0)
  })

  it('§6.1 partial completion → correct rounded %', () => {
    expect(computeDerivedPercent(3, 1)).toBe(33)  // Math.round(1/3 * 100)
    expect(computeDerivedPercent(2, 1)).toBe(50)
    expect(computeDerivedPercent(4, 3)).toBe(75)
  })
})

// ── §6.2 Declared parent % ────────────────────────────────────────────────────

describe('§6.2 declared parent % coexists with derived % and can diverge', () => {
  it('§6.2 findDeclaredPercent returns null when no manual_parent_percent_declared event', () => {
    const events: TrackerEvent[] = [
      makeEvent({ eventType: 'item_completed', payload: { completionPercent: 100, completionKind: 'derived' } }),
    ]
    expect(findDeclaredPercent(events)).toBeNull()
    expect(findDeclaredPercent([])).toBeNull()
  })

  it('§6.2 findDeclaredPercent returns the latest declared %', () => {
    const t1 = new Date('2025-01-15T08:00:00Z')
    const t2 = new Date('2025-01-15T09:00:00Z')
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'manual_parent_percent_declared',
        recordedAt: t1,
        payload: { declaredPercent: 50 },
      }),
      makeEvent({
        eventType: 'manual_parent_percent_declared',
        recordedAt: t2,
        payload: { declaredPercent: 80 },
      }),
    ]
    expect(findDeclaredPercent(events)).toBe(80)
  })

  it('§6.2 buildParentCompletionState: derived and declared coexist and can diverge', () => {
    const events: TrackerEvent[] = [
      makeEvent({
        eventType: 'manual_parent_percent_declared',
        payload: { declaredPercent: 75 },
      }),
    ]
    // derivedPercent = 50 (e.g. 1 of 2 children done), declared = 75
    const state = buildParentCompletionState(50, events)
    expect(state.derivedPercent).toBe(50)
    expect(state.declaredPercent).toBe(75)
    expect(state.displayPercent).toBe(75)   // declared takes precedence in display
    expect(state.isComplete).toBe(true)      // declared is set → considered complete
  })

  it('§6.2 displayPercent falls back to derivedPercent when no declared % set', () => {
    const state = buildParentCompletionState(66, [])
    expect(state.declaredPercent).toBeNull()
    expect(state.displayPercent).toBe(66)
    expect(state.isComplete).toBe(false)     // 66% derived, no declared → not complete
  })

  it('§6.2 parent is complete when derivedPercent reaches 100, even without declared %', () => {
    const state = buildParentCompletionState(100, [])
    expect(state.isComplete).toBe(true)
  })
})
