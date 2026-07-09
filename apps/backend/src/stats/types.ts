// Internal observation types for the stats domain layer.
//
// The observation-array seam (§9.1.1): domain replay produces these plain types;
// statistical calculators consume them as pure functions with zero domain knowledge.
//
// All v1 subtlety (derived %, excused handling, day-start bucketing, not-due exclusion)
// is applied by the observation builders BEFORE emitting these arrays.

export type DayDisposition =
  | 'completed'
  | 'excused'
  | 'skipped'
  | 'auto_closed'
  | 'rescheduled'
  | 'pending'
  | 'missing'    // no materialized occurrence at all (data gap)

// One entry per due day in the window for a given item.
// completionPercent: leaf = 0|100; parent = derived % (0-100).
// isBackfilled: true when the completion was a retroactive_completion event.
export type DayObservation = {
  day: string                     // YYYY-MM-DD
  completionPercent: number       // 0-100
  disposition: DayDisposition
  declaredPercent: number | null  // non-null for parent days with manual override
  isBackfilled: boolean
  backfillLagDays: number         // calendar days from appliesToDay to recordedAt; 0 if not backfilled
}

// Per-child breakdown used by the parent observation builder.
// Each map entry is the child item's observations over the same window.
export type ChildObservationMap = Map<string, DayObservation[]>  // childItemId → observations

// One entry per completed session in the window.
// startedAt is the real clock start time (for context stability analysis).
export type SessionObservation = {
  sessionId: string
  day: string              // applies_to_day YYYY-MM-DD
  durationMin: number
  startedAt: Date          // actual clock start (UTC)
  source: 'live' | 'manual'
  isAdHoc: boolean         // item.creationSource === 'ad_hoc'
  categoryId: string | null
  valence: string | null
  plannedDurationMin: number | null  // from item template
  itemId: string
}

// One entry per rescheduled event in the window.
export type RescheduleObservation = {
  originalDay: string   // applies_to_day of the rescheduled event
  newDay: string        // payload.newDay (where it was pushed to)
  recordedAt: Date
  reasonId: string | null
}

// One entry per retroactive_completion event in the window.
export type BackfillObservation = {
  day: string          // applies_to_day (the day being completed)
  recordedAt: Date     // when the completion was actually logged
  lagDays: number      // calendar days from day to recordedAt
  itemId: string
}
