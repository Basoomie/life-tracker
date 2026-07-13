// §3 — API request/response types for the Fastify layer.
// All types are consumed by both frontend (step 4) and backend routes.
// Defined once here so the API cannot drift from the client.

import type { ComputedOccurrence } from './entities'
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
  // §9.1 — sum of finalized (stopped/manual) session durations logged against this
  // occurrence, in minutes. For a parent occurrence this rolls up its whole subtree
  // (its own sessions plus every descendant's), the same way derived completion %
  // rolls up child completions. Excludes any currently in-progress session, whose
  // live elapsed time the client tracks separately while it's running.
  loggedMinutes: number
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

export type StartSessionBody = {
  itemId: string
  day?: string   // YYYY-MM-DD; defaults to today
}

export type ManualSessionBody = {
  itemId: string
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
