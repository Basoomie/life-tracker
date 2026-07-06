// Fixed enumerated sets used across items, occurrences, and events.
// These are TypeScript union literals — the DB stores TEXT with CHECK constraints
// using the same string values.

export type Priority = 'high' | 'medium' | 'low'

export type Valence = 'productive' | 'unproductive' | 'neutral'

// §6.5 — one of four timing precision levels; promotable/editable between them
export type TimingPrecision = 'none' | 'bucket' | 'point' | 'range'

// §9.2 — planned item vs spontaneous item; lives on the creation event, not the kind
export type CreationSource = 'planned' | 'ad_hoc'

// §8.1 — per-item policy for what happens when due-but-untouched at end of day
export type DispositionPolicy = 'skip' | 'excuse' | 'auto_close'

// §5.1 — recurrence rule stored as JSONB; null = one-time task
export type RecurrenceRule =
  | { type: 'daily' }
  | { type: 'days_of_week'; days: number[] }    // 0=Sun … 6=Sat
  | { type: 'interval'; unit: 'day' | 'week'; every: number }
  | { type: 'monthly' }

// §5.2 — stats-only target; not a scheduling mode
export type QuotaTarget = {
  count: number
  period: 'week' | 'month'
}
