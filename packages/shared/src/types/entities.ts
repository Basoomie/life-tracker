import type {
  CreationSource,
  DispositionPolicy,
  Priority,
  QuotaTarget,
  RecurrenceRule,
  TimingPrecision,
  Valence,
} from './enums'

// Frozen snapshot of mutable item fields stored inside each occurrence row (§5.3).
// When the template is later edited, past/materialized occurrences remain truthful
// because they carry their own copy of these fields.
export type ItemSnapshot = {
  name: string
  description: string | null
  categoryId: string | null
  valence: Valence | null
  priority: Priority | null
  recurrenceRule: RecurrenceRule | null
  quotaTarget: QuotaTarget | null
  timingPrecision: TimingPrecision
  timingBucketId: string | null
  timingStartTime: string | null    // HH:MM
  timingEndTime: string | null      // HH:MM
  plannedDurationMin: number | null
  dispositionPolicy: DispositionPolicy
  parentId: string | null
  prerequisiteIds: string[]         // item IDs this item depends on
}

// §13.4 — minimal user row; v1 always uses one user, but every entity carries user_id
export type User = {
  id: string
  email: string
  createdAt: Date
}

// §3.4 / §7 — configurable life-area groupings; one per item; soft-deleted not hard
export type Category = {
  id: string
  userId: string
  name: string
  archivedAt: Date | null
  createdAt: Date
}

// §3.4 / §8.3 — configurable list for skip/excuse/reschedule reasons; soft-deleted
export type Reason = {
  id: string
  userId: string
  name: string
  archivedAt: Date | null
  createdAt: Date
}

// §6.6 — user-defined parts of day with editable clock boundaries
export type Bucket = {
  id: string
  userId: string
  name: string
  startTime: string   // HH:MM
  endTime: string     // HH:MM — if < startTime, wraps past midnight to next day-start
  sortOrder: number
  createdAt: Date
}

// §6.7 — each row is one entry in the day-start timeline (append-only, never updated)
export type DayStartEntry = {
  id: string
  userId: string
  startsOn: string    // YYYY-MM-DD — the first day this value is active
  value: string       // HH:MM — e.g. '04:00'
  recordedAt: Date
}

// §3.1 — the central template entity; both tasks and habits
export type Item = {
  id: string
  userId: string
  name: string
  description: string | null
  categoryId: string | null
  valence: Valence | null
  priority: Priority | null
  recurrenceRule: RecurrenceRule | null   // null = one-time task
  quotaTarget: QuotaTarget | null
  timingPrecision: TimingPrecision
  timingBucketId: string | null
  timingStartTime: string | null          // HH:MM
  timingEndTime: string | null            // HH:MM
  plannedDurationMin: number | null
  parentId: string | null                 // containment tree (§4.1)
  dispositionPolicy: DispositionPolicy
  creationSource: CreationSource
  archivedAt: Date | null
  createdAt: Date
}

// §3.2 — junction table row for the prerequisite graph (§4.2)
export type ItemPrerequisite = {
  itemId: string
  prerequisiteId: string
  userId: string
  createdAt: Date
}

// §3.2 — dated instance of an item; carries a frozen snapshot of template fields
export type Occurrence = {
  id: string
  userId: string
  itemId: string
  appliesToDay: string      // YYYY-MM-DD
  snapshot: ItemSnapshot
  materializedAt: Date
}

// §5.4 — unified type for the merged read API.
// Covers both stored (materialized) and computed (on-the-fly) occurrences.
// id / materializedAt are null for occurrences that haven't been stored yet;
// callers that don't care about storage status can treat both cases identically.
export type ComputedOccurrence = {
  id: string | null
  userId: string
  itemId: string
  appliesToDay: string        // YYYY-MM-DD
  snapshot: ItemSnapshot
  materializedAt: Date | null
}
