// §10 — Event catalog as a TypeScript discriminated union.
//
// The DB stores every event in a single `events` table: common fields as real columns,
// type-varying data in a JSONB `payload` column.  This union makes payload access
// fully type-safe: narrowing on `eventType` gives the exact payload shape.
//
// Event types follow §10.2 verbatim.  Every event is immutable — corrections are new
// events, never edits-in-place.

import type {
  AbstractVisibilityAtApproval,
  CreationSource,
  EvidenceProvenance,
  EvidenceQuality,
  Priority,
  SourceIdentifierType,
  VerificationFailureReason,
} from './enums'
import type { ItemSnapshot } from './entities'

// Re-export so callers only need one import
export type { ItemSnapshot } from './entities'

// Fields present on every stored event row
type EventBase = {
  id: string
  userId: string
  recordedAt: Date
  appliesToDay: string | null   // YYYY-MM-DD; null for pure config events
  occurrenceId: string | null   // null for template-/config-level events
  itemId: string | null         // null for config events (categories, reasons, etc.)
}

// ── Completion / status ───────────────────────────────────────────────────────

type ItemCompletedEvent = EventBase & {
  eventType: 'item_completed'
  payload: {
    completionPercent: number
    completionKind: 'derived' | 'declared'
  }
}

// Fired on a parent occurrence to record that a specific child was completed (§6.1)
type ChildCompletedEvent = EventBase & {
  eventType: 'child_completed'
  payload: {
    childItemId: string
    childOccurrenceId: string
  }
}

// Fired on a parent occurrence to record that a child was unchecked
type ChildUncheckedEvent = EventBase & {
  eventType: 'child_unchecked'
  payload: {
    childItemId: string
    childOccurrenceId: string
  }
}

// §6.4 — explicit backfill flag when recorded-at ≠ applies-to (gap is v2 signal)
type RetroactiveCompletionEvent = EventBase & {
  eventType: 'retroactive_completion'
  payload: {
    completionPercent: number
    completionKind: 'derived' | 'declared'
  }
}

// §6.2 — rare override: user declares a parent % that differs from derived %
type ManualParentPercentDeclaredEvent = EventBase & {
  eventType: 'manual_parent_percent_declared'
  payload: {
    declaredPercent: number
  }
}

// ── Dispositions ─────────────────────────────────────────────────────────────

type SkippedEvent = EventBase & {
  eventType: 'skipped'
  payload: {
    reasonId: string | null
    comment: string | null
  }
}

type ExcusedEvent = EventBase & {
  eventType: 'excused'
  payload: {
    reasonId: string | null
    comment: string | null
  }
}

// §8.2 — creates a new occurrence on newDay; original stays as skipped-and-rescheduled
type RescheduledEvent = EventBase & {
  eventType: 'rescheduled'
  payload: {
    newDay: string              // YYYY-MM-DD
    newOccurrenceId: string | null   // populated once the new occurrence is materialized
    reasonId: string | null
    comment: string | null
  }
}

// §8.1 — auto_close policy: fired by end-of-day job at whatever the derived % was
type AutoClosedEvent = EventBase & {
  eventType: 'auto_closed'
  payload: {
    derivedPercent: number
  }
}

// §6.7 — user manually reassigns an event to the adjacent day (day-start edge case)
type EventReassignedEvent = EventBase & {
  eventType: 'event_reassigned'
  payload: {
    targetEventId: string   // the event being reassigned
    fromDay: string
    toDay: string
  }
}

// ── Time tracking ─────────────────────────────────────────────────────────────

type SessionStartedEvent = EventBase & {
  eventType: 'session_started'
  payload: {
    sessionId: string
  }
}

type SessionPausedEvent = EventBase & {
  eventType: 'session_paused'
  payload: {
    sessionId: string
    pausedAt: string    // ISO 8601 timestamp
  }
}

type SessionResumedEvent = EventBase & {
  eventType: 'session_resumed'
  payload: {
    sessionId: string
    resumedAt: string
  }
}

type SessionStoppedEvent = EventBase & {
  eventType: 'session_stopped'
  payload: {
    sessionId: string
    stoppedAt: string
    durationMin: number
  }
}

type SessionCreatedEvent = EventBase & {
  eventType: 'session_created'
  payload: {
    sessionId: string
    startedAt: string
    endedAt: string
    durationMin: number
  }
}

type SessionEditedEvent = EventBase & {
  eventType: 'session_edited'
  payload: {
    sessionId: string
    startedAt: string
    endedAt: string
    durationMin: number
  }
}

// A correction, not a mutation: the session's original events stay on the
// record, but this event causes it to be excluded from every downstream
// duration computation (loggedMinutes, session listings, stats).
type SessionDeletedEvent = EventBase & {
  eventType: 'session_deleted'
  payload: {
    sessionId: string
  }
}

// ── Structure / config (forward-only; past occurrences stay frozen) ───────────

type TemplateCreatedEvent = EventBase & {
  eventType: 'template_created'
  payload: {
    creationSource: CreationSource
    snapshot: ItemSnapshot
  }
}

type TemplateEditedEvent = EventBase & {
  eventType: 'template_edited'
  payload: {
    changes: Partial<ItemSnapshot>
  }
}

type TemplateSoftDeletedEvent = EventBase & {
  eventType: 'template_soft_deleted'
  payload: Record<string, never>
}

// §7.1 — covers both initial set and subsequent changes; previousPriority is null on first set
type PriorityChangedEvent = EventBase & {
  eventType: 'priority_changed'
  payload: {
    previousPriority: Priority | null
    newPriority: Priority | null
  }
}

// Manual drag-and-drop child reorder — parentId is the item whose children
// were reordered; both arrays are the full ordered set of child item ids.
type ChildrenReorderedEvent = EventBase & {
  eventType: 'children_reordered'
  payload: {
    parentId: string
    previousOrder: string[]
    newOrder: string[]
  }
}

// Manual drag-and-drop reorder of top-level (parentless) items — same
// mechanism as ChildrenReorderedEvent but scoped to root items rather than
// one parent's children. afterItemId is what the caller requested (null =
// moved to the front); previousOrder/newOrder are the full root order as
// computed server-side, since the caller only ever sees a filtered subset.
type RootItemsReorderedEvent = EventBase & {
  eventType: 'root_items_reordered'
  payload: {
    itemId: string
    afterItemId: string | null
    previousOrder: string[]
    newOrder: string[]
  }
}

// §4.2 — cycle-checked before insertion
type PrerequisiteAddedEvent = EventBase & {
  eventType: 'prerequisite_added'
  payload: {
    prerequisiteItemId: string
  }
}

type PrerequisiteRemovedEvent = EventBase & {
  eventType: 'prerequisite_removed'
  payload: {
    prerequisiteItemId: string
  }
}

// §6.7 — appends to the day-start timeline; never rewrites past days
type DayStartChangedEvent = EventBase & {
  eventType: 'day_start_changed'
  payload: {
    newValue: string              // HH:MM
    effectiveFrom: string         // YYYY-MM-DD
    previousValue: string | null  // null on very first configuration
  }
}

type BucketBoundariesChangedEvent = EventBase & {
  eventType: 'bucket_boundaries_changed'
  payload: {
    bucketId: string
    previousStartTime: string
    previousEndTime: string
    newStartTime: string
    newEndTime: string
  }
}

type CategoryCreatedEvent = EventBase & {
  eventType: 'category_created'
  payload: {
    categoryId: string
    name: string
  }
}

type CategoryRenamedEvent = EventBase & {
  eventType: 'category_renamed'
  payload: {
    categoryId: string
    previousName: string
    newName: string
  }
}

type CategoryArchivedEvent = EventBase & {
  eventType: 'category_archived'
  payload: {
    categoryId: string
  }
}

type ReasonCreatedEvent = EventBase & {
  eventType: 'reason_created'
  payload: {
    reasonId: string
    name: string
  }
}

type ReasonRenamedEvent = EventBase & {
  eventType: 'reason_renamed'
  payload: {
    reasonId: string
    previousName: string
    newName: string
  }
}

type ReasonArchivedEvent = EventBase & {
  eventType: 'reason_archived'
  payload: {
    reasonId: string
  }
}

// ── v2 §9.4 — Evidence base (generate → verify → approve; §9.4.1) ─────────────
// Config-level events (itemId/occurrenceId null), same pattern as category/reason events.

type EvidenceEntryProposedEvent = EventBase & {
  eventType: 'evidence_entry_proposed'
  payload: {
    evidenceEntryId: string
    provenance: EvidenceProvenance
    sourceIdentifierType: SourceIdentifierType
    sourceIdentifier: string
    claimedEvidenceQuality: EvidenceQuality
  }
}

// Fired by the verification gate itself — never by a human action (§9.4: "code verifies").
type EvidenceEntryVerifiedEvent = EventBase & {
  eventType: 'evidence_entry_verified'
  payload: {
    evidenceEntryId: string
    actualEvidenceQuality: EvidenceQuality
    resolvedPmid: string
  }
}

type EvidenceEntryVerificationRejectedEvent = EventBase & {
  eventType: 'evidence_entry_verification_rejected'
  payload: {
    evidenceEntryId: string
    reason: VerificationFailureReason
    detail: string
  }
}

// Human relevance/fairness step (§9.4.1 step 3) — only reachable once verified.
// abstractVisibleAtApproval is diagnostic, not a gate (§9.4.1 follow-up): it records
// whether the abstract panel was open in the UI at the moment of the click — visibility,
// not reading. Never used to block or warn; exists so a bad entry surfacing months later
// can be retrospectively traced to "was the abstract even in view when this was approved."
type EvidenceEntryApprovedEvent = EventBase & {
  eventType: 'evidence_entry_approved'
  payload: {
    evidenceEntryId: string
    abstractVisibleAtApproval: AbstractVisibilityAtApproval
  }
}

type EvidenceEntryApprovalRejectedEvent = EventBase & {
  eventType: 'evidence_entry_approval_rejected'
  payload: {
    evidenceEntryId: string
  }
}

type EvidenceEntryArchivedEvent = EventBase & {
  eventType: 'evidence_entry_archived'
  payload: {
    evidenceEntryId: string
  }
}

// ── v2 §6 / §9.2 — The AI Review (step 3b) ────────────────────────────────────
// Config-level event (itemId/occurrenceId null) — a review is a user-wide artifact,
// not scoped to one item. Fired once per generated review; reviews are immutable
// once stored (§CLAUDE.md), so there is no corresponding "edited" event.
type ReviewGeneratedEvent = EventBase & {
  eventType: 'review_generated'
  payload: {
    reviewId: string
    cadence: 'weekly' | 'monthly' | 'quarterly'
    windowStart: string
    windowEnd: string
    recommendationCount: number
  }
}

// ── Discriminated union ───────────────────────────────────────────────────────

export type TrackerEvent =
  | ItemCompletedEvent
  | ChildCompletedEvent
  | ChildUncheckedEvent
  | RetroactiveCompletionEvent
  | ManualParentPercentDeclaredEvent
  | SkippedEvent
  | ExcusedEvent
  | RescheduledEvent
  | AutoClosedEvent
  | EventReassignedEvent
  | SessionStartedEvent
  | SessionPausedEvent
  | SessionResumedEvent
  | SessionStoppedEvent
  | SessionCreatedEvent
  | SessionEditedEvent
  | SessionDeletedEvent
  | TemplateCreatedEvent
  | TemplateEditedEvent
  | TemplateSoftDeletedEvent
  | PriorityChangedEvent
  | ChildrenReorderedEvent
  | RootItemsReorderedEvent
  | PrerequisiteAddedEvent
  | PrerequisiteRemovedEvent
  | DayStartChangedEvent
  | BucketBoundariesChangedEvent
  | CategoryCreatedEvent
  | CategoryRenamedEvent
  | CategoryArchivedEvent
  | ReasonCreatedEvent
  | ReasonRenamedEvent
  | ReasonArchivedEvent
  | EvidenceEntryProposedEvent
  | EvidenceEntryVerifiedEvent
  | EvidenceEntryVerificationRejectedEvent
  | EvidenceEntryApprovedEvent
  | EvidenceEntryApprovalRejectedEvent
  | EvidenceEntryArchivedEvent
  | ReviewGeneratedEvent

// Literal union of all event type strings — useful for DB CHECK constraints and
// exhaustive switch guards in domain logic.
export type EventType = TrackerEvent['eventType']
