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
  itemAnchorDate,
  deriveLeafCompletion,
  computeDerivedPercent,
  computeNodePercent,
  findDeclaredPercent,
} from '@tracker/shared'
import type { TrackerEvent, CompletionNode } from '@tracker/shared'
import * as repos from '../../db/repos/index'
import { deriveDisposition as deriveOccurrenceDisposition } from '../../domain/dispositions'
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

// Derive the final disposition outcome from an occurrence's event stream.
// Delegates to the same domain replay used by enrichOccurrence (routes/helpers.ts)
// so a user-initiated clearDispositionByUser undo (disposition_cleared event) is
// honored identically here — a cleared skip/excuse/carry-forward reads as
// 'pending' for stats purposes too, not still counted as a miss.
function deriveDisposition(occ: Occurrence | undefined, events: TrackerEvent[]): DayDisposition {
  if (!occ) return 'missing'
  return deriveOccurrenceDisposition(events).type
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
    dueDays = getDueDays(item.recurrenceRule, startDay, endDay, itemAnchorDate(item))
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

// Everything the in-memory tree walk needs, bulk-loaded up front so the walk
// itself does zero I/O (and stays a mirror of domain/completion.ts's walk).
type SubtreeContext = {
  childrenByParent: Map<string, Item[]>   // itemId → its direct children
  dueDays: Map<string, Set<string>>       // itemId → days it was due in the window
  occs: Map<string, Occurrence>           // `${itemId}:${day}` → occurrence
  events: Map<string, TrackerEvent[]>     // occurrenceId → its events
}

function eventsFor(itemId: string, day: string, ctx: SubtreeContext): TrackerEvent[] {
  const occ = ctx.occs.get(`${itemId}:${day}`)
  return occ ? (ctx.events.get(occ.id) ?? []) : []
}

/**
 * §6.1 — Due, non-excused children of `itemId` on `day`, as CompletionNodes.
 *
 * The stats-side twin of buildDueChildNodes in domain/completion.ts: same rule
 * (recurse into sub-parents, drop not-due and excused children), different data
 * access — that one queries lazily per day, this one walks pre-loaded maps over
 * a whole window. Both hand the result to the same pure computeNodePercent, so
 * a stat can never disagree with what the app showed on the day.
 */
function buildDueChildNodes(itemId: string, day: string, ctx: SubtreeContext): CompletionNode[] {
  const nodes: CompletionNode[] = []
  for (const child of ctx.childrenByParent.get(itemId) ?? []) {
    if (!ctx.dueDays.get(child.id)?.has(day)) continue
    const events = eventsFor(child.id, day, ctx)
    // §8.1 — an excused child is out of the denominator entirely, not a zero.
    if (deriveOccurrenceDisposition(events).type === 'excused') continue
    nodes.push(buildNode(child.id, day, events, ctx))
  }
  return nodes
}

function buildNode(itemId: string, day: string, events: TrackerEvent[], ctx: SubtreeContext): CompletionNode {
  const hasChildren = (ctx.childrenByParent.get(itemId) ?? []).length > 0
  return {
    isParent: hasChildren,
    leafPercent: deriveLeafCompletion(events).completionPercent,
    declaredPercent: findDeclaredPercent(events),
    dueChildren: hasChildren ? buildDueChildNodes(itemId, day, ctx) : [],
  }
}

/**
 * Load the whole containment subtree under `rootItemId` (nested arbitrarily
 * deep, §5) — the parent's derived % depends on every level, not just the
 * direct children. `seen` guards a malformed parent_id cycle.
 */
async function collectSubtree(
  pool: Pool,
  userId: string,
  rootItemId: string
): Promise<{ descendants: Item[]; childrenByParent: Map<string, Item[]> }> {
  const childrenByParent = new Map<string, Item[]>()
  const descendants: Item[] = []
  const queue = [rootItemId]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const itemId = queue.shift()!
    if (seen.has(itemId)) continue
    seen.add(itemId)
    const children = await repos.findChildItems(pool, itemId, userId)
    childrenByParent.set(itemId, children)
    for (const child of children) {
      descendants.push(child)
      queue.push(child.id)
    }
  }

  return { descendants, childrenByParent }
}

/**
 * Build DayObservation[] for a PARENT item and ChildObservationMap for each
 * direct child.
 *
 * Parent completionPercent = derived % per §6.1: the mean of its due children's
 * own values, with sub-parents contributing their own (declared ?? derived)
 * percentage rather than a binary 0. Not-due children are excluded from the
 * denominator (§6.1 — the Tuesday/MWF case), and so are excused ones (§8.1).
 * Uses getDueDays for due-day computation — not reimplemented.
 * Bulk-fetches all occurrences and events for the subtree in one round trip.
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
    ? getDueDays(parentItem.recurrenceRule, startDay, endDay, itemAnchorDate(parentItem))
    : []

  // Whole subtree (active only), plus the direct children the breakdown reports on
  const { descendants, childrenByParent } = await collectSubtree(pool, userId, parentItem.id)
  const children = childrenByParent.get(parentItem.id) ?? []

  // Compute every descendant's due days in the window (getDueDays — not reimplemented)
  const dueDaysMap = new Map<string, Set<string>>()
  for (const item of descendants) {
    if (item.recurrenceRule) {
      const days = getDueDays(item.recurrenceRule, startDay, endDay, itemAnchorDate(item))
      dueDaysMap.set(item.id, new Set(days))
    } else {
      dueDaysMap.set(item.id, new Set())  // one-time task: resolved below
    }
  }

  // Bulk-fetch all occurrences (parent + whole subtree) in the window
  const allItemIds = [parentItem.id, ...descendants.map(d => d.id)]
  const allOccs = await repos.findOccurrencesByItemsInRange(pool, allItemIds, userId, startDay, endDay)

  // Build occ lookup: 'itemId:day' → Occurrence
  const occMap = new Map<string, Occurrence>()
  for (const occ of allOccs) occMap.set(`${occ.itemId}:${occ.appliesToDay}`, occ)

  // For one-time tasks: due on the day their occurrence exists
  for (const item of descendants) {
    if (!item.recurrenceRule) {
      const itemOccs = allOccs.filter(o => o.itemId === item.id)
      dueDaysMap.set(item.id, new Set(itemOccs.map(o => o.appliesToDay)))
    }
  }

  // Bulk-fetch all events for all occurrences in the window
  const allOccIds = allOccs.map(o => o.id)
  const eventsMap = await repos.findEventsByOccurrenceIds(pool, allOccIds, userId)

  const ctx: SubtreeContext = {
    childrenByParent,
    dueDays: dueDaysMap,
    occs: occMap,
    events: eventsMap,
  }

  // Build child observations (each direct child's due days in the window).
  // A child that is itself a parent reports its own value (declared ?? derived,
  // §6.3) — the same number it contributed to the parent above, so the breakdown
  // can never disagree with the total it feeds.
  const childObs: ChildObservationMap = new Map()
  for (const child of children) {
    const dueDays = Array.from(dueDaysMap.get(child.id) ?? []).sort()
    const hasChildren = (childrenByParent.get(child.id) ?? []).length > 0
    const obs: DayObservation[] = dueDays.map(day => {
      const occ = occMap.get(`${child.id}:${day}`)
      const events = occ ? (eventsMap.get(occ.id) ?? []) : []
      if (!hasChildren) return buildLeafDayObs(day, occ, events)
      return {
        day,
        completionPercent: computeNodePercent(buildNode(child.id, day, events, ctx)),
        disposition: deriveDisposition(occ, events),
        declaredPercent: findDeclaredPercent(events),
        isBackfilled: false,
        backfillLagDays: 0,
      }
    })
    childObs.set(child.id, obs)
  }

  // Build parent observations — derived % from children on each due day
  const parentObs: DayObservation[] = parentDueDays.map(day => {
    const parentOcc = occMap.get(`${parentItem.id}:${day}`)
    const parentEvents = parentOcc ? (eventsMap.get(parentOcc.id) ?? []) : []

    const derivedPercent = computeDerivedPercent(
      buildDueChildNodes(parentItem.id, day, ctx).map(computeNodePercent)
    )
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
