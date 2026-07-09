// §5.3 item 3 (k=2) — Two-condition adherence calculator (weekday vs. weekend).
//
// Pure function: DayObservation[] + DataQualityFinding → TwoConditionFinding.
// No DB access, no domain knowledge.  Statistics side of the §9.1.1 seam.
//
// Estimator: within-period permutation test, k=2.
//
// §5.1.1 Finding B — this is provably near-powerless under realistic autocorrelation:
//   4.8% power at n=20, d=0.8, ρ=0.5.
// §5.3.1 scope note: "Weekday-vs-weekend is a k=2 comparison — provably powerless
//   under realistic autocorrelation. Implement it if it falls out naturally, but it
//   MUST report its real power; do not present it as a viable shortcut to day-of-week."
//
// Hard floor: k=2 requires n ≥ 6 periods (§5.1.1 Finding A: p_min = 1/2^(n−1)).
//
// Period structure: each calendar Sun–Sat week provides:
//   conditionA (weekday, Mon–Fri, DOW 1–5) → mean of up to 5 values
//   conditionB (weekend, Sat–Sun, DOW 0,6) → mean of up to 2 values
// Only complete weeks where both conditions have at least one observation are used.
//
// Autocorrelation estimate: lag-1 from the full day series, used for power reporting.

import type { DayObservation } from '../types'
import type { TwoConditionFinding, DateWindow, DataQualityFinding } from '@tracker/shared'
import { permutationTest, computeMDE } from '../primitives/permutation'
import { measureLag1Autocorrelation } from '../primitives/synth'
import { measurePermutationPower } from '../primitives/power'

// ── Two-condition grouping ────────────────────────────────────────────────────

// Weekday condition: Mon–Fri (DOW 1–5)
function isWeekday(dow: number): boolean { return dow >= 1 && dow <= 5 }

type PairedGroups = {
  groupA: number[]   // one entry per complete week: mean weekday adherence
  groupB: number[]   // one entry per complete week: mean weekend adherence
  nDueDays: number
}

/**
 * Build k=2 paired groups from day observations.
 * Each period = one calendar Sun–Sat week.
 * A period is included only if it has at least one weekday AND one weekend observation.
 * Per-period values are the MEAN adherence within that condition in that week.
 * Pairing within a period is valid for within-period permutation.
 */
function buildTwoConditionGroups(dayObs: DayObservation[]): PairedGroups {
  const weekMap = new Map<string, { a: number[]; b: number[] }>()

  for (const obs of dayObs) {
    const date = new Date(obs.day + 'T12:00:00Z')
    const dow = date.getUTCDay()
    const sundayMs = date.getTime() - dow * 86_400_000
    const weekKey = new Date(sundayMs).toISOString().slice(0, 10)

    if (!weekMap.has(weekKey)) weekMap.set(weekKey, { a: [], b: [] })
    const entry = weekMap.get(weekKey)!
    const val = obs.completionPercent / 100
    if (isWeekday(dow)) entry.a.push(val)
    else entry.b.push(val)
  }

  const groupA: number[] = []
  const groupB: number[] = []

  // Sort weeks chronologically, keep only those where both conditions have observations
  for (const [, { a, b }] of Array.from(weekMap.entries()).sort(([k1], [k2]) => k1.localeCompare(k2))) {
    if (a.length === 0 || b.length === 0) continue
    groupA.push(a.reduce((s, v) => s + v, 0) / a.length)
    groupB.push(b.reduce((s, v) => s + v, 0) / b.length)
  }

  return { groupA, groupB, nDueDays: dayObs.length }
}

// ── Calculator ────────────────────────────────────────────────────────────────

const SEED = 7_654_321   // fixed seed for two-condition permutation test

// Hard floor: k=2 requires n ≥ 6 (§5.1.1 Finding A: p_min = 1/2^(n−1) > α=0.05 for n ≤ 5)
const K2_MIN_N = 6

/**
 * §5.3 — Compute weekday-vs-weekend two-condition finding.
 *
 * @param itemId         item being analysed
 * @param userId         user scope
 * @param window         date window
 * @param dayObs         DayObservation[] for this item in the window
 * @param dataQuality    pre-computed DataQualityFinding
 * @param nPermutations  permutations for the test (default 1000)
 * @param alpha          nominal α (default 0.05)
 * @param targetPower    target power for MDE (default 0.80)
 */
export function computeTwoCondition(
  itemId: string,
  userId: string,
  window: DateWindow,
  dayObs: DayObservation[],
  dataQuality: DataQualityFinding,
  nPermutations = 1000,
  alpha = 0.05,
  targetPower = 0.80
): TwoConditionFinding {
  const { groupA, groupB, nDueDays } = buildTwoConditionGroups(dayObs)
  const n = groupA.length  // number of paired periods (weeks)

  // Estimate autocorrelation from the full day series (feeds into power reporting per spec)
  const series = [...dayObs]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(obs => obs.completionPercent / 100)
  const estimatedRho = measureLag1Autocorrelation(series)

  // Hard floor: k=2 requires n ≥ 6 (p_min = 1/2^(n−1) > α for n ≤ 5)
  if (n < K2_MIN_N) {
    return {
      type: 'two_condition',
      estimator: 'permutation_k2',
      userId,
      itemId,
      window,
      conditionA: 'weekday',
      conditionB: 'weekend',
      estimatedRho,
      pValue: null,
      effectSize: null,
      observedStatistic: null,
      meanA: groupA.length > 0 ? groupA.reduce((s, v) => s + v, 0) / groupA.length : null,
      meanB: groupB.length > 0 ? groupB.reduce((s, v) => s + v, 0) / groupB.length : null,
      power: 0,
      minimumDetectableEffect: n > 0 ? computeMDE(n, alpha, targetPower) : null,
      rawCounts: { nPeriodsA: groupA.length, nPeriodsB: groupB.length, nDueDays },
      dataQuality,
      sufficiency: {
        status: 'below_floor',
        reason: `k=2 requires n ≥ ${K2_MIN_N} paired periods (p_min > α below this); test cannot fire`,
        nObserved: n,
        nNeeded: K2_MIN_N,
      },
    }
  }

  // Run permutation test
  const testResult = permutationTest([groupA, groupB], SEED, nPermutations, alpha, targetPower)

  // Measure power at d=0.8 using estimated ρ from real data (§test requirement)
  const power = measurePermutationPower(2, n, Math.max(0, estimatedRho))

  const meanA = groupA.reduce((s, v) => s + v, 0) / groupA.length
  const meanB = groupB.reduce((s, v) => s + v, 0) / groupB.length

  return {
    type: 'two_condition',
    estimator: 'permutation_k2',
    userId,
    itemId,
    window,
    conditionA: 'weekday',
    conditionB: 'weekend',
    estimatedRho,
    pValue: testResult.pValue,
    effectSize: testResult.effectSize,
    observedStatistic: testResult.observedStatistic,
    meanA,
    meanB,
    power,
    minimumDetectableEffect: testResult.minimumDetectableEffect,
    rawCounts: { nPeriodsA: groupA.length, nPeriodsB: groupB.length, nDueDays },
    dataQuality,
    sufficiency: { status: 'computable' },
  }
}
