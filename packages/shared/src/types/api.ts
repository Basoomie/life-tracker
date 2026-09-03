// §3 — API request/response types for the Fastify layer.
// All types are consumed by both frontend (step 4) and backend routes.
// Defined once here so the API cannot drift from the client.

import type { ComputedOccurrence, Item, ItemPrerequisite, ItemSchedule } from './entities'
import type {
  Priority,
  Valence,
  DispositionPolicy,
  RecurrenceRule,
  QuotaTarget,
  TimingPrecision,
  CreationSource,
} from './enums'

// ── Occurrence enrichment types ───────────────────────────────────────────────

// Unified completion view for API consumers; derived from events by enrichOccurrence.
export type OccurrenceCompletionState = {
  isLeaf: boolean
  completionPercent: number        // 0-100
  isComplete: boolean
  completedAt: Date | null         // null for parents or incomplete
  wasRetroactive: boolean          // leaf-only; false for parents
  derivedPercent: number | null    // non-null for parents only
  declaredPercent: number | null   // non-null if manual_parent_percent_declared exists
}

// What happened to this occurrence (pending until explicitly changed)
export type OccurrenceDisposition = {
  type: 'pending' | 'completed' | 'skipped' | 'excused' | 'rescheduled' | 'auto_closed'
  reasonId: string | null
  comment: string | null
  rescheduledToDay: string | null
  derivedPercentAtClose: number | null  // for auto_closed
}

// Full enriched occurrence — what the views actually consume
export type OccurrenceWithState = ComputedOccurrence & {
  isBlocked: boolean
  incompletePrerequisiteIds: string[]
  completionState: OccurrenceCompletionState
  disposition: OccurrenceDisposition
  hasChildren: boolean
  sortOrder: number   // live Item.sortOrder — this occurrence's position among its siblings
  // §4.1 — the item's LIVE containment edge, deliberately separate from
  // snapshot.parentId (which froze at materialization and can be stale after a
  // reparent). "Is this a top-level item?" is a question about the item as it
  // stands now — the reorder endpoints answer it from items.parent_id, so any
  // client that answers it from the snapshot will disagree with the server.
  // parentName travels with the id so a detached child can name its parent
  // without the client having to hold every item.
  parentItemId: string | null
  parentName: string | null
  // §9.1 — sum of finalized (stopped/manual) session durations logged against this
  // occurrence, in minutes. For a parent occurrence this rolls up its whole subtree
  // (its own sessions plus every descendant's), the same way derived completion %
  // rolls up child completions. Excludes any currently in-progress session, whose
  // live elapsed time the client tracks separately while it's running.
  loggedMinutes: number
}

// ── Item read shapes (§5.5) ───────────────────────────────────────────────────

// An item always travels with its schedules: without them a client can't tell when
// the item happens, whether it recurs, or how to render its timing.
export type ItemWithSchedules = Item & {
  schedules: ItemSchedule[]
}

export type ItemDetail = ItemWithSchedules & {
  children: Item[]
  prerequisites: ItemPrerequisite[]
}

// §5.6 — which slice of the user's items GET /items should return.
// 'active' is the default because every day-to-day surface wants exactly that;
// asking for the inactive list is always a deliberate act.
export type ItemStatusFilter = 'active' | 'inactive' | 'all'

// §5.6 — the outcome of a deactivate/reactivate call.
//
// `affected` is the whole set the call switched, acted-on item first, because
// deactivation cascades over the containment subtree (§4.1) and the user needs to be
// told what else moved.  A count alone would leave them guessing which sub-tasks.
export type ItemActivationResponse = {
  item: ItemWithSchedules
  affected: Item[]
  clearedFutureOccurrences: number
}

// §5.5 — an item recurs if any of its slots does. Shared so the client and the
// prerequisite rule (§4.2) can never disagree about what "a habit" means.
export function isRecurringItem(schedules: ItemSchedule[]): boolean {
  return schedules.some((s) => s.recurrenceRule !== null)
}

// ── Request body types ────────────────────────────────────────────────────────

export type CreateItemBody = {
  name: string
  description?: string | null
  categoryId?: string | null
  valence?: Valence | null
  priority?: Priority | null
  recurrenceRule?: RecurrenceRule | null
  anchorDay?: string | null  // YYYY-MM-DD — §5.1 recurrence start day; defaults to today if omitted
  quotaTarget?: QuotaTarget | null
  timingPrecision?: TimingPrecision
  timingBucketId?: string | null
  timingStartTime?: string | null
  timingEndTime?: string | null
  plannedDurationMin?: number | null
  parentId?: string | null
  dispositionPolicy?: DispositionPolicy
  creationSource?: CreationSource
  day?: string  // YYYY-MM-DD — for one-time task materialization; defaults to today
}

export type UpdateItemBody = Omit<Partial<CreateItemBody>, 'creationSource' | 'day'>

// §5.5 — add a slot to an existing item. The item's first slot is created with the
// item itself (CreateItemBody's flat fields); this is for the second and beyond.
export type CreateScheduleBody = {
  label?: string | null
  recurrenceRule?: RecurrenceRule | null
  anchorDay?: string | null   // YYYY-MM-DD — §5.1 recurrence start day
  timingPrecision?: TimingPrecision
  timingBucketId?: string | null
  timingStartTime?: string | null
  timingEndTime?: string | null
  plannedDurationMin?: number | null
}

// §5.5 — edit one slot. Forward-only per §5.3: past occurrences of this slot keep
// the snapshot they were materialized with.
export type UpdateScheduleBody = Partial<CreateScheduleBody> & {
  sortOrder?: number
}

export type SetPriorityBody = {
  priority: Priority | null
}

export type AddPrerequisiteBody = {
  prerequisiteItemId: string
}

export type DeclarePercentBody = {
  percent: number
}

// Manual drag-and-drop child ordering — must contain exactly the parent's
// current children's ids (no missing/extra/duplicate), in the desired order.
export type ReorderChildrenBody = {
  childItemIds: string[]
}

// Manual drag-and-drop reorder for a top-level (parentless) item. Unlike
// ReorderChildrenBody, the caller supplies only the desired neighbor —
// unscheduled root items are routinely viewed through a filtered/tiered
// subset, so the client can never be trusted to know the complete root
// order the way it can for a parent's (always-unfiltered) children list.
export type ReorderRootBody = {
  afterItemId: string | null
}

export type DispositionBody = {
  reasonId?: string | null
  comment?: string | null
}

export type CarryForwardBody = {
  targetDay: string   // YYYY-MM-DD
  reasonId?: string | null
  comment?: string | null
}

export type RetroactiveBody = {
  recordedAt?: string   // ISO 8601 timestamp; defaults to now
}

// §5.5 — (itemId, day) does not identify one occurrence once an item has several
// slots, so the client sends the scheduleId of the slot it rendered. Optional only
// for single-slot callers; the server refuses to guess when the item is multi-slot.
export type StartSessionBody = {
  itemId: string
  scheduleId?: string
  day?: string   // YYYY-MM-DD; defaults to today
}

export type ManualSessionBody = {
  itemId: string
  scheduleId?: string
  day?: string
  startedAt: string   // ISO 8601
  endedAt: string     // ISO 8601
}

export type EditSessionBody = {
  startedAt: string   // ISO 8601
  endedAt: string     // ISO 8601
}

// §9.1 — one finalized, non-deleted session logged directly against an
// occurrence. Returned by GET /occurrences/:id/sessions for the
// session-manager UI (add/edit/delete individual logged windows).
export type SessionSummary = {
  sessionId: string
  startedAt: string   // ISO 8601
  endedAt: string     // ISO 8601
  durationMin: number
  source: 'live' | 'manual'
}

export type AdHocCaptureBody = {
  name: string
  categoryId?: string | null
  valence?: Valence | null
  day?: string   // YYYY-MM-DD; defaults to today
}

export type CreateCategoryBody = {
  name: string
}

export type RenameCategoryBody = {
  name: string
}

export type CreateReasonBody = {
  name: string
}

export type RenameReasonBody = {
  name: string
}

export type CreateBucketBody = {
  name: string
  startTime: string   // HH:MM
  endTime: string     // HH:MM
  sortOrder?: number
}

export type UpdateBucketBoundariesBody = {
  startTime: string   // HH:MM
  endTime: string     // HH:MM
}

export type CreateDayStartBody = {
  value: string         // HH:MM
  effectiveFrom: string // YYYY-MM-DD — must be >= today (§6.7)
}

export type RunBackgroundJobBody = {
  day: string   // YYYY-MM-DD — the logical day to close out
}

// v2 §9.4.1 follow-up — diagnostic only, not enforced. Reports whether the abstract
// panel was open in the reviewer's UI at the moment Approve was clicked; the server is
// authoritative about whether an abstract existed at all (never trusts the client for
// that fact — see evidence/pipeline.ts). Omitting this field is fine; approval is never
// blocked by it.
export type ApproveEvidenceBody = {
  abstractVisible?: boolean
}

// ── Auth request/response types (§13.1) ──────────────────────────────────────

export type LoginBody = {
  email: string
  password: string
}

export type ChangePasswordBody = {
  currentPassword: string
  newPassword: string
}

// ── Standard error shape ──────────────────────────────────────────────────────

export type ApiError = {
  error: string    // machine-readable code, e.g. 'not_found', 'cycle_rejected'
  message: string  // human-readable description
}
