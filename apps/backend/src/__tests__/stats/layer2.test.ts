// v2 Step 2b — Layer 2 Finding structure, estimator routing, scope guards,
// structural floors, and power/MDE reporting.
//
// Test names are derived from the spec's stated rules (CLAUDE.md discipline).
// All tests are purely unit-level (no DB) — the observation-array seam (§9.1.1)
// makes this possible: calculators are pure functions from arrays to findings.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, it, expect } from 'vitest'

import type { DayObservation, SessionObservation } from '../../stats/types'
import type { DataQualityFinding, DateWindow, RecurrenceRule } from '@tracker/shared'

import { computeContextStability } from '../../stats/calculators/context-stability'
import { computeAutocorrelation } from '../../stats/calculators/autocorrelation'
import { computeTrajectory } from '../../stats/calculators/trajectory'
import { computeDayOfWeek, classifyDayOfWeekScope } from '../../stats/calculators/day-of-week'
import { computeTwoCondition } from '../../stats/calculators/two-condition'
import { olsRegression } from '../../stats/primitives/regression'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WINDOW: DateWindow = { startDay: '2025-01-01', endDay: '2025-12-31' }
const USER_ID = 'user-test-001'
const ITEM_ID = 'item-test-001'

const STUB_DQ: DataQualityFinding = {
  type: 'data_quality',
  userId: USER_ID,
  itemId: ITEM_ID,
  window: WINDOW,
  rawCounts: {
    dueCount: 10,
    materializedCount: 10,
    explicitDispositionCount: 8,
    autoClosedCount: 0,
    missingCount: 0,
    backfilledCompletionCount: 0,
  },
  dispositionCoverage: { rate: 0.8, missingRate: 0 },
  backfillLateness: null,
  declaredOverrideFrequency: null,
  timeTrackingGap: null,
  gapDays: [],
}

// Build n DayObservations starting from startDay, cycling through pattern.
function makeDayObs(
  startDay: string,
  n: number,
  pattern: ('completed' | 'missed' | 'excused')[] = ['completed', 'missed']
): DayObservation[] {
  const result: DayObservation[] = []
  const base = new Date(startDay + 'T12:00:00Z')
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() + i * 86_400_000)
    const day = d.toISOString().slice(0, 10)
    const p = pattern[i % pattern.length]
    result.push({
      day,
      completionPercent: p === 'completed' ? 100 : 0,
      disposition: p === 'excused' ? 'excused' : p === 'completed' ? 'completed' : 'auto_closed',
      declaredPercent: null,
      isBackfilled: false,
      backfillLagDays: 0,
    })
  }
  return result
}

// Build SessionObservations with given start hours (fractional UTC hour, 0–24).
function makeSessionObs(startDay: string, hours: number[]): SessionObservation[] {
  const base = new Date(startDay + 'T00:00:00Z')
  return hours.map((h, i) => {
    const dayMs = base.getTime() + i * 86_400_000
    const dayStr = new Date(dayMs).toISOString().slice(0, 10)
    const startedAt = new Date(dayStr + 'T00:00:00Z')
    startedAt.setUTCHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0)
    return {
      sessionId: `sess-${i}`,
      day: dayStr,
      durationMin: 30,
      startedAt,
      source: 'live' as const,
      isAdHoc: false,
      categoryId: null,
      valence: null,
      plannedDurationMin: null,
      itemId: ITEM_ID,
    }
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Finding structure — every Layer 2 Finding carries required fields
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.2 every Layer 2 finding carries power, effectSize, rawCounts, estimator, dataQuality', () => {
  it('ContextStabilityFinding carries all required Layer 2 fields', () => {
    const sessions = makeSessionObs('2025-01-06', [9, 9.5, 9.2, 8.8, 9.1, 9.3])
    const f = computeContextStability(ITEM_ID, USER_ID, WINDOW, sessions, STUB_DQ)
    expect(f.estimator).toBe('variance')
    expect(typeof f.effectSize).toBe('number')
    expect(typeof f.power).toBe('number')
    expect(typeof f.minimumDetectableEffect).toBe('number')
    expect(f.rawCounts).toBeDefined()
    expect(f.dataQuality).toBe(STUB_DQ)
    expect(f.sufficiency).toBeDefined()
    expect(f.userId).toBe(USER_ID)
    expect(f.itemId).toBe(ITEM_ID)
  })

  it('AutocorrelationFinding carries all required Layer 2 fields', () => {
    const obs = makeDayObs('2025-01-01', 60)
    const f = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimator).toBe('lag1_correlation')
    expect(typeof f.effectSize).toBe('number')
    expect(typeof f.power).toBe('number')
    expect(typeof f.minimumDetectableEffect).toBe('number')
    expect(f.rawCounts).toBeDefined()
    expect(f.dataQuality).toBe(STUB_DQ)
    expect(f.sufficiency).toBeDefined()
    expect(f.userId).toBe(USER_ID)
  })

  it('TrajectoryFinding carries all required Layer 2 fields', () => {
    const obs = makeDayObs('2025-01-01', 90)
    const f = computeTrajectory(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimator).toBe('regression')
    expect(typeof f.effectSize).toBe('number')
    expect(typeof f.power).toBe('number')
    expect(typeof f.minimumDetectableEffect).toBe('number')
    expect(f.rawCounts).toBeDefined()
    expect(f.dataQuality).toBe(STUB_DQ)
    expect(f.sufficiency).toBeDefined()
    expect(f.userId).toBe(USER_ID)
  })

  it('DayOfWeekFinding carries all required Layer 2 fields', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.estimator).toBe('permutation_k7')
    expect(typeof f.power).toBe('number')
    expect(f.rawCounts).toBeDefined()
    expect(f.dataQuality).toBe(STUB_DQ)
    expect(f.sufficiency).toBeDefined()
    expect(f.userId).toBe(USER_ID)
  })

  it('TwoConditionFinding carries all required Layer 2 fields', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimator).toBe('permutation_k2')
    expect(typeof f.power).toBe('number')
    expect(f.rawCounts).toBeDefined()
    expect(f.dataQuality).toBe(STUB_DQ)
    expect(f.sufficiency).toBeDefined()
    expect(f.userId).toBe(USER_ID)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 2. Structural floor — k=2 requires n ≥ 6; k=7 has no binding p-floor
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.1.1 Finding A structural floor: k=2 requires n ≥ 6; test cannot fire below this', () => {
  it('k=2 with n=5 paired periods reports below_floor and no p-value', () => {
    // 5 weeks = 35 days → 5 paired weekday/weekend weeks (< 6 floor)
    const obs = makeDayObs('2025-01-05', 35)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('below_floor')
    expect(f.pValue).toBeNull()
    expect(f.effectSize).toBeNull()
  })

  it('k=2 with n=6 paired periods is computable and reports a p-value', () => {
    const obs = makeDayObs('2025-01-05', 42)  // 6 complete weeks
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('computable')
    expect(f.pValue).not.toBeNull()
  })

  it('k=2 below_floor reason explicitly mentions p_min > α and nNeeded=6', () => {
    const obs = makeDayObs('2025-01-05', 35)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('below_floor')
    if (f.sufficiency.status === 'below_floor') {
      expect(f.sufficiency.reason.toLowerCase()).toMatch(/p.min|p_min/)
      expect(f.sufficiency.nNeeded).toBe(6)
    }
  })

  it('k=7 with n=1 complete week is computable — no binding p-floor (§5.1.1 Finding C)', () => {
    const obs = makeDayObs('2025-01-05', 7)   // exactly 1 Sun–Sat week
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.scopeStatus).toBe('applicable')
    expect(f.sufficiency.status).toBe('computable')
    expect(f.pValue).not.toBeNull()
  })

  it('k=7 with n=2 weeks is computable with reported (low) power', () => {
    const obs = makeDayObs('2025-01-05', 14)
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('computable')
    expect(typeof f.power).toBe('number')
    expect(f.power).toBeGreaterThanOrEqual(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 3. No stale thresholds — n≥5 and n≥10 do not gate any finding
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.1.1 no stale thresholds: n≥5 and n≥10 do not gate any finding', () => {
  it('autocorrelation with n=5 observations is computable (no n≥10 gate)', () => {
    const obs = makeDayObs('2025-01-01', 5)
    const f = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('computable')
    expect(typeof f.lag1).toBe('number')
  })

  it('trajectory with n=2 months is computable (no n≥5 gate)', () => {
    const obs = makeDayObs('2025-01-01', 60)  // 2 months
    const f = computeTrajectory(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('computable')
  })

  it('context stability with n=5 sessions is computable (no n≥5 floor that blocks compute)', () => {
    const sessions = makeSessionObs('2025-01-06', [9, 9.5, 10, 8.8, 9.1])
    const f = computeContextStability(ITEM_ID, USER_ID, WINDOW, sessions, STUB_DQ)
    expect(f.sufficiency.status).toBe('computable')
  })

  it('day-of-week k=7 with n=5 weeks is computable (no n≥5 or n≥10 floor)', () => {
    const obs = makeDayObs('2025-01-05', 35)
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.scopeStatus).toBe('applicable')
    expect(f.sufficiency.status).toBe('computable')
    expect(f.pValue).not.toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 4. Estimator routing — correct estimator for each insight (Finding F)
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.3.1 estimator routing: correct estimator for each insight', () => {
  it('context stability uses variance estimator, not a permutation test', () => {
    const sessions = makeSessionObs('2025-01-06', [9, 9.5, 10, 8.8, 9.1, 9.3])
    const f = computeContextStability(ITEM_ID, USER_ID, WINDOW, sessions, STUB_DQ)
    expect(f.estimator).toBe('variance')
    expect(f.type).toBe('context_stability')
    // The variance estimator produces circularVariance, not a permutation p-value
    expect(f.circularVariance).toBeDefined()
  })

  it('autocorrelation uses lag1_correlation estimator, not a permutation test', () => {
    const obs = makeDayObs('2025-01-01', 60)
    const f = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimator).toBe('lag1_correlation')
    expect(f.type).toBe('autocorrelation')
    expect(typeof f.lag1).toBe('number')
    expect(typeof f.standardError).toBe('number')
  })

  it('trajectory uses regression estimator, not a permutation test', () => {
    const obs = makeDayObs('2025-01-01', 90)
    const f = computeTrajectory(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimator).toBe('regression')
    expect(f.type).toBe('trajectory')
    expect(typeof f.slope).toBe('number')
    expect(typeof f.rSquared).toBe('number')
  })

  it('day-of-week uses permutation_k7 estimator', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.estimator).toBe('permutation_k7')
    expect(f.type).toBe('day_of_week')
  })

  it('two-condition uses permutation_k2 estimator', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimator).toBe('permutation_k2')
    expect(f.type).toBe('two_condition')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 5. Scope guards — day-of-week
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.3.1 scope classification: day-of-week applies to daily habits only', () => {
  it('daily recurrence → applicable', () => {
    expect(classifyDayOfWeekScope({ type: 'daily' })).toBe('applicable')
  })

  it('all-7-days-of-week → applicable (equivalent to daily)', () => {
    expect(classifyDayOfWeekScope({ type: 'days_of_week', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('applicable')
  })

  it('every-1-day interval → applicable', () => {
    expect(classifyDayOfWeekScope({ type: 'interval', unit: 'day', every: 1 })).toBe('applicable')
  })

  it('4×/week (days_of_week, 4 days) → not_detectable, never pending', () => {
    expect(classifyDayOfWeekScope({ type: 'days_of_week', days: [1, 2, 4, 5] })).toBe('not_detectable')
  })

  it('3×/week → not_detectable', () => {
    expect(classifyDayOfWeekScope({ type: 'days_of_week', days: [1, 3, 5] })).toBe('not_detectable')
  })

  it('every-other-day (interval 2 days) → not_detectable', () => {
    expect(classifyDayOfWeekScope({ type: 'interval', unit: 'day', every: 2 })).toBe('not_detectable')
  })

  it('1-day-per-week (single day_of_week) → undefined', () => {
    expect(classifyDayOfWeekScope({ type: 'days_of_week', days: [3] })).toBe('undefined')
  })

  it('weekly interval → undefined', () => {
    expect(classifyDayOfWeekScope({ type: 'interval', unit: 'week', every: 1 })).toBe('undefined')
  })

  it('monthly → undefined', () => {
    expect(classifyDayOfWeekScope({ type: 'monthly' })).toBe('undefined')
  })

  it('no recurrence rule (one-time task) → undefined', () => {
    expect(classifyDayOfWeekScope(null)).toBe('undefined')
  })
})

describe('§5.3.1 scope guard: 4×/week habit returns not_detectable status, never silent accumulation', () => {
  it('4×/week with many observations stays not_detectable (never converts to pending)', () => {
    const obs = makeDayObs('2025-01-01', 200)
    const rule: RecurrenceRule = { type: 'days_of_week', days: [1, 2, 4, 5] }
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, rule, obs, STUB_DQ)
    expect(f.scopeStatus).toBe('not_detectable')
    expect(f.pValue).toBeNull()
    expect(f.effectSize).toBeNull()
  })

  it('weekly habit returns scopeStatus=undefined, not silent, not missing', () => {
    const obs = makeDayObs('2025-01-01', 52)
    const rule: RecurrenceRule = { type: 'days_of_week', days: [3] }
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, rule, obs, STUB_DQ)
    expect(f.scopeStatus).toBe('undefined')
    expect(f.type).toBe('day_of_week')   // finding always exists, just with no test
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 6. k=2 low power is reported, not hidden
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.1.1 Finding B: k=2 low power is reported and labelled', () => {
  it('two-condition finding reports measured power even when it is low', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(typeof f.power).toBe('number')
    expect(f.power).toBeGreaterThanOrEqual(0)
    expect(f.power).toBeLessThanOrEqual(1)
  })

  it('weekday-vs-weekend finding is computed and labeled with real power, not suppressed', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.conditionA).toBe('weekday')
    expect(f.conditionB).toBe('weekend')
    expect(f.power).toBeDefined()
    expect(f.sufficiency.status).toBe('computable')
    // estimatedRho is present so the user can see why power may be low
    expect(typeof f.estimatedRho).toBe('number')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 7. Null results ship with MDE and dataQuality — never bare
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.2 null results must ship with MDE and dataQuality (never bare)', () => {
  it('autocorrelation null result always has MDE and dataQuality', () => {
    const obs = makeDayObs('2025-01-01', 50, ['completed', 'missed'])
    const f = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(typeof f.minimumDetectableEffect).toBe('number')
    expect(f.dataQuality).toBeDefined()
  })

  it('trajectory null result (flat adherence) always has MDE and dataQuality', () => {
    const obs = makeDayObs('2025-01-01', 90, ['completed'])
    const f = computeTrajectory(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(typeof f.minimumDetectableEffect).toBe('number')
    expect(f.dataQuality).toBeDefined()
  })

  it('context stability below-floor result has MDE and dataQuality', () => {
    const sessions = makeSessionObs('2025-01-06', [9])  // 1 session < 2 floor
    const f = computeContextStability(ITEM_ID, USER_ID, WINDOW, sessions, STUB_DQ)
    expect(f.sufficiency.status).toBe('below_floor')
    expect(typeof f.minimumDetectableEffect).toBe('number')
    expect(f.dataQuality).toBeDefined()
  })

  it('k=2 below-floor result has dataQuality', () => {
    const obs = makeDayObs('2025-01-05', 35)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.sufficiency.status).toBe('below_floor')
    expect(f.dataQuality).toBeDefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 8. Autocorrelation feeds power reporting for permutation-based findings
// ══════════════════════════════════════════════════════════════════════════════

describe('§5.3 autocorrelation estimate feeds power reporting for permutation findings', () => {
  it('day-of-week finding exposes estimatedRho (the ρ used for power calculation)', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.estimatedRho).not.toBeNull()
    expect(typeof f.estimatedRho).toBe('number')
  })

  it('two-condition finding exposes estimatedRho (the ρ used for power calculation)', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.estimatedRho).not.toBeNull()
    expect(typeof f.estimatedRho).toBe('number')
  })

  it('streaky data has positive estimatedRho; near-random data has smaller positive ρ', () => {
    // Runs of 8 identical outcomes → strong positive autocorrelation
    const streaky = makeDayObs('2025-01-05', 56, [
      'completed', 'completed', 'completed', 'completed',
      'completed', 'completed', 'completed', 'completed',
      'missed', 'missed', 'missed', 'missed',
      'missed', 'missed', 'missed', 'missed',
    ])
    // Near-random: 5 hits then 1 miss repeating → weaker autocorrelation
    const nearRandom = makeDayObs('2025-01-05', 56, [
      'completed', 'completed', 'completed', 'completed', 'completed', 'missed',
    ])

    const fStreaky    = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, streaky, STUB_DQ)
    const fNearRandom = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, nearRandom, STUB_DQ)

    // Streaky has strong positive autocorrelation
    expect(fStreaky.estimatedRho).toBeGreaterThan(0.3)
    // Both expose estimatedRho (the main requirement: it feeds power reporting)
    expect(typeof fStreaky.estimatedRho).toBe('number')
    expect(typeof fNearRandom.estimatedRho).toBe('number')
    // Streaky has higher ρ than near-random (which has shorter runs)
    expect(fStreaky.estimatedRho!).toBeGreaterThan(fNearRandom.estimatedRho!)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 9. Seam purity — statistics modules have zero domain knowledge
// ══════════════════════════════════════════════════════════════════════════════

describe('§9.1.1 seam purity: statistics primitives have zero DB or domain imports', () => {
  const primitivesDir = path.resolve(__dirname, '../../stats/primitives')
  const primitiveFiles = ['permutation.ts', 'synth.ts', 'power.ts', 'regression.ts']

  it.each(primitiveFiles)('%s does not import from db or repos', (file) => {
    const src = fs.readFileSync(path.join(primitivesDir, file), 'utf8')
    expect(src).not.toMatch(/from ['"].*\/db['"]/)
    expect(src).not.toMatch(/from ['"].*\/repos['"]/)
  })

  it.each(primitiveFiles)('%s does not import from domain observation builders', (file) => {
    const src = fs.readFileSync(path.join(primitivesDir, file), 'utf8')
    // Only match actual import statements, not comments or strings
    const importLines = src.split('\n').filter(l => l.trimStart().startsWith('import'))
    for (const line of importLines) {
      expect(line, `${file}: import line should not reference domain`).not.toMatch(/\/domain\//)
      expect(line, `${file}: import line should not reference observations`).not.toMatch(/observations/)
    }
  })

  it('Layer 2 calculators do not import from db or repos', () => {
    const calcDir = path.resolve(__dirname, '../../stats/calculators')
    const layer2Calcs = [
      'context-stability.ts',
      'autocorrelation.ts',
      'trajectory.ts',
      'day-of-week.ts',
      'two-condition.ts',
    ]
    for (const file of layer2Calcs) {
      const src = fs.readFileSync(path.join(calcDir, file), 'utf8')
      expect(src, `${file} must not import from db`).not.toMatch(/from ['"].*\/db['"]/)
      expect(src, `${file} must not import from repos`).not.toMatch(/from ['"].*\/repos['"]/)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 10. Determinism — seeded; same inputs → same output
// ══════════════════════════════════════════════════════════════════════════════

describe('§9.6 determinism: same inputs → identical Layer 2 finding', () => {
  it('day-of-week finding is deterministic (same p-value on repeated calls)', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const rule: RecurrenceRule = { type: 'daily' }
    const f1 = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, rule, obs, STUB_DQ)
    const f2 = computeDayOfWeek(ITEM_ID, USER_ID, WINDOW, rule, obs, STUB_DQ)
    expect(f1.pValue).toBe(f2.pValue)
    expect(f1.effectSize).toBe(f2.effectSize)
    expect(f1.power).toBe(f2.power)
  })

  it('two-condition finding is deterministic', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f1 = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    const f2 = computeTwoCondition(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f1.pValue).toBe(f2.pValue)
    expect(f1.power).toBe(f2.power)
  })

  it('autocorrelation finding is deterministic (analytical, no RNG)', () => {
    const obs = makeDayObs('2025-01-01', 50)
    const f1 = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    const f2 = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f1.lag1).toBe(f2.lag1)
    expect(f1.pValue).toBe(f2.pValue)
  })

  it('trajectory finding is deterministic (OLS is exact)', () => {
    const obs = makeDayObs('2025-01-01', 90)
    const f1 = computeTrajectory(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    const f2 = computeTrajectory(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f1.slope).toBe(f2.slope)
    expect(f1.pValue).toBe(f2.pValue)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 11. user_id scoping on every insight
// ══════════════════════════════════════════════════════════════════════════════

describe('§13.4 user_id is present and correct on every Layer 2 finding', () => {
  const OTHER_USER = 'user-other-002'

  it('ContextStabilityFinding carries the correct userId', () => {
    const sessions = makeSessionObs('2025-01-06', [9, 9.5, 10])
    const f = computeContextStability(ITEM_ID, OTHER_USER, WINDOW, sessions, STUB_DQ)
    expect(f.userId).toBe(OTHER_USER)
  })

  it('AutocorrelationFinding carries the correct userId', () => {
    const obs = makeDayObs('2025-01-01', 10)
    const f = computeAutocorrelation(ITEM_ID, OTHER_USER, WINDOW, obs, STUB_DQ)
    expect(f.userId).toBe(OTHER_USER)
  })

  it('TrajectoryFinding carries the correct userId', () => {
    const obs = makeDayObs('2025-01-01', 60)
    const f = computeTrajectory(ITEM_ID, OTHER_USER, WINDOW, obs, STUB_DQ)
    expect(f.userId).toBe(OTHER_USER)
  })

  it('DayOfWeekFinding carries the correct userId', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeDayOfWeek(ITEM_ID, OTHER_USER, WINDOW, { type: 'daily' }, obs, STUB_DQ)
    expect(f.userId).toBe(OTHER_USER)
  })

  it('TwoConditionFinding carries the correct userId', () => {
    const obs = makeDayObs('2025-01-05', 56)
    const f = computeTwoCondition(ITEM_ID, OTHER_USER, WINDOW, obs, STUB_DQ)
    expect(f.userId).toBe(OTHER_USER)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Known-value fixtures for statistical primitives
// ══════════════════════════════════════════════════════════════════════════════

describe('OLS regression known-answer fixtures', () => {
  it('perfect positive linear trend: slope=0.1, intercept=0.3, R²=1', () => {
    // y = 0.3 + 0.1x for x = 0..4
    const x = [0, 1, 2, 3, 4]
    const y = [0.3, 0.4, 0.5, 0.6, 0.7]
    const r = olsRegression(x, y)
    expect(r.slope).toBeCloseTo(0.1, 10)
    expect(r.intercept).toBeCloseTo(0.3, 10)
    expect(r.rSquared).toBeCloseTo(1.0, 5)
    expect(r.residualSD).toBeCloseTo(0, 5)
    expect(r.pValue).toBeLessThan(0.001)
  })

  it('perfectly flat data: slope=0, R²=0, p-value=1', () => {
    const x = [0, 1, 2, 3]
    const y = [0.5, 0.5, 0.5, 0.5]
    const r = olsRegression(x, y)
    expect(r.slope).toBeCloseTo(0, 10)
    expect(r.pValue).toBeCloseTo(1, 5)
    expect(r.rSquared).toBeCloseTo(0, 5)
  })

  it('negative trend: slope=-0.1', () => {
    const x = [0, 1, 2, 3, 4]
    const y = [0.7, 0.6, 0.5, 0.4, 0.3]
    const r = olsRegression(x, y)
    expect(r.slope).toBeCloseTo(-0.1, 10)
    expect(r.rSquared).toBeCloseTo(1.0, 5)
  })
})

describe('circular variance known-answer fixtures for context stability', () => {
  it('all sessions at exactly the same time → circularVariance ≈ 0 (perfect consistency)', () => {
    const sessions = makeSessionObs('2025-01-06', Array(10).fill(9))
    const f = computeContextStability(ITEM_ID, USER_ID, WINDOW, sessions, STUB_DQ)
    expect(f.circularVariance).toBeCloseTo(0, 3)
    expect(f.circularMeanHour).toBeCloseTo(9, 1)
    expect(f.effectSize).toBeCloseTo(0, 3)
  })

  it('sessions uniformly spread across all 24 hours → circularVariance close to 1 (maximum spread)', () => {
    const hours = Array.from({ length: 24 }, (_, i) => i)
    const sessions = makeSessionObs('2025-01-06', hours)
    const f = computeContextStability(ITEM_ID, USER_ID, WINDOW, sessions, STUB_DQ)
    expect(f.circularVariance).toBeGreaterThan(0.9)
  })

  it('power increases with more sessions at the same time (Rayleigh test)', () => {
    const h10 = Array(10).fill(9)
    const h30 = Array(30).fill(9)
    const f10 = computeContextStability(ITEM_ID, USER_ID, WINDOW, makeSessionObs('2025-01-06', h10), STUB_DQ)
    const f30 = computeContextStability(ITEM_ID, USER_ID, WINDOW, makeSessionObs('2025-01-06', h30), STUB_DQ)
    expect(f30.power).toBeGreaterThan(f10.power)
  })
})

describe('lag-1 autocorrelation known-answer fixtures', () => {
  it('strict alternating series (0,1,0,1,…) → lag-1 ρ < -0.5 (anti-persistent)', () => {
    const obs = makeDayObs('2025-01-01', 20, ['completed', 'missed'])
    const f = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.lag1).toBeLessThan(-0.5)
  })

  it('all-completed series → zero-variance lag-1 returns 0', () => {
    const obs = makeDayObs('2025-01-01', 20, ['completed'])
    const f = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, obs, STUB_DQ)
    expect(f.lag1).toBeCloseTo(0, 5)
    expect(f.effectSize).toBeCloseTo(0, 5)
  })

  it('power increases with longer series (more data → better detection)', () => {
    const f20 = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, makeDayObs('2025-01-01', 20), STUB_DQ)
    const f60 = computeAutocorrelation(ITEM_ID, USER_ID, WINDOW, makeDayObs('2025-01-01', 60), STUB_DQ)
    // More observations → higher power to detect ρ ≥ 0.28
    expect(f60.power).toBeGreaterThan(f20.power)
  })
})
