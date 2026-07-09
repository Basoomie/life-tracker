// §5.3 item 3 — Day-of-week adherence calculator (k=7 permutation test).
//
// Pure function: Item recurrence type + DayObservation[] + DataQualityFinding
//               → DayOfWeekFinding.
// No DB access, no domain knowledge beyond the item's recurrence character.
//
// Estimator: within-period permutation test (step 2a, k=7).
// Scope guard: daily habits ONLY.  For 4×/week → 'not_detectable'; for weekly
// or one-time → 'undefined'.  Explicit status, never silent accumulation (§5.3.1).
//
// Period structure: each calendar week (Sun–Sat) is one period containing 7
// observations (one per day-of-week).  groups[dow][weekIndex].
//
// Autocorrelation estimate: uses the full day series lag-1 (same as
// autocorrelation.ts) — the spec requires this to feed into power reporting.
//
// Power: measured via measurePermutationPower at d=0.8, observed n, estimated ρ.

import type { DayObservation } from '../types'
import type {
  DayOfWeekFinding,
  DayOfWeekScopeStatus,
  DateWindow,
  DataQualityFinding,
} from '@tracker/shared'
import type { RecurrenceRule } from '@tracker/shared'
import { permutationTest, computeMDE } from '../primitives/permutation'
import { measureLag1Autocorrelation } from '../primitives/synth'
import { measurePermutationPower } from '../primitives/power'

// ── Day-of-week labels ────────────────────────────────────────────────────────

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Scope classification ──────────────────────────────────────────────────────

/**
 * Classify whether day-of-week analysis is applicable for this item's recurrence.
 * §5.3.1 scope note: "Day-of-week applies to daily habits only."
 */
export function classifyDayOfWeekScope(recurrenceRule: RecurrenceRule | null): DayOfWeekScopeStatus {
  if (!recurrenceRule) return 'undefined'   // one-time task

  switch (recurrenceRule.type) {
    case 'daily':
      return 'applicable'

    case 'days_of_week': {
      const { days } = recurrenceRule
      if (days.length === 7) return 'applicable'    // every day — same as daily
      if (days.length === 1) return 'undefined'     // once per week — one bucket per week
      return 'not_detectable'                       // 2–6 days/week
    }

    case 'interval':
      if (recurrenceRule.unit === 'day' && recurrenceRule.every === 1)  return 'applicable'
      if (recurrenceRule.unit === 'week' && recurrenceRule.every === 1) return 'undefined'
      return 'not_detectable'

    case 'monthly':
      return 'undefined'

    default:
      return 'undefined'
  }
}

// ── Week grouping ─────────────────────────────────────────────────────────────

type WeekGroups = {
  groups: number[][]   // groups[dayOfWeek=0..6][weekIndex]
  nCompleteWeeks: number
  dayMeans: Array<{ dayOfWeek: number; label: string; mean: number; n: number }>
}

/**
 * Build k=7 groups from day observations.
 * Each period = one calendar Sun–Sat week.
 * Only complete weeks (all 7 days present in the observation list) are included.
 * Missing dispositions contribute 0 completion (data gap = 0 adherence, consistent
 * with §3.1's raw adherence definition).
 */
function buildWeekGroups(dayObs: DayObservation[]): WeekGroups {
  // Map week-start (Sunday ISO date) → { dow: completion }
  const weekMap = new Map<string, Map<number, number>>()

  for (const obs of dayObs) {
    const date = new Date(obs.day + 'T12:00:00Z')
    const dow = date.getUTCDay()   // 0=Sun … 6=Sat
    const sundayOffset = dow       // days since Sunday
    const sundayMs = date.getTime() - sundayOffset * 86_400_000
    const weekKey = new Date(sundayMs).toISOString().slice(0, 10)

    if (!weekMap.has(weekKey)) weekMap.set(weekKey, new Map())
    weekMap.get(weekKey)!.set(dow, obs.completionPercent / 100)
  }

  // Collect complete weeks (all 7 days present), sorted chronologically
  const completeWeeks = Array.from(weekMap.entries())
    .filter(([, days]) => days.size === 7)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, days]) => days)

  const nCompleteWeeks = completeWeeks.length

  // Build groups[dow][weekIndex]
  const groups: number[][] = Array.from({ length: 7 }, () => [])
  for (const weekDays of completeWeeks) {
    for (let dow = 0; dow < 7; dow++) {
      groups[dow].push(weekDays.get(dow) ?? 0)
    }
  }

  // Day means
  const dayMeans = groups.map((g, dow) => ({
    dayOfWeek: dow,
    label: DOW_LABELS[dow],
    mean: g.length > 0 ? g.reduce((s, v) => s + v, 0) / g.length : 0,
    n: g.length,
  }))

  return { groups, nCompleteWeeks, dayMeans }
}

// ── Flat series for autocorrelation estimate ──────────────────────────────────

function buildSeries(dayObs: DayObservation[]): number[] {
  return [...dayObs]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(obs => obs.completionPercent / 100)
}

// ── Calculator ────────────────────────────────────────────────────────────────

const SEED = 1_234_567   // fixed seed for day-of-week permutation test

/**
 * §5.3 — Compute day-of-week adherence finding (k=7 permutation test).
 *
 * @param itemId         item being analysed
 * @param userId         user scope
 * @param window         date window
 * @param recurrenceRule item's recurrence rule (used for scope classification)
 * @param dayObs         DayObservation[] for this item in the window
 * @param dataQuality    pre-computed DataQualityFinding
 * @param nPermutations  permutations for the test (default 1000)
 * @param alpha          nominal α (default 0.05)
 * @param targetPower    target power for MDE (default 0.80)
 */
export function computeDayOfWeek(
  itemId: string,
  userId: string,
  window: DateWindow,
  recurrenceRule: RecurrenceRule | null,
  dayObs: DayObservation[],
  dataQuality: DataQualityFinding,
  nPermutations = 1000,
  alpha = 0.05,
  targetPower = 0.80
): DayOfWeekFinding {
  const nDueDays = dayObs.length
  const scopeStatus = classifyDayOfWeekScope(recurrenceRule)

  // Not-applicable cases: return finding with scope status but no test results
  if (scopeStatus !== 'applicable') {
    return {
      type: 'day_of_week',
      estimator: 'permutation_k7',
      userId,
      itemId,
      window,
      scopeStatus,
      estimatedRho: null,
      pValue: null,
      effectSize: null,
      observedStatistic: null,
      dayMeans: null,
      power: 0,
      minimumDetectableEffect: null,
      rawCounts: { nWeeks: 0, nDueDays, nConditions: 7 },
      dataQuality,
      sufficiency: {
        status: 'below_floor',
        reason: scopeStatus === 'not_detectable'
          ? 'day-of-week effect is not detectable in any practical timeframe for non-daily habits'
          : 'day-of-week concept is undefined for weekly or one-time items',
        nObserved: 0,
        nNeeded: 0,
      },
    }
  }

  // Estimate autocorrelation from the full day series (feeds into power reporting)
  const series = buildSeries(dayObs)
  const estimatedRho = measureLag1Autocorrelation(series)

  // Build week groups
  const { groups, nCompleteWeeks, dayMeans } = buildWeekGroups(dayObs)

  // k=7 has no binding p-floor per §5.1.1 Finding C — always 'computable' if we have ≥ 1 week
  if (nCompleteWeeks < 1) {
    return {
      type: 'day_of_week',
      estimator: 'permutation_k7',
      userId,
      itemId,
      window,
      scopeStatus,
      estimatedRho,
      pValue: null,
      effectSize: null,
      observedStatistic: null,
      dayMeans: null,
      power: 0,
      minimumDetectableEffect: computeMDE(1, alpha, targetPower),
      rawCounts: { nWeeks: 0, nDueDays, nConditions: 7 },
      dataQuality,
      sufficiency: {
        status: 'below_floor',
        reason: 'day-of-week requires at least 1 complete week of observations',
        nObserved: nCompleteWeeks,
        nNeeded: 1,
      },
    }
  }

  // Run permutation test
  const testResult = permutationTest(groups, SEED, nPermutations, alpha, targetPower)

  // Measure power at d=0.8 using estimated ρ from the real data (§test requirement)
  const power = measurePermutationPower(7, nCompleteWeeks, Math.max(0, estimatedRho))

  return {
    type: 'day_of_week',
    estimator: 'permutation_k7',
    userId,
    itemId,
    window,
    scopeStatus,
    estimatedRho,
    pValue: testResult.pValue,
    effectSize: testResult.effectSize,
    observedStatistic: testResult.observedStatistic,
    dayMeans,
    power,
    minimumDetectableEffect: testResult.minimumDetectableEffect,
    rawCounts: { nWeeks: nCompleteWeeks, nDueDays, nConditions: 7 },
    dataQuality,
    sufficiency: { status: 'computable' },
  }
}
