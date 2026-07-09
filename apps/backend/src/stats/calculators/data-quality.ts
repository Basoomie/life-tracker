// §4 — Layer 1.5 Data Quality / Logging Health calculator.
//
// Pure function: observation arrays → DataQualityFinding.  No DB access.
// Always shown; never gated.  Useful from day one — the interpretive lens
// every Layer 2 finding must be read through.
//
// Metrics (§4.2):
//   - Backfill lateness distribution (recorded-at vs applies-to)
//   - Proportion of due items receiving an explicit disposition vs. auto-closed
//   - Parent-override frequency (declared vs. derived)
//   - Time-tracking coverage against planned durations
//   - Gaps in the record

import type { DayObservation, BackfillObservation, SessionObservation } from '../types'
import type { DataQualityFinding, DateWindow } from '@tracker/shared'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

/**
 * §4 — Compute data quality finding.
 *
 * @param dayObs       Due-day observations for the item (or all items for user-wide)
 * @param backfills    Retroactive completion events in the window
 * @param sessionStats Optional: for time-tracking coverage (user-wide only)
 */
export function computeDataQuality(
  userId: string,
  itemId: string | null,
  window: DateWindow,
  dayObs: DayObservation[],
  backfills: BackfillObservation[],
  sessionStats?: Array<{ hasPlannedDuration: boolean; hasSessions: boolean }>,
  isParent = false
): DataQualityFinding {
  // ── Disposition coverage ──────────────────────────────────────────────────

  let materializedCount = 0
  let explicitDispositionCount = 0  // completed / skipped / excused / rescheduled
  let autoClosedCount = 0
  let missingCount = 0
  const gapDays: string[] = []
  let declaredOverrideTotal = 0
  let declaredOverrideParentDays = 0   // days that had a parent observation

  for (const obs of dayObs) {
    if (obs.disposition === 'missing') {
      missingCount++
      gapDays.push(obs.day)
    } else {
      materializedCount++
      if (obs.disposition === 'auto_closed') {
        autoClosedCount++
      } else if (obs.disposition !== 'pending') {
        explicitDispositionCount++
      }
      // Parent-override frequency: declaredPercent non-null means declared override used
      if (obs.declaredPercent !== null) {
        declaredOverrideTotal++
      }
      if (obs.declaredPercent !== null || obs.disposition !== 'missing') {
        // Track only observations where declaredPercent could be applicable (i.e., parent obs)
        if ('declaredPercent' in obs && obs.declaredPercent !== null) {
          declaredOverrideParentDays++
        }
      }
    }
  }

  const dueCount = dayObs.length
  const dispositionRate = dueCount === 0 ? 1 : (explicitDispositionCount + autoClosedCount) / dueCount
  const missingRate = dueCount === 0 ? 0 : missingCount / dueCount

  // ── Backfill lateness ─────────────────────────────────────────────────────

  const lags = backfills.map(b => b.lagDays).sort((a, b) => a - b)
  const backfillLateness = lags.length === 0 ? null : {
    count: lags.length,
    medianLagDays: percentile(lags, 0.5),
    p75LagDays: percentile(lags, 0.75),
    proportionOver1Day: lags.filter(l => l > 1).length / lags.length,
    proportionOver3Days: lags.filter(l => l > 3).length / lags.length,
  }

  // ── Parent-override frequency ─────────────────────────────────────────────

  // declaredOverrideFrequency = proportion of materialized parent days using declared override.
  // null for non-parent items (isParent=false); null when no materialized days exist.
  const parentDays = dayObs.filter(o => o.disposition !== 'missing' && o.declaredPercent !== null).length
  const totalParentDays = dayObs.filter(o => o.disposition !== 'missing').length
  const declaredOverrideFrequency =
    (isParent && totalParentDays > 0)
      ? parentDays / totalParentDays
      : null

  // ── Time-tracking coverage (user-wide only) ───────────────────────────────

  let timeTrackingGap: DataQualityFinding['timeTrackingGap'] = null
  if (sessionStats && sessionStats.length > 0) {
    const withPlan = sessionStats.filter(s => s.hasPlannedDuration).length
    const withSessions = sessionStats.filter(s => s.hasSessions).length
    const coverage = withPlan === 0 ? 1 : withSessions / withPlan
    timeTrackingGap = {
      itemsWithPlannedDuration: withPlan,
      itemsWithSessions: withSessions,
      coverageRate: coverage,
    }
  }

  return {
    type: 'data_quality',
    userId,
    itemId,
    window,
    rawCounts: {
      dueCount,
      materializedCount,
      explicitDispositionCount,
      autoClosedCount,
      missingCount,
      backfilledCompletionCount: backfills.length,
    },
    dispositionCoverage: {
      rate: dispositionRate,
      missingRate,
    },
    backfillLateness,
    declaredOverrideFrequency,
    timeTrackingGap,
    gapDays,
  }
}
