// §5.3 item 5 — Autocorrelation (streakiness) calculator.
//
// Pure function: DayObservation[] + DataQualityFinding → AutocorrelationFinding.
// No DB access, no domain knowledge.  Statistics side of the §9.1.1 seam.
//
// Estimator: lag-1 correlation directly from the single series, SE ≈ 1/√n.
// Not a permutation test (§5.3.1 Finding F).
// Detectable above zero at ρ ≥ 0.28 in ~7 weeks of a daily habit.
//
// First-class finding per §5.3 item 5:
//   - Meaningful alone ("misses cluster; this habit is streaky")
//   - Determines whether permutation-based tests can work on that item at all
//
// The autocorrelation estimate from this finding feeds into the power calculation
// of permutation-based findings for the same item (day-of-week, two-condition).

import type { DayObservation } from '../types'
import type { AutocorrelationFinding, DateWindow, DataQualityFinding } from '@tracker/shared'
import { measureLag1Autocorrelation } from '../primitives/synth'
import { analyticPowerLag1, analyticMDELag1, normalCDF } from '../primitives/power'

// Minimum interesting |ρ| per §5.3: "detectable above zero at ρ ≥ 0.28 in ~7 weeks"
const RHO_MIN = 0.28

/**
 * §5.3 — Compute autocorrelation (streakiness) from the item's adherence series.
 *
 * The input series is the completionPercent / 100 for each due day in order.
 * Missing days (data gaps) are included as 0 — they are a real part of the
 * behavioral signal (the user didn't log that day at all).
 *
 * @param itemId      item being analysed
 * @param userId      user scope
 * @param window      date window
 * @param dayObs      DayObservation[] for this item in the window (in date order)
 * @param dataQuality pre-computed DataQualityFinding for the same item and window
 * @param alpha       nominal α (default 0.05)
 * @param targetPower target power for MDE (default 0.80)
 */
export function computeAutocorrelation(
  itemId: string,
  userId: string,
  window: DateWindow,
  dayObs: DayObservation[],
  dataQuality: DataQualityFinding,
  alpha = 0.05,
  targetPower = 0.80
): AutocorrelationFinding {
  // Build the adherence series (0/1 for leaf; 0–1 for parent derived %)
  // Sort by day to ensure temporal order.
  const sorted = [...dayObs].sort((a, b) => a.day.localeCompare(b.day))
  const series = sorted.map(obs => obs.completionPercent / 100)
  const n = series.length
  const nDueDays = sorted.filter(obs => obs.disposition !== 'missing').length

  if (n < 2) {
    return {
      type: 'autocorrelation',
      estimator: 'lag1_correlation',
      userId,
      itemId,
      window,
      lag1: 0,
      standardError: n === 1 ? 1 : Infinity,
      pValue: 1,
      effectSize: 0,
      power: 0,
      minimumDetectableEffect: analyticMDELag1(n, alpha, targetPower),
      rawCounts: { nObservations: n, nDueDays },
      dataQuality,
      sufficiency: {
        status: 'below_floor',
        reason: 'lag-1 autocorrelation requires at least 2 observations',
        nObserved: n,
        nNeeded: 2,
      },
    }
  }

  const lag1 = measureLag1Autocorrelation(series)
  // Bartlett's SE approximation for lag-1 under H₀: ρ=0
  const standardError = 1 / Math.sqrt(n)
  // Two-tailed z-test: H₀: ρ=0
  const zStat = lag1 / standardError
  const pValue = 2 * (1 - normalCDF(Math.abs(zStat)))

  const power = analyticPowerLag1(n, RHO_MIN, alpha)
  const mde   = analyticMDELag1(n, alpha, targetPower)

  return {
    type: 'autocorrelation',
    estimator: 'lag1_correlation',
    userId,
    itemId,
    window,
    lag1,
    standardError,
    pValue,
    effectSize: Math.abs(lag1),
    power,
    minimumDetectableEffect: mde,
    rawCounts: { nObservations: n, nDueDays },
    dataQuality,
    sufficiency: { status: 'computable' },
  }
}
