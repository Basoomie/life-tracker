// §9.1.1 — Observation-array seam.
//
// These functions are the "domain replay" side of the seam: they access the DB,
// replay events, and produce plain observation arrays.  Statistical calculators
// (the "statistics side") consume those arrays as pure functions with zero domain
// knowledge and zero DB access.
//
// All v1 subtlety is applied here before the arrays are emitted:
//   • getDueDays  — determines which days an item is due (not reimplemented)
//   • deriveLeafCompletion  — determines leaf 0/100% (not reimplemented)
//   • computeDerivedPercent — parent derived % from due children (not reimplemented)
//   • findDeclaredPercent   — manual parent overrides (not reimplemented)
//   • Excused handling, day-start bucketing, not-due-child exclusion all applied here.

import type { Pool } from 'pg'
import type { Item, Occurrence } from '@tracker/shared'
import {
  getDueDays,
  deriveLeafCompletion,
  computeDerivedPercent,
  findDeclaredPercent,
} from '@tracker/shared'
import type { TrackerEvent } from '@tracker/shared'
import * as repos from '../../db/repos/index'
import type {
  DayObservation,
  DayDisposition,
  ChildObservationMap,
  SessionObservation,
  RescheduleObservation,
  BackfillObservation,
} from '../types'
import type { DateWindow } from '@tracker/shared'

// ── Helpers ──────────────────────────────────────────────────────────────────

function anchorDate(item: Item): string {
  return item.createdAt.toISOString().slice(0, 10)
}

// Disposition event types — matches enrichOccurrence logic in routes/helpers.ts.
const DISPOSITION_TYPES = new Set([
  'item_completed', 'retroactive_completion',
  'skipped', 'excused', 'rescheduled', 'auto_closed',
])

// Derive the final disposition outcome from an occurrence's event stream.
// Most-recent disposition event wins (same logic as enrichOccurrence).
function deriveDisposition(occ: Occurrence | undefined, events: TrackerEvent[]): DayDisposition {
  if (!occ) return 'missing'
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!DISPOSITION_TYPES.has(e.eventType)) continue
    const p = e.payload as Record<string, unknown>
    if (e.eventType === 'item_completed' || e.eventType === 'retroactive_completion') {
      return ((p['completionPercent'] as number) ?? 0) >= 100 ? 'completed' : 'pending'
    }
    if (e.eventType === 'skipped')    return 'skipped'
    if (e.eventType === 'excused')    return 'excused'
    if (e.eventType === 'rescheduled') return 'rescheduled'
    if (e.eventType === 'auto_closed') return 'auto_closed'
    break
  }
  return 'pending'
}

// Derive backfill info from the event stream for the given applies_to_day.
// isBackfilled = the final completion was a retroactive_completion event.
// lagDays = calendar days from day midnight UTC to recordedAt.
function deriveBackfill(events: TrackerEvent[], day: string): { isBackfilled: boolean; backfillLagDays: number } {
  let latest: TrackerEvent | null = null
  for (const e of events) {
    if (e.eventType === 'item_completed' || e.eventType === 'retroactive_completion') {
      if (!latest || e.recordedAt > latest.recordedAt) latest = e
    }
  }
  if (!latest || latest.eventType !== 'retroactive_completion') {
    return { isBackfilled: false, backfillLagDays: 0 }
  }
  const dayMs = new Date(day + 'T00:00:00Z').getTime()
  const lagDays = Math.max(0, Math.round((latest.recordedAt.getTime() - dayMs) / 86_400_000))
  return { isBackfilled: true, backfillLagDays: lagDays }
}

// Build a single DayObservation for a leaf occurrence (or a missing day).
function buildLeafDayObs(
  day: string,
  occ: Occurrence | undefined,
  events: TrackerEvent[]
): DayObservation {
  if (!occ) {
    return { day, completionPercent: 0, disposition: 'missing', declaredPercent: null, isBackfilled: false, backfillLagDays: 0 }
  }
  const state = deriveLeafCompletion(events)
  const disposition = deriveDisposition(occ, events)
  const { isBackfilled, backfillLagDays } = deriveBackfill(events, day)
  return {
    day,
    completionPercent: state.completionPercent,
    disposition,
    declaredPercent: null,
    isBackfilled,
    backfillLagDays,
  }
}

// ── Public observation builders ───────────────────────────────────────────────

/**
 * Build DayObservation[] for a LEAF item (no children) over the given window.
 * Uses getDueDays (v1 domain) for recurring items — not reimplemented.
 * Bulk-fetches occurrences and events to avoid N+1 queries.
 */
export async function buildLeafDayObservations(
  pool: Pool,
  userId: string,
  item: Item,
  window: DateWindow
): Promise<DayObservation[]> {
  const { startDay, endDay } = window

  // Determine due days
  let dueDays: string[]
  if (item.recurrenceRule) {
    dueDays = getDueDays(item.recurrenceRule, startDay, endDay, anchorDate(item))
  } else {
    // One-time task: due on its occurrence day (if any) within the window
    const occs = await repos.findOccurrencesByItemsInRange(pool, [item.id], userId, startDay, endDay)
    dueDays = occs.map(o => o.appliesToDay)
  }

  if (dueDays.length === 0) return []

  // Bulk-fetch occurrences and events
  const occs = await repos.findOccurrencesByItemsInRange(pool, [item.id], userId, startDay, endDay)
  const occByDay = new Map<string, Occurrence>()
  for (const o of occs) occByDay.set(o.appliesToDay, o)

  const occIds = occs.map(o => o.id)
  const eventsMap = await repos.findEventsByOccurrenceIds(pool, occIds, userId)

  return dueDays.map(day => {
    const occ = occByDay.get(day)
    const events = occ ? (eventsMap.get(occ.id) ?? []) : []
    return buildLeafDayObs(day, occ, events)
  })
}

/**
 * Build DayObservation[] for a PARENT item and ChildObservationMap for each child.
 *
 * Parent completionPercent = derived % per §6.1 (from children's completions).
 * Not-due children are excluded from the denominator (§6.1 — the Tuesday/MWF case).
 * Uses getDueDays for child due-day computation — not reimplemented.
 * Bulk-fetches all occurrences and events in one round trip.
 */
export async function buildParentDayObservations(
  pool: Pool,
  userId: string,
  parentItem: Item,
  window: DateWindow
): Promise<{ parentObs: DayObservation[]; childObs: ChildObservationMap }> {
  const { startDay, endDay } = window

  // Parent due days
  const parentDueDays = parentItem.recurrenceRule
    ? getDueDays(parentItem.recurrenceRule, startDay, endDay, anchorDate(parentItem))
    : []

  // Get children (active only)
  const children = await repos.findChildItems(pool, parentItem.id, userId)

  // Compute each child's due days in the window (getDueDays — not reimplemented)
  const childDueDaysMap = new Map<string, Set<string>>()
  for (const child of children) {
    if (child.recurrenceRule) {
      const days = getDueDays(child.recurrenceRule, startDay, endDay, anchorDate(child))
      childDueDaysMap.set(child.id, new Set(days))
    } else {
      childDueDaysMap.set(child.id, new Set())  // one-time task: resolved below
    }
  }

  // Bulk-fetch all occurrences (parent + children) in the window
  const allItemIds = [parentItem.id, ...children.map(c => c.id)]
  const allOccs = await repos.findOccurrencesByItemsInRange(pool, allItemIds, userId, startDay, endDay)

  // Build occ lookup: 'itemId:day' → Occurrence
  const occMap = new Map<string, Occurrence>()
  for (const occ of allOccs) occMap.set(`${occ.itemId}:${occ.appliesToDay}`, occ)

  // For one-time task children: due on the day their occurrence exists
  for (const child of children) {
    if (!child.recurrenceRule) {
      const childOccs = allOccs.filter(o => o.itemId === child.id)
      const days = new Set(childOccs.map(o => o.appliesToDay))
      childDueDaysMap.set(child.id, days)
    }
  }

  // Bulk-fetch all events for all occurrences in the window
  const allOccIds = allOccs.map(o => o.id)
  const eventsMap = await repos.findEventsByOccurrenceIds(pool, allOccIds, userId)

  // Build child observations (each child's due days in the window)
  const childObs: ChildObservationMap = new Map()
  for (const child of children) {
    const dueDays = Array.from(childDueDaysMap.get(child.id) ?? []).sort()
    const obs: DayObservation[] = dueDays.map(day => {
      const occ = occMap.get(`${child.id}:${day}`)
      const events = occ ? (eventsMap.get(occ.id) ?? []) : []
      return buildLeafDayObs(day, occ, events)
    })
    childObs.set(child.id, obs)
  }

  // Build parent observations — derived % from children on each due day
  const parentObs: DayObservation[] = parentDueDays.map(day => {
    const parentOcc = occMap.get(`${parentItem.id}:${day}`)
    const parentEvents = parentOcc ? (eventsMap.get(parentOcc.id) ?? []) : []

    // Count due and completed children on this day (§6.1 not-due exclusion)
    let dueCount = 0
    let completedCount = 0
    for (const child of children) {
      const isDue = (childDueDaysMap.get(child.id) ?? new Set()).has(day)
      if (!isDue) continue
      dueCount++
      const childOcc = occMap.get(`${child.id}:${day}`)
      if (childOcc) {
        const childEvents = eventsMap.get(childOcc.id) ?? []
        if (deriveLeafCompletion(childEvents).completionPercent >= 100) completedCount++
      }
    }

    const derivedPercent = computeDerivedPercent(dueCount, completedCount)
    const declaredPercent = findDeclaredPercent(parentEvents)
    const disposition = deriveDisposition(parentOcc, parentEvents)

    return {
      day,
      completionPercent: derivedPercent,
      disposition: parentOcc ? disposition : 'missing',
      declaredPercent,
      isBackfilled: false,   // parent completion isn't backfilled in the same way
      backfillLagDays: 0,
    }
  })

  return { parentObs, childObs }
}

/**
 * Build SessionObservation[] for all completed sessions in the window.
 * Optionally filtered to a specific itemId or categoryId.
 */
export async function buildSessionObservations(
  pool: Pool,
  userId: string,
  window: DateWindow,
  filter?: { itemId?: string; categoryId?: string }
): Promise<SessionObservation[]> {
  const { startDay, endDay } = window

  // Get all session summaries in the window
  const summaries = await repos.findSessionSummaries(pool, userId, startDay, endDay, filter?.itemId)

  if (summaries.length === 0) return []

  // Bulk-load items for enrichment (creationSource, valence, categoryId, plannedDuration)
  const allItems = await repos.findItemsByUser(pool, userId)
  const itemMap = new Map(allItems.map(i => [i.id, i]))

  const results: SessionObservation[] = []
  for (const s of summaries) {
    const item = itemMap.get(s.itemId)
    if (!item) continue  // archived item — skip

    // Apply optional category filter
    if (filter?.categoryId && item.categoryId !== filter.categoryId) continue

    results.push({
      sessionId: s.sessionId,
      day: s.appliesToDay,
      durationMin: s.durationMin,
      startedAt: s.startedAt,
      source: s.source,
      isAdHoc: item.creationSource === 'ad_hoc',
      categoryId: item.categoryId,
      valence: item.valence,
      plannedDurationMin: item.plannedDurationMin,
      itemId: item.id,
    })
  }
  return results
}

/**
 * Build RescheduleObservation[] for an item in the window.
 * Used by the procrastination calculator.
 */
export async function buildRescheduleObservations(
  pool: Pool,
  userId: string,
  itemId: string,
  window: DateWindow
): Promise<RescheduleObservation[]> {
  const rows = await repos.findRescheduleEventsByRange(pool, userId, window.startDay, window.endDay, itemId)
  return rows.map(r => ({
    originalDay: r.originalDay,
    newDay: r.newDay,
    recordedAt: r.recordedAt,
    reasonId: r.reasonId,
  }))
}

/**
 * Build BackfillObservation[] for a user (or specific item) in the window.
 * Used by both the procrastination and data-quality calculators.
 */
export async function buildBackfillObservations(
  pool: Pool,
  userId: string,
  window: DateWindow,
  itemId?: string
): Promise<BackfillObservation[]> {
  const rows = await repos.findRetroactiveCompletionsByRange(pool, userId, window.startDay, window.endDay, itemId)
  return rows.map(r => {
    const dayMs = new Date(r.day + 'T00:00:00Z').getTime()
    const lagDays = Math.max(0, Math.round((r.recordedAt.getTime() - dayMs) / 86_400_000))
    return { day: r.day, recordedAt: r.recordedAt, lagDays, itemId: r.itemId }
  })
}
