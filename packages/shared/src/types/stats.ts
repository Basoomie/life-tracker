// v2 Layer 1 / 1.5 — Stats finding types shared between backend and frontend.
//
// Every finding includes rawCounts (the honesty mechanism: the user can always see
// what was counted to produce a headline stat). Layer 2 will extend these types
// with sufficiencyStatus, effectSize, pValue, and minimumDetectableEffect fields.
//
// §3.5 — Calculators are individually-defined, independently-computable functions;
// these types represent their output, not a fixed dashboard.

export type DateWindow = {
  startDay: string   // YYYY-MM-DD inclusive
  endDay: string     // YYYY-MM-DD inclusive
}

// ── §3.1 Adherence ────────────────────────────────────────────────────────────

// Leaf adherence: binary hit-rate per §3.1.
// rawAdherence = completedCount / dueCount (includes excused in denominator — the default).
// adherenceExclExcused = completedCount / (dueCount - excusedCount).
// excuseRate = excusedCount / (dueCount - completedCount) — excused share of misses.
export type LeafAdherenceFinding = {
  type: 'leaf_adherence'
  userId: string
  itemId: string
  window: DateWindow
  rawCounts: {
    dueCount: number
    completedCount: number
    excusedCount: number
    skippedCount: number
    autoCloseCount: number
    missingCount: number        // due days with no materialized occurrence (data gap)
  }
  rawAdherence: number            // default headline (§3.1: including excused)
  adherenceExclExcused: number    // secondary lens
  excuseRate: number              // contextualizes lower adherence
}

// Child adherence — same shape as leaf, used within ParentAdherenceFinding.
export type ChildAdherenceFinding = Omit<LeafAdherenceFinding, 'type'> & {
  type: 'child_adherence'
}

// Parent adherence: mean of daily derived percentages per §3.1.
// Derived drives headlines; declared (manual parent %) is a logging diagnostic.
// children is ALWAYS present — the per-child breakdown is the actionable information.
export type ParentAdherenceFinding = {
  type: 'parent_adherence'
  userId: string
  itemId: string
  window: DateWindow
  rawCounts: {
    dueCount: number
    excusedCount: number
    missingCount: number
    declaredOverrideCount: number   // days with manual_parent_percent_declared event
  }
  meanDerivedPercent: number          // default headline
  meanDerivedExclExcused: number      // excluding excused days
  excuseRate: number
  children: ChildAdherenceFinding[]   // always present per §3.1
}

export type AdherenceFinding = LeafAdherenceFinding | ParentAdherenceFinding

// ── §3.2 Streaks ──────────────────────────────────────────────────────────────

// Polymorphic per v1 §10.4: daily → consecutive days; quota → consecutive periods.
// Excused days skip the chain (neither break nor extend) per §3.2.
// Note: streaks are a display affordance, NOT an analytical primitive — Layer 2
// reasons in rates over windows, never streaks (§5.3).
export type StreakFinding = {
  type: 'streak'
  userId: string
  itemId: string
  window: DateWindow
  streakType: 'daily' | 'quota'
  rawCounts: {
    dueCount: number
    completedCount: number
    excusedCount: number
  }
  currentStreak: number
  longestStreak: number
}

// ── §3.3 Time ────────────────────────────────────────────────────────────────

export type SessionDistributionEntry = {
  hour: number      // UTC hour 0–23
  count: number
  totalMin: number
}

// Per-item time stats: total, planned-vs-actual, and start-time distribution.
// The start-time distribution is the raw material for context stability (§4.2 / Layer 2).
export type TimeStatsFinding = {
  type: 'time_stats'
  userId: string
  itemId: string
  window: DateWindow
  rawCounts: {
    sessionCount: number
    liveSessions: number
    manualSessions: number
  }
  totalMin: number
  plannedDurationMin: number | null        // from item snapshot; null = no goal set
  plannedVsActualDeltaMin: number | null   // null when no planned duration
  sessionStartDistribution: SessionDistributionEntry[]
}

// Cross-item ad-hoc share: planned vs unplanned time, unplanned by valence.
// Pure counting — directly serves "how am I actually spending my days."
export type AdHocShareFinding = {
  type: 'adhoc_share'
  userId: string
  window: DateWindow
  rawCounts: {
    totalSessions: number
    plannedSessions: number
    adHocSessions: number
  }
  totalTrackedMin: number
  plannedMin: number
  adHocMin: number
  adHocShare: number    // adHocMin / totalTrackedMin; 0 when no sessions
  adHocByValence: {
    productive: number
    unproductive: number
    neutral: number
    unclassified: number
  }
}

// ── §3.4 Procrastination ──────────────────────────────────────────────────────

export type ProcrastinationFinding = {
  type: 'procrastination'
  userId: string
  itemId: string
  window: DateWindow
  rawCounts: {
    rescheduleCount: number
    backfilledCompletions: number
    totalCompletions: number
  }
  rescheduleCount: number
  longestRescheduleChain: number   // consecutive pushes following newDay links
  backfillStats: {
    count: number
    medianLagDays: number
    maxLagDays: number
  }
}

// ── §4 Layer 1.5 — Data Quality / Logging Health ─────────────────────────────

// Always shown; never gated. Useful from day one. Interpretive lens for Layer 2.
export type DataQualityFinding = {
  type: 'data_quality'
  userId: string
  itemId: string | null   // null = user-wide quality check
  window: DateWindow
  rawCounts: {
    dueCount: number
    materializedCount: number
    explicitDispositionCount: number   // skip/excuse/rescheduled/completed events
    autoClosedCount: number
    missingCount: number               // due days with no materialized occurrence
    backfilledCompletionCount: number
  }
  dispositionCoverage: {
    rate: number         // (explicit + autoClosed) / dueCount
    missingRate: number  // missingCount / dueCount
  }
  // null when there are no completions in the window (no lateness to measure)
  backfillLateness: {
    count: number
    medianLagDays: number
    p75LagDays: number
    proportionOver1Day: number
    proportionOver3Days: number
  } | null
  // null for non-parent items
  declaredOverrideFrequency: number | null
  // null for per-item queries; meaningful at user level
  timeTrackingGap: {
    itemsWithPlannedDuration: number
    itemsWithSessions: number
    coverageRate: number
  } | null
  gapDays: string[]   // due days with no materialized occurrence (YYYY-MM-DD)
}
