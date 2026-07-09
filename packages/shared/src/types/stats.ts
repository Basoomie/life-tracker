// v2 Layer 1 / 1.5 / 2 — Stats finding types shared between backend and frontend.
//
// Every Layer 1/1.5 finding includes rawCounts (the honesty mechanism).
// Every Layer 2 finding additionally carries power, effectSize, estimator,
// minimumDetectableEffect, dataQuality, and sufficiency (§5.2).
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

// ══════════════════════════════════════════════════════════════════════════════
// §5 Layer 2 — Inference
// ══════════════════════════════════════════════════════════════════════════════

// ── §5.3.1 Estimator tiers ────────────────────────────────────────────────────
// Each insight is computed with the correct estimator for its question.
// Finding F (calibration): not every insight uses a permutation test.
// Three have far better statistical properties by not using it.
export type Layer2Estimator =
  | 'variance'          // context stability — circular variance, no permutation
  | 'lag1_correlation'  // autocorrelation — direct lag-1 estimate, no permutation
  | 'regression'        // trajectory — OLS slope, no permutation
  | 'permutation_k7'   // day-of-week — within-period permutation, k=7
  | 'permutation_k2'   // two-condition — within-period permutation, k=2

// ── Sufficiency status (§5.2) ─────────────────────────────────────────────────
// Hard structural floors from calibration (§5.1.1 Finding A):
//   k=2 → n ≥ 6 (below that, p_min > α; test cannot fire)
//   k=7 → no binding p-floor (permutation space is (7!)^n, astronomically small)
// Other estimators: floor = minimum needed to compute (typically n ≥ 2).
// Binary gate is REPLACED by power + MDE reporting (§5.2 — see individual findings).
export type SufficiencyStatus =
  | {
      status: 'below_floor'
      reason: string     // e.g. 'k=2 requires n ≥ 6 (p_min > α); test cannot fire'
      nObserved: number
      nNeeded: number    // minimum n to reach the floor
    }
  | { status: 'computable' }

// ── Scope status for day-of-week insight ─────────────────────────────────────
// Applied per §5.3.1 scope note: "Day-of-week applies to daily habits only."
// The system must say so explicitly rather than silently accumulating.
export type DayOfWeekScopeStatus =
  | 'applicable'       // daily habit (recurrenceRule.type === 'daily' or all-7-days)
  | 'not_detectable'   // non-daily recurring (4×/week etc.) — cannot arrive in any practical timeframe
  | 'undefined'        // weekly or one-time — concept has no meaning (one observation per bucket)

// ── §5.3 Context Stability ────────────────────────────────────────────────────
// Variance in WHEN the user performs each habit; not a permutation test.
// Estimator: circular variance of session start-times (UTC hour, 0–24).
// Informative: weeks 4–8 (many observations/week → SE shrinks quickly).
// Circular statistics are used because time wraps at 0/24h.
export type ContextStabilityFinding = {
  type: 'context_stability'
  estimator: 'variance'
  userId: string
  itemId: string
  window: DateWindow
  // Circular mean start-time (UTC fractional hour, 0–24)
  circularMeanHour: number
  // Circular variance ∈ [0, 1]; 0 = all sessions at the same time; 1 = maximum spread
  circularVariance: number
  // effectSize = circularVariance (the dispersion itself is the measured effect)
  effectSize: number
  // power = Rayleigh-test power: P(detect non-uniform timing | observed R̄, n)
  power: number
  // minimumDetectableEffect: minimum circularVariance detectable at this n and 80% power
  // (i.e., the minimum R̄ = 1 − MDE_R that the Rayleigh test would reliably detect)
  minimumDetectableEffect: number
  rawCounts: {
    nSessions: number
    nDays: number   // distinct days with at least one session
  }
  dataQuality: DataQualityFinding
  sufficiency: SufficiencyStatus
}

// ── §5.3 Autocorrelation (streakiness) ───────────────────────────────────────
// Lag-1 correlation estimated directly from the adherence series.
// SE ≈ 1/√n. Not a permutation test (Finding F).
// First-class finding: meaningful alone ("misses cluster") AND determines whether
// permutation-based tests can work on that item at all (§5.3 item 5).
export type AutocorrelationFinding = {
  type: 'autocorrelation'
  estimator: 'lag1_correlation'
  userId: string
  itemId: string
  window: DateWindow
  // Estimated lag-1 autocorrelation ρ̂
  lag1: number
  // Standard error ≈ 1/√n (Bartlett's formula)
  standardError: number
  // Two-tailed p-value for H₀: ρ = 0
  pValue: number
  // effectSize = |lag1| (the autocorrelation IS the effect; analogous to d ≥ 0.8)
  effectSize: number
  // power = Φ(|ρ_target| × √n − z_{α/2}) where ρ_target = 0.28 (spec threshold)
  power: number
  // minimumDetectableEffect: minimum |ρ| detectable at this n and 80% power
  minimumDetectableEffect: number
  rawCounts: {
    nObservations: number   // n in the lag-1 formula (length of series)
    nDueDays: number        // days item was due (non-missing)
  }
  dataQuality: DataQualityFinding
  sufficiency: SufficiencyStatus
}

// ── §5.3 Trajectory ───────────────────────────────────────────────────────────
// Regression slope of adherence over months. Not a permutation test.
// Informative: 2–5 months ("automaticity accrues gradually").
export type TrajectoryFinding = {
  type: 'trajectory'
  estimator: 'regression'
  userId: string
  itemId: string
  window: DateWindow
  // Adherence change per month (0–1 scale; positive = improving, negative = declining)
  slope: number
  intercept: number
  rSquared: number
  // Two-tailed p-value for H₀: slope = 0
  pValue: number
  // effectSize = |slope| × √nMonths / residual SD (standardised)
  effectSize: number
  // power = P(detect slope ≠ 0 | observed slope, n months, observed residual SD)
  power: number
  // minimumDetectableEffect: minimum |slope|/month detectable at this n
  minimumDetectableEffect: number
  rawCounts: {
    nMonths: number
    nDueDaysTotal: number
  }
  dataQuality: DataQualityFinding
  sufficiency: SufficiencyStatus
}

// ── §5.3 Day-of-Week Adherence (k=7) ─────────────────────────────────────────
// Permutation test using the within-period scheme from step 2a.
// Scope guard: daily habits only (§5.3.1).
// Power: preliminary ~26 weeks; solid ~1 year (d ≥ 1.0, daily habit).
export type DayOfWeekFinding = {
  type: 'day_of_week'
  estimator: 'permutation_k7'
  userId: string
  itemId: string
  window: DateWindow
  // Scope guard — if not 'applicable', all test fields are null
  scopeStatus: DayOfWeekScopeStatus
  // Estimated lag-1 autocorrelation (used for power reporting per test requirement)
  estimatedRho: number | null
  // Permutation test results (null when not applicable or below floor)
  pValue: number | null
  effectSize: number | null          // max pairwise Cohen's d
  observedStatistic: number | null   // max pairwise |mean_best − mean_worst|
  // Per-day means (null when not applicable)
  dayMeans: Array<{ dayOfWeek: number; label: string; mean: number; n: number }> | null
  // Power at d=0.8, observed n and estimated ρ (0 when not applicable)
  power: number
  minimumDetectableEffect: number | null
  rawCounts: {
    nWeeks: number
    nDueDays: number
    nConditions: number   // 7
  }
  dataQuality: DataQualityFinding
  sufficiency: SufficiencyStatus
}

// ── §5.3 Two-Condition Comparisons (k=2) ──────────────────────────────────────
// Permutation test. Usually low power under realistic autocorrelation.
// §5.1.1 Finding B: 4.8% power at n=20, d=0.8, ρ=0.5.
// Weekday-vs-weekend: provably powerless; still computed and labeled with real power.
export type TwoConditionFinding = {
  type: 'two_condition'
  estimator: 'permutation_k2'
  userId: string
  itemId: string
  window: DateWindow
  conditionA: string   // label, e.g. 'weekday'
  conditionB: string   // label, e.g. 'weekend'
  // Estimated lag-1 autocorrelation (used for power reporting)
  estimatedRho: number | null
  // Permutation test results (null when below floor)
  pValue: number | null
  effectSize: number | null         // Cohen's d (conditionA vs conditionB)
  observedStatistic: number | null  // |mean_A − mean_B|
  meanA: number | null
  meanB: number | null
  // Power at d=0.8, observed n and estimated ρ
  power: number
  minimumDetectableEffect: number | null
  rawCounts: {
    nPeriodsA: number   // periods (weeks) with conditionA observations
    nPeriodsB: number   // same for conditionB (should equal nPeriodsA)
    nDueDays: number
  }
  dataQuality: DataQualityFinding
  sufficiency: SufficiencyStatus
}

export type Layer2Finding =
  | ContextStabilityFinding
  | AutocorrelationFinding
  | TrajectoryFinding
  | DayOfWeekFinding
  | TwoConditionFinding
