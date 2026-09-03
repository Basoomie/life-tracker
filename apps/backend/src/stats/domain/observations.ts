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
import type { Item, ItemSchedule, Occurrence, RecurrenceRule } from '@tracker/shared'
import {
  getItemDueSlots,
  getItemDueDays,
  pausedIntervalsFromEvents,
  isDayPaused,
  scheduleAnchorDate,
  deriveLeafCompletion,
  computeDerivedPercent,
  computeNodePercent,
  findDeclaredPercent,
} from '@tracker/shared'
import type { TrackerEvent, CompletionNode, PausedInterval } from '@tracker/shared'
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
    return {
      day, completionPercent: 0, disposition: 'missing', declaredPercent: null,
      isBackfilled: false, backfillLagDays: 0,
      slotsDue: 1, slotsCompleted: 0, slotsExcused: 0,
    }
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
    slotsDue: 1,
    slotsCompleted: state.completionPercent >= 100 ? 1 : 0,
    slotsExcused: disposition === 'excused' ? 1 : 0,
  }
}

// ── §5.5 / v2 §9.1.1.a — the day-fold ────────────────────────────────────────
//
// An item can be due in several slots on one day.  The seam's contract is that a DAY
// is one observation whatever the slot count, so the fold happens here — before the
// array exists — and every calculator downstream is untouched by multiple schedules.

// Ordered by engagement: a day on which any slot was genuinely engaged is not a
// missed day.  Used to pick the day's disposition from its remaining slots.
const DISPOSITION_PRECEDENCE: DayDisposition[] = [
  'completed', 'pending', 'rescheduled', 'auto_closed', 'skipped', 'missing',
]

function mostEngaged(dispositions: DayDisposition[]): DayDisposition {
  for (const candidate of DISPOSITION_PRECEDENCE) {
    if (dispositions.includes(candidate)) return candidate
  }
  return 'missing'
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * §5.5 — Collapse one day's slot observations into the single DayObservation the
 * statistics side consumes.
 *
 * - Excused slots leave the denominator rather than scoring zero (§8.1).
 * - All slots excused → the day itself is excused and leaves the denominator too,
 *   exactly as a fully-excused single-slot day always has.
 * - completionPercent is the MEAN of the remaining slots (§6.1's rule for due
 *   children, applied to slots).
 * - Backfill is true if any slot was backfilled; the lag is the longest.
 *
 * A single-slot day folds to itself, unchanged — which is why this is safe to apply
 * unconditionally.
 */
function foldDay(day: string, slots: DayObservation[]): DayObservation {
  if (slots.length === 1) return slots[0]

  const nonExcused = slots.filter((s) => s.disposition !== 'excused')
  const counted = nonExcused.length > 0 ? nonExcused : slots

  return {
    day,
    completionPercent: mean(counted.map((s) => s.completionPercent)),
    disposition: nonExcused.length === 0 ? 'excused' : mostEngaged(counted.map((s) => s.disposition)),
    // A declared % belongs to a parent occurrence, and a parent carries at most one
    // slot (§5.5) — so a multi-slot day never has one to carry up.
    declaredPercent: null,
    isBackfilled: counted.some((s) => s.isBackfilled),
    backfillLagDays: Math.max(0, ...counted.map((s) => s.backfillLagDays)),
    // Raw counts describe the whole day, excused slots included — they are the record
    // of what was there, not an input to the day's percentage. Summed over `slots`,
    // not `counted`, for exactly that reason.
    slotsDue: slots.reduce((n, s) => n + s.slotsDue, 0),
    slotsCompleted: slots.reduce((n, s) => n + s.slotsCompleted, 0),
    slotsExcused: slots.reduce((n, s) => n + s.slotsExcused, 0),
  }
}

// Group per-slot observations by day, preserving day order, and fold each group.
function foldSlotsIntoDays(slotObs: DayObservation[]): DayObservation[] {
  const byDay = new Map<string, DayObservation[]>()
  for (const obs of slotObs) {
    const list = byDay.get(obs.day)
    if (list) list.push(obs)
    else byDay.set(obs.day, [obs])
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, slots]) => foldDay(day, slots))
}

// ── §5.5 — schedule-derived facts the stats layer needs about an item ─────────

/**
 * §5.5 — The recurrence an item presents for scope classification (day-of-week).
 *
 * One recurring slot → that slot's rule, unchanged.  Several → the item is due on the
 * UNION of their days, expressed as a weekly rule when every slot is weekly-shaped.
 * An interval/monthly slot has no weekday pattern to union, so the item's combined
 * shape is reported as that slot's rule, which classifies as not-detectable rather
 * than pretending to a pattern the item does not have.
 */
export function effectiveRecurrenceRule(schedules: ItemSchedule[]): RecurrenceRule | null {
  const rules = schedules
    .map((s) => s.recurrenceRule)
    .filter((r): r is RecurrenceRule => r !== null)

  if (rules.length === 0) return null
  if (rules.length === 1) return rules[0]

  const days = new Set<number>()
  for (const rule of rules) {
    if (rule.type === 'daily') {
      for (let d = 0; d < 7; d++) days.add(d)
    } else if (rule.type === 'days_of_week') {
      for (const d of rule.days) days.add(d)
    } else {
      return rule
    }
  }
  return days.size === 7
    ? { type: 'daily' }
    : { type: 'days_of_week', days: Array.from(days).sort((a, b) => a - b) }
}

/**
 * §5.5 / §6.8 — The item's planned minutes for a day it is due.
 *
 * Sums the item's slots: an item planning 60 minutes at 8:30 and 60 at 13:00 plans
 * 120 minutes on a day both are due.  On days when only some slots are due this
 * overstates the baseline — an acknowledged extension of the per-day simplification
 * computeTimeStats already documents, not a new one.
 */
export function itemPlannedDurationMin(schedules: ItemSchedule[]): number | null {
  const durations = schedules
    .map((s) => s.plannedDurationMin)
    .filter((d): d is number => d !== null)
  if (durations.length === 0) return null
  return durations.reduce((sum, d) => sum + d, 0)
}

/**
 * §5.5 — The earliest day any of the item's slots could have been due, used as the
 * open end of a whole-history window.
 */
export function itemEarliestAnchor(item: Item, schedules: ItemSchedule[]): string {
  const anchors = schedules.map((s) => scheduleAnchorDate(s, item))
  if (anchors.length === 0) return item.createdAt.toISOString().slice(0, 10)
  return anchors.reduce((earliest, a) => (a < earliest ? a : earliest))
}

// ── §5.6 / v2 §9.1.1.b — paused days leave the window ─────────────────────────
//
// Due days come from the recurrence RULES, not from stored rows, so without this an
// item paused for six weeks would arrive as six weeks of `missing` observations and
// read as six weeks of failure.  That is the precise failure this design exists to
// prevent: a confidently-computed claim the record does not support.  It would poison
// adherence, both streak measures, day-of-week, trajectory and autocorrelation at
// once, and Layer 3 would narrate the poison fluently.
//
// The exclusion drops days the rules WOULD have generated.  Days the record actually
// holds — a stored occurrence — are never dropped: deactivation clears untouched
// future occurrences but never touched ones (§5.6), so a session you logged the
// morning you paused still counts.  Pausing does not un-happen what happened.

// Replay one item's deactivate/reactivate transitions into its paused intervals.
async function pausedIntervalsFor(
  pool: Pool,
  itemIds: string[],
  userId: string
): Promise<Map<string, PausedInterval[]>> {
  const eventsByItem = await repos.findDeactivationEventsByItems(pool, itemIds, userId)
  const result = new Map<string, PausedInterval[]>()
  for (const itemId of itemIds) {
    result.set(itemId, pausedIntervalsFromEvents(eventsByItem.get(itemId) ?? []))
  }
  return result
}

// Drop the rule-derived slots that fall inside a paused interval.
function dropPausedSlots<T extends { day: string }>(
  slots: T[],
  intervals: PausedInterval[]
): T[] {
  if (intervals.length === 0) return slots
  return slots.filter((s) => !isDayPaused(s.day, intervals))
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

  const [schedules, occs, pausedByItem] = await Promise.all([
    repos.findSchedulesByItem(pool, item.id, userId),
    repos.findOccurrencesByItemsInRange(pool, [item.id], userId, startDay, endDay),
    pausedIntervalsFor(pool, [item.id], userId),
  ])

  // §5.5 — which (day, slot) pairs the item was due in the window. Recurring slots
  // come from the rules; one-time slots — and rows left by a removed schedule — are
  // due exactly where they have a stored occurrence.
  const occBySlot = new Map<string, Occurrence>()
  for (const o of occs) occBySlot.set(`${o.appliesToDay}:${o.scheduleId}`, o)

  // v2 §9.1.1.b — paused days are not due days.  Applied to the rule-derived slots
  // only; the stored-row pass below still adds any day the record actually holds.
  const slotKeys: { day: string; scheduleId: string }[] = dropPausedSlots(
    getItemDueSlots(item, schedules, startDay, endDay),
    pausedByItem.get(item.id) ?? []
  )
  const covered = new Set(slotKeys.map((s) => `${s.day}:${s.scheduleId}`))
  for (const o of occs) {
    const key = `${o.appliesToDay}:${o.scheduleId}`
    if (!covered.has(key)) slotKeys.push({ day: o.appliesToDay, scheduleId: o.scheduleId })
  }

  if (slotKeys.length === 0) return []

  const eventsMap = await repos.findEventsByOccurrenceIds(pool, occs.map(o => o.id), userId)

  const slotObs = slotKeys.map(({ day, scheduleId }) => {
    const occ = occBySlot.get(`${day}:${scheduleId}`)
    const events = occ ? (eventsMap.get(occ.id) ?? []) : []
    return buildLeafDayObs(day, occ, events)
  })

  // v2 §9.1.1.a — a day is one observation, whatever its slot count.
  return foldSlotsIntoDays(slotObs)
}

// Everything the in-memory tree walk needs, bulk-loaded up front so the walk
// itself does zero I/O (and stays a mirror of domain/completion.ts's walk).
type SubtreeContext = {
  childrenByParent: Map<string, Item[]>       // itemId → its direct children
  dueSlots: Map<string, Set<string>>          // `${itemId}:${day}` → scheduleIds due
  occs: Map<string, Occurrence[]>             // `${itemId}:${day}` → its occurrences
  events: Map<string, TrackerEvent[]>         // occurrenceId → its events
}

// One slot the item was due in on a day: its stored occurrence (undefined when not
// yet materialized) and that occurrence's events.
type DueSlotState = { occ: Occurrence | undefined; events: TrackerEvent[] }

/**
 * §5.5 — Every slot the item was due in on `day`, in slot order.
 *
 * Recurring slots come from the rules (an unmaterialized one has no events:
 * untouched); a one-time slot, or a row left by a removed schedule, is due exactly
 * where it has a stored occurrence.  An empty result means "not due".
 * Mirrors dueSlotOccurrences in domain/completion.ts.
 */
function slotsFor(itemId: string, day: string, ctx: SubtreeContext): DueSlotState[] {
  const key = `${itemId}:${day}`
  const dueScheduleIds = ctx.dueSlots.get(key) ?? new Set<string>()
  const stored = ctx.occs.get(key) ?? []
  const storedBySchedule = new Map(stored.map((o) => [o.scheduleId, o]))

  const slots: DueSlotState[] = []
  for (const scheduleId of dueScheduleIds) {
    const occ = storedBySchedule.get(scheduleId)
    slots.push({ occ, events: occ ? (ctx.events.get(occ.id) ?? []) : [] })
  }
  for (const occ of stored) {
    if (!dueScheduleIds.has(occ.scheduleId)) {
      slots.push({ occ, events: ctx.events.get(occ.id) ?? [] })
    }
  }
  return slots
}

/**
 * §6.1 — Due, non-excused children of `itemId` on `day`, as CompletionNodes.
 *
 * The stats-side twin of buildDueChildNodes in domain/completion.ts: same rule
 * (recurse into sub-parents, drop not-due and excused children, average a child's
 * own slots), different data access — that one queries lazily per day, this one walks
 * pre-loaded maps over a whole window. Both hand the result to the same pure
 * computeNodePercent, so a stat can never disagree with what the app showed on the day.
 */
function buildDueChildNodes(itemId: string, day: string, ctx: SubtreeContext): CompletionNode[] {
  const nodes: CompletionNode[] = []
  for (const child of ctx.childrenByParent.get(itemId) ?? []) {
    const slots = slotsFor(child.id, day, ctx)
    if (slots.length === 0) continue   // not due today

    const slotNodes: CompletionNode[] = []
    for (const { events } of slots) {
      // §8.1 — an excused slot is out of the denominator entirely, not a zero.
      if (deriveOccurrenceDisposition(events).type === 'excused') continue
      slotNodes.push(buildNode(child.id, day, events, ctx))
    }
    if (slotNodes.length === 0) continue   // every slot excused

    // §5.5 — a child due in several slots contributes the MEAN of them, so it weighs
    // the same as any other child instead of counting once per slot.
    //
    // An aggregating node over its slots, not a leaf carrying a pre-computed mean:
    // computeNodePercent binarizes a leaf, which would crush a 50% two-slot day to 0.
    // Mirrors domain/completion.ts exactly. (An item with children carries at most one
    // slot, so this branch is leaf-children only.)
    nodes.push(
      slotNodes.length === 1
        ? slotNodes[0]
        : { isParent: true, leafPercent: 0, declaredPercent: null, dueChildren: slotNodes }
    )
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

  // Whole subtree (active only), plus the direct children the breakdown reports on
  const { descendants, childrenByParent } = await collectSubtree(pool, userId, parentItem.id)
  const children = childrenByParent.get(parentItem.id) ?? []

  // Bulk-fetch every schedule in the subtree so due-ness is answered per slot (§5.5)
  const allItemIds = [parentItem.id, ...descendants.map(d => d.id)]
  const [allSchedules, allOccs, pausedByItem] = await Promise.all([
    repos.findSchedulesByUser(pool, userId),
    repos.findOccurrencesByItemsInRange(pool, allItemIds, userId, startDay, endDay),
    // v2 §9.1.1.b — one bulk query for the whole subtree; every item in it can have
    // been paused independently, and each one's own timeline is what applies.
    pausedIntervalsFor(pool, allItemIds, userId),
  ])
  const schedulesByItem = new Map<string, ItemSchedule[]>()
  for (const s of allSchedules) {
    const list = schedulesByItem.get(s.itemId)
    if (list) list.push(s)
    else schedulesByItem.set(s.itemId, [s])
  }

  // §5.5 — a parent carries at most one slot, so its due days are unambiguous.
  // v2 §9.1.1.b — minus the days it was paused.
  const parentDueDays = dropPausedSlots(
    getItemDueDays(parentItem, schedulesByItem.get(parentItem.id) ?? [], startDay, endDay)
      .map((day) => ({ day })),
    pausedByItem.get(parentItem.id) ?? []
  ).map((d) => d.day)

  // Which slots each descendant was due in, keyed 'itemId:day' (getItemDueSlots —
  // not reimplemented).
  const dueSlots = new Map<string, Set<string>>()
  for (const item of descendants) {
    // v2 §9.1.1.b — per item: a child paused on its own contributes nothing on those
    // days, and §6.1 already excludes a not-due child from the parent's denominator,
    // so the pause reads as "not due" everywhere without a second rule.
    const slots = dropPausedSlots(
      getItemDueSlots(item, schedulesByItem.get(item.id) ?? [], startDay, endDay),
      pausedByItem.get(item.id) ?? []
    )
    for (const slot of slots) {
      const key = `${item.id}:${slot.day}`
      const set = dueSlots.get(key)
      if (set) set.add(slot.scheduleId)
      else dueSlots.set(key, new Set([slot.scheduleId]))
    }
  }

  // Build occ lookup: 'itemId:day' → that day's occurrences (plural, §5.5)
  const occMap = new Map<string, Occurrence[]>()
  for (const occ of allOccs) {
    const key = `${occ.itemId}:${occ.appliesToDay}`
    const list = occMap.get(key)
    if (list) list.push(occ)
    else occMap.set(key, [occ])
  }

  // Bulk-fetch all events for all occurrences in the window
  const allOccIds = allOccs.map(o => o.id)
  const eventsMap = await repos.findEventsByOccurrenceIds(pool, allOccIds, userId)

  const ctx: SubtreeContext = {
    childrenByParent,
    dueSlots,
    occs: occMap,
    events: eventsMap,
  }

  // Build child observations (each direct child's due days in the window).
  // A child that is itself a parent reports its own value (declared ?? derived,
  // §6.3) — the same number it contributed to the parent above, so the breakdown
  // can never disagree with the total it feeds.
  const childObs: ChildObservationMap = new Map()
  for (const child of children) {
    const hasChildren = (childrenByParent.get(child.id) ?? []).length > 0

    // Days this child was due at all: from its rules, plus any day it has a stored
    // row (one-time slots and rows from removed schedules).
    const days = new Set<string>()
    for (const key of dueSlots.keys()) {
      if (key.startsWith(`${child.id}:`)) days.add(key.slice(child.id.length + 1))
    }
    for (const occ of allOccs) {
      if (occ.itemId === child.id) days.add(occ.appliesToDay)
    }

    const slotObs: DayObservation[] = []
    for (const day of Array.from(days).sort()) {
      if (!hasChildren) {
        // §5.5 — one observation per slot; foldSlotsIntoDays collapses them below.
        for (const { occ, events } of slotsFor(child.id, day, ctx)) {
          slotObs.push(buildLeafDayObs(day, occ, events))
        }
        continue
      }
      // A child that is itself a parent has exactly one slot (§5.5).
      const occ = (occMap.get(`${child.id}:${day}`) ?? [])[0]
      const events = occ ? (eventsMap.get(occ.id) ?? []) : []
      const nodePercent = computeNodePercent(buildNode(child.id, day, events, ctx))
      slotObs.push({
        day,
        completionPercent: nodePercent,
        disposition: deriveDisposition(occ, events),
        declaredPercent: findDeclaredPercent(events),
        isBackfilled: false,
        backfillLagDays: 0,
        // A sub-parent is one slot (§5.5); "completed" for it means fully derived.
        slotsDue: 1,
        slotsCompleted: nodePercent >= 100 ? 1 : 0,
        slotsExcused: deriveDisposition(occ, events) === 'excused' ? 1 : 0,
      })
    }
    childObs.set(child.id, foldSlotsIntoDays(slotObs))
  }

  // Build parent observations — derived % from children on each due day
  const parentObs: DayObservation[] = parentDueDays.map((day: string) => {
    const parentOcc = (occMap.get(`${parentItem.id}:${day}`) ?? [])[0]
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
      // §5.5 — a parent carries exactly one slot, so its day is always one slot.
      slotsDue: 1,
      slotsCompleted: derivedPercent >= 100 ? 1 : 0,
      slotsExcused: parentOcc && disposition === 'excused' ? 1 : 0,
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

  // Bulk-load items for enrichment (creationSource, valence, categoryId), plus their
  // schedules — §5.5 moved planned duration onto the slot, so an item's planned
  // minutes for a day is the sum across its slots (itemPlannedDurationMin).
  const [allItems, allSchedules] = await Promise.all([
    repos.findItemsByUser(pool, userId),
    repos.findSchedulesByUser(pool, userId),
  ])
  const itemMap = new Map(allItems.map(i => [i.id, i]))
  const schedulesByItem = new Map<string, ItemSchedule[]>()
  for (const s of allSchedules) {
    const list = schedulesByItem.get(s.itemId)
    if (list) list.push(s)
    else schedulesByItem.set(s.itemId, [s])
  }

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
      plannedDurationMin: itemPlannedDurationMin(schedulesByItem.get(item.id) ?? []),
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
