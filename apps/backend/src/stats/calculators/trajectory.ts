// §5.3 item 4 — Trajectory calculator.
//
// Pure function: DayObservation[] + DataQualityFinding → TrajectoryFinding.
// No DB access, no domain knowledge.  Statistics side of the §9.1.1 seam.
//
// Estimator: OLS regression slope of monthly adherence over months.
// Not a permutation test (§5.3.1 Finding F).
// Informative: 2–5 months ("automaticity accrues gradually rather than at a threshold").
//
// Monthly adherence = completedCount / dueCount per calendar month (including excused
// in denominator, consistent with §3.1's default headline measure).
// Months are indexed 0, 1, 2, … in order (x-axis = elapsed months, not calendar date),
// so the slope is in units of adherence/month.

import type { DayObservation } from '../types'
import type { TrajectoryFinding, DateWindow, DataQualityFinding } from '@tracker/shared'
import { olsRegression } from '../primitives/regression'
import { regressionPower, regressionMDE } from '../primitives/power'

// ── Month bucketing ───────────────────────────────────────────────────────────

type MonthBucket = { month: string; dueCount: number; completedCount: number }

function bucketByMonth(dayObs: DayObservation[]): MonthBucket[] {
  const map = new Map<string, MonthBucket>()

  for (const obs of dayObs) {
    const month = obs.day.slice(0, 7)  // YYYY-MM
    if (!map.has(month)) map.set(month, { month, dueCount: 0, completedCount: 0 })
    const bucket = map.get(month)!
    bucket.dueCount++
    if (obs.completionPercent >= 100) bucket.completedCount++
  }

  // Return sorted chronologically
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month))
}

// ── Calculator ────────────────────────────────────────────────────────────────

/**
 * §5.3 — Compute trajectory (slope of adherence over months).
 *
 * @param itemId      item being analysed
 * @param userId      user scope
 * @param window      date window (should span at least 2 calendar months)
 * @param dayObs      DayObservation[] for this item in the window
 * @param dataQuality pre-computed DataQualityFinding
 * @param alpha       nominal α (default 0.05)
 * @param targetPower target power for MDE (default 0.80)
 */
export function computeTrajectory(
  itemId: string,
  userId: string,
  window: DateWindow,
  dayObs: DayObservation[],
  dataQuality: DataQualityFinding,
  alpha = 0.05,
  targetPower = 0.80
): TrajectoryFinding {
  const nDueDaysTotal = dayObs.length
  const months = bucketByMonth(dayObs)
  const nMonths = months.length

  if (nMonths < 2) {
    return {
      type: 'trajectory',
      estimator: 'regression',
      userId,
      itemId,
      window,
      slope: 0,
      intercept: nMonths === 1 && months[0].dueCount > 0
        ? months[0].completedCount / months[0].dueCount
        : 0,
      rSquared: 0,
      pValue: 1,
      effectSize: 0,
      power: 0,
      minimumDetectableEffect: 0,
      rawCounts: { nMonths, nDueDaysTotal },
      dataQuality,
      sufficiency: {
        status: 'below_floor',
        reason: 'trajectory regression requires at least 2 calendar months of data',
        nObserved: nMonths,
        nNeeded: 2,
      },
    }
  }

  // x = month index (0, 1, 2, …); y = monthly adherence rate ∈ [0, 1]
  const x = months.map((_, i) => i)
  const y = months.map(m => m.dueCount > 0 ? m.completedCount / m.dueCount : 0)

  const ols = olsRegression(x, y)

  // Effect size for regression: |slope| normalised by residual SD × √nMonths
  // Analogous to Cohen's d: how many SD of noise does the slope traverse per month?
  const effectSize = ols.residualSD > 0
    ? (Math.abs(ols.slope) * Math.sqrt(nMonths)) / ols.residualSD
    : 0

  const power = regressionPower(nMonths, ols.slope, ols.residualSD, alpha)
  const mde   = regressionMDE(nMonths, ols.residualSD, alpha, targetPower)

  return {
    type: 'trajectory',
    estimator: 'regression',
    userId,
    itemId,
    window,
    slope: ols.slope,
    intercept: ols.intercept,
    rSquared: ols.rSquared,
    pValue: ols.pValue,
    effectSize,
    power,
    minimumDetectableEffect: mde,
    rawCounts: { nMonths, nDueDaysTotal },
    dataQuality,
    sufficiency: { status: 'computable' },
  }
}
