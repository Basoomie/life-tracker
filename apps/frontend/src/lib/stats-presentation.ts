// v2 §5.2/§5.3.1/§9.5.1 — pure presentation helpers shared by the Stats views.
//
// No component-specific JSX here — just the honest-by-construction classification
// logic the presentation rule depends on: sufficiency/scope tri-state, power tiers,
// and the handful of triage thresholds used only for compact global-view markers
// (never treated as inference — Layer 1.5 data quality is fact, not gated).

import type {
  SufficiencyStatus,
  DayOfWeekScopeStatus,
  DataQualityFinding,
  AdherenceFinding,
  TrajectoryFinding,
  AdHocShareFinding,
} from '@tracker/shared'
import { todayStr, addDays } from './date-range'

// ── Window selection ─────────────────────────────────────────────────────────
// Stats need wider horizons than List/Calendar's day/week/month ranges — Layer 2
// estimators only become informative over weeks to months (§5.3.1).

export type StatsWindowKey = 'this-month' | 'last-3-months' | 'this-year' | 'all-time'

export const STATS_WINDOW_OPTIONS: { key: StatsWindowKey; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-3-months', label: 'Last 3 months' },
  { key: 'this-year', label: 'This year' },
  { key: 'all-time', label: 'All time' },
]

// Fixed floor rather than each item's creation date — the window just needs to be
// wide enough to include everything a single-user install could have logged.
const ALL_TIME_START = '2000-01-01'

export function getStatsWindow(key: StatsWindowKey, ref: Date = new Date()): { startDay: string; endDay: string } {
  const today = todayStr(ref)
  if (key === 'this-month') return { startDay: today.slice(0, 7) + '-01', endDay: today }
  if (key === 'last-3-months') return { startDay: addDays(today, -90), endDay: today }
  if (key === 'this-year') return { startDay: today.slice(0, 4) + '-01-01', endDay: today }
  return { startDay: ALL_TIME_START, endDay: today }
}

// ── Sufficiency tri-state (§9.5.1: reported / "not yet" / "not detectable") ──

export type PresentedSufficiency =
  | { kind: 'reported' }
  | { kind: 'not_yet'; reason: string; nObserved: number; nNeeded: number }
  | { kind: 'not_applicable'; reason: string }

export function presentSufficiency(sufficiency: SufficiencyStatus): PresentedSufficiency {
  if (sufficiency.status === 'computable') return { kind: 'reported' }
  return {
    kind: 'not_yet',
    reason: sufficiency.reason,
    nObserved: sufficiency.nObserved,
    nNeeded: sufficiency.nNeeded,
  }
}

// Day-of-week carries a scope guard ABOVE the sufficiency floor (§5.3.1): a
// non-daily habit will never reach 'computable' in any practical timeframe. That
// is a permanent fact about the recurrence, not a pending one — it must render as
// a terminal state, never as "accumulating."
export function presentDayOfWeekSufficiency(
  scopeStatus: DayOfWeekScopeStatus,
  sufficiency: SufficiencyStatus
): PresentedSufficiency {
  if (scopeStatus === 'not_detectable') {
    return {
      kind: 'not_applicable',
      reason:
        'Not detectable for this recurrence — day-of-week patterns need a daily habit to resolve; this item isn’t due every day.',
    }
  }
  if (scopeStatus === 'undefined') {
    return {
      kind: 'not_applicable',
      reason:
        'Day-of-week doesn’t apply here — a weekly or one-time item has only one observation per day-of-week bucket.',
    }
  }
  return presentSufficiency(sufficiency)
}

// ── Power ─────────────────────────────────────────────────────────────────────
// Thresholds are a presentation choice (the spec sets no fixed cut points), used
// only to decide how much visual weight a reported finding gets — never to gate
// whether it's shown. Power always ships with the finding regardless of tier.

export type PowerTier = 'weak' | 'moderate' | 'strong'

export function powerTier(power: number): PowerTier {
  if (power < 0.4) return 'weak'
  if (power < 0.7) return 'moderate'
  return 'strong'
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatPercent(x: number): string {
  return `${Math.round(x * 100)}%`
}

export function formatSignedPercent(x: number): string {
  const pct = Math.round(x * 100)
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

// ── Global-view triage markers (compact signals only; full honesty lives in the
// per-item FindingShell cards — these never claim to BE a finding) ────────────

// Arbitrary, documented thresholds for a compact flag — not an inference.
export function hasLoggingHealthIssue(dq: DataQualityFinding): boolean {
  if (dq.dispositionCoverage.missingRate > 0.2) return true
  if (dq.backfillLateness && dq.backfillLateness.proportionOver3Days > 0.3) return true
  return false
}

export function adherenceHeadline(adherence: AdherenceFinding): number {
  return adherence.type === 'parent_adherence' ? adherence.meanDerivedPercent : adherence.rawAdherence
}

export function needsAttention(adherence: AdherenceFinding): boolean {
  return adherenceHeadline(adherence) < 0.5
}

export type TrajectoryDirection = 'up' | 'down' | 'flat' | 'unknown'

// 'unknown' covers both "not yet" and "not applicable" — the global row shows a
// neutral dash either way; the honest breakdown of which is which lives on the
// per-item Trajectory FindingShell, not in this compact triage cue.
export function trajectoryDirection(finding: TrajectoryFinding): TrajectoryDirection {
  if (presentSufficiency(finding.sufficiency).kind !== 'reported') return 'unknown'
  if (Math.abs(finding.slope) < 0.01) return 'flat'
  return finding.slope > 0 ? 'up' : 'down'
}

// ── Cross-item facts (§9.5.1: the only home for genuinely cross-item facts) ──

export function plannedShare(finding: AdHocShareFinding): number {
  return finding.totalTrackedMin > 0 ? finding.plannedMin / finding.totalTrackedMin : 0
}

export function unproductiveShareOfAdHoc(finding: AdHocShareFinding): number {
  const v = finding.adHocByValence
  const total = v.productive + v.unproductive + v.neutral + v.unclassified
  return total > 0 ? v.unproductive / total : 0
}
