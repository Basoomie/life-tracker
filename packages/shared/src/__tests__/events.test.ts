// §14.2 rule: "the events discriminated union type-checks (a completion event won't
//              accept reschedule fields, etc.)"
//
// These tests verify two things:
//   1. Valid event objects can be constructed for each event category.
//   2. Narrowing on eventType gives the correct payload type at compile time.
//
// Type-level guarantees are confirmed by 'npm run typecheck'.
// Runtime tests confirm the discriminant value is preserved through the union.

import { describe, it, expect } from 'vitest'
import type { TrackerEvent, EventType } from '../types/events'

const BASE = {
  id: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  recordedAt: new Date('2024-01-01T12:00:00Z'),
  appliesToDay: '2024-01-01',
  occurrenceId: '00000000-0000-0000-0000-000000000003',
  itemId: '00000000-0000-0000-0000-000000000004',
} as const

describe('TrackerEvent discriminated union', () => {
  describe('completion / status variants', () => {
    it('item_completed payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'item_completed',
        payload: { completionPercent: 100, completionKind: 'declared' },
      }
      expect(e.eventType).toBe('item_completed')
      if (e.eventType === 'item_completed') {
        expect(e.payload.completionPercent).toBe(100)
        expect(e.payload.completionKind).toBe('declared')
      }
    })

    it('child_completed payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'child_completed',
        payload: { childItemId: 'id-a', childOccurrenceId: 'id-b' },
      }
      if (e.eventType === 'child_completed') {
        expect(e.payload.childItemId).toBe('id-a')
      }
    })

    it('retroactive_completion payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'retroactive_completion',
        payload: { completionPercent: 75, completionKind: 'derived' },
      }
      if (e.eventType === 'retroactive_completion') {
        expect(e.payload.completionPercent).toBe(75)
      }
    })

    it('manual_parent_percent_declared payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'manual_parent_percent_declared',
        payload: { declaredPercent: 80 },
      }
      if (e.eventType === 'manual_parent_percent_declared') {
        expect(e.payload.declaredPercent).toBe(80)
      }
    })
  })

  describe('disposition variants', () => {
    it('skipped payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'skipped',
        payload: { reasonId: 'reason-1', comment: 'too tired' },
      }
      if (e.eventType === 'skipped') {
        expect(e.payload.reasonId).toBe('reason-1')
        expect(e.payload.comment).toBe('too tired')
      }
    })

    it('excused payload accepts null fields', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'excused',
        payload: { reasonId: null, comment: null },
      }
      if (e.eventType === 'excused') {
        expect(e.payload.reasonId).toBeNull()
      }
    })

    it('rescheduled payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'rescheduled',
        payload: { newDay: '2024-01-02', newOccurrenceId: null, reasonId: null, comment: null },
      }
      if (e.eventType === 'rescheduled') {
        expect(e.payload.newDay).toBe('2024-01-02')
      }
    })

    it('auto_closed payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'auto_closed',
        payload: { derivedPercent: 66 },
      }
      if (e.eventType === 'auto_closed') {
        expect(e.payload.derivedPercent).toBe(66)
      }
    })
  })

  describe('time tracking variants', () => {
    it('session_started payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'session_started',
        payload: { sessionId: 'sess-1' },
      }
      if (e.eventType === 'session_started') {
        expect(e.payload.sessionId).toBe('sess-1')
      }
    })

    it('session_created payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'session_created',
        payload: { sessionId: 'sess-2', startedAt: '2024-01-01T10:00:00Z', endedAt: '2024-01-01T11:00:00Z', durationMin: 60 },
      }
      if (e.eventType === 'session_created') {
        expect(e.payload.durationMin).toBe(60)
      }
    })
  })

  describe('structure / config variants', () => {
    it('template_created payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'template_created',
        payload: {
          creationSource: 'planned',
          snapshot: {
            name: 'Test', description: null, categoryId: null, valence: null, priority: null,
            recurrenceRule: { type: 'daily' }, quotaTarget: null, timingPrecision: 'none',
            timingBucketId: null, timingStartTime: null, timingEndTime: null,
            plannedDurationMin: null, dispositionPolicy: 'skip', parentId: null, prerequisiteIds: [],
          },
        },
      }
      if (e.eventType === 'template_created') {
        expect(e.payload.creationSource).toBe('planned')
        expect(e.payload.snapshot.name).toBe('Test')
      }
    })

    it('priority_changed payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        eventType: 'priority_changed',
        payload: { previousPriority: null, newPriority: 'high' },
      }
      if (e.eventType === 'priority_changed') {
        expect(e.payload.newPriority).toBe('high')
        expect(e.payload.previousPriority).toBeNull()
      }
    })

    it('day_start_changed payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        occurrenceId: null,
        itemId: null,
        appliesToDay: null,
        eventType: 'day_start_changed',
        payload: { newValue: '04:00', effectiveFrom: '2024-01-01', previousValue: null },
      }
      if (e.eventType === 'day_start_changed') {
        expect(e.payload.newValue).toBe('04:00')
      }
    })

    it('category_created payload is accessible after narrowing', () => {
      const e: TrackerEvent = {
        ...BASE,
        occurrenceId: null,
        itemId: null,
        appliesToDay: null,
        eventType: 'category_created',
        payload: { categoryId: 'cat-1', name: 'Fitness' },
      }
      if (e.eventType === 'category_created') {
        expect(e.payload.name).toBe('Fitness')
      }
    })
  })

  describe('EventType covers all variants', () => {
    it('all known event type strings are assignable to EventType', () => {
      const allTypes: EventType[] = [
        'item_completed', 'child_completed', 'child_unchecked',
        'retroactive_completion', 'manual_parent_percent_declared',
        'skipped', 'excused', 'rescheduled', 'auto_closed', 'event_reassigned',
        'session_started', 'session_paused', 'session_resumed',
        'session_stopped', 'session_created', 'session_edited',
        'template_created', 'template_edited', 'template_soft_deleted',
        'priority_changed', 'prerequisite_added', 'prerequisite_removed',
        'day_start_changed', 'bucket_boundaries_changed',
        'category_created', 'category_renamed', 'category_archived',
        'reason_created', 'reason_renamed', 'reason_archived',
      ]
      expect(allTypes).toHaveLength(30)
    })
  })
})
