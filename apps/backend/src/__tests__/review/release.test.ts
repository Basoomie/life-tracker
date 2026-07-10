// v2 §2 / §5.4 / §9.6 Category 4 — release.ts: the gate that turns Findings into what the
// prompt builder is allowed to see. Named after the spec rules each test verifies.

import { describe, it, expect } from 'vitest'
import * as release from '../../review/release'
import type {
  LeafAdherenceFinding,
  ParentAdherenceFinding,
  DataQualityFinding,
  ContextStabilityFinding,
  AutocorrelationFinding,
  TrajectoryFinding,
  DayOfWeekFinding,
  TwoConditionFinding,
  EvidenceEntry,
} from '@tracker/shared'

const WINDOW = { startDay: '2026-01-01', endDay: '2026-01-31' }
const USER_ID = 'u1'
const ITEM_ID = 'item1'

function stubDataQuality(overrides: Partial<DataQualityFinding> = {}): DataQualityFinding {
  return {
    type: 'data_quality',
    userId: USER_ID,
    itemId: ITEM_ID,
    window: WINDOW,
    rawCounts: {
      dueCount: 10, materializedCount: 10, explicitDispositionCount: 8,
      autoClosedCount: 1, missingCount: 0, backfilledCompletionCount: 1,
    },
    dispositionCoverage: { rate: 0.9, missingRate: 0 },
    backfillLateness: { count: 1, medianLagDays: 1, p75LagDays: 1, proportionOver1Day: 0, proportionOver3Days: 0 },
    declaredOverrideFrequency: null,
    timeTrackingGap: null,
    gapDays: [],
    ...overrides,
  }
}

describe('§3.1 releaseAdherence', () => {
  it('releases a leaf finding with raw adherence as the headline metric and excuse context in the summary', () => {
    const f: LeafAdherenceFinding = {
      type: 'leaf_adherence', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      rawCounts: { dueCount: 10, completedCount: 6, excusedCount: 2, skippedCount: 2, autoCloseCount: 0, missingCount: 0 },
      rawAdherence: 0.6, adherenceExclExcused: 0.75, excuseRate: 0.5,
    }
    const released = release.releaseAdherence(f, 'Workout')
    expect(released.kind).toBe('layer1')
    expect(released.metricValue).toBe(0.6)
    expect(released.summary).toContain('60%')
    expect(released.summary).toContain('excused 2 of 4 misses')
    expect(released.rawCounts.dueCount).toBe(10)
  })

  it('releases a parent finding with the per-child breakdown always present (§3.1)', () => {
    const f: ParentAdherenceFinding = {
      type: 'parent_adherence', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      rawCounts: { dueCount: 10, excusedCount: 0, missingCount: 0, declaredOverrideCount: 0 },
      meanDerivedPercent: 84, meanDerivedExclExcused: 84, excuseRate: 0,
      children: [
        { type: 'child_adherence', userId: USER_ID, itemId: 'child1', window: WINDOW,
          rawCounts: { dueCount: 10, completedCount: 10, excusedCount: 0, skippedCount: 0, autoCloseCount: 0, missingCount: 0 },
          rawAdherence: 1, adherenceExclExcused: 1, excuseRate: 0 },
        { type: 'child_adherence', userId: USER_ID, itemId: 'child2', window: WINDOW,
          rawCounts: { dueCount: 10, completedCount: 2, excusedCount: 0, skippedCount: 8, autoCloseCount: 0, missingCount: 0 },
          rawAdherence: 0.2, adherenceExclExcused: 0.2, excuseRate: 0 },
      ],
    }
    const released = release.releaseAdherence(f, 'Night Routine')
    expect(released.summary).toContain('child1')
    expect(released.summary).toContain('child2')
    expect(released.summary).toContain('20%')
  })
})

describe('§4 releaseDataQuality', () => {
  it('summarizes disposition coverage, backfill lateness, and gaps', () => {
    const released = release.releaseDataQuality(stubDataQuality(), 'Workout')
    expect(released.kind).toBe('data_quality')
    expect(released.summary).toContain('90%')
    expect(released.summary).toContain('backfill lag')
  })
})

describe('§5.2 / §9.6 Category 4 — Layer 2 below-floor findings carry no point estimate', () => {
  it('context stability below floor releases as not_yet with no power/effectSize field at all', () => {
    const f: ContextStabilityFinding = {
      type: 'context_stability', estimator: 'variance', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      circularMeanHour: 12, circularVariance: 0.5, effectSize: 0.5, power: 0.1, minimumDetectableEffect: 0.9,
      rawCounts: { nSessions: 2, nDays: 2 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'below_floor', reason: 'need more sessions', nObserved: 2, nNeeded: 10 },
    }
    const released = release.releaseContextStability(f, 'Japanese immersion')
    expect(released.kind).toBe('layer2_not_yet')
    // The below-floor branch's return type has no such fields — this also proves it at
    // runtime: nothing in releaseContextStability's not_yet path ever reads f.power etc.
    expect(released).not.toHaveProperty('power')
    expect(released).not.toHaveProperty('effectSize')
    expect(released).not.toHaveProperty('pValue')
    expect(released).not.toHaveProperty('estimator')
    if (released.kind === 'layer2_not_yet') {
      expect(released.nObserved).toBe(2)
      expect(released.nNeeded).toBe(10)
      expect(released.reason).toBe('need more sessions')
    }
  })

  it('context stability above floor releases as cleared, carrying power/effectSize/MDE/data-quality', () => {
    const f: ContextStabilityFinding = {
      type: 'context_stability', estimator: 'variance', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      circularMeanHour: 8.5, circularVariance: 0.1, effectSize: 0.9, power: 0.85, minimumDetectableEffect: 0.3,
      rawCounts: { nSessions: 40, nDays: 40 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'computable' },
    }
    const released = release.releaseContextStability(f, 'Japanese immersion')
    expect(released.kind).toBe('layer2_cleared')
    if (released.kind === 'layer2_cleared') {
      expect(released.power).toBe(0.85)
      expect(released.metricValue).toBe(0.9)
      expect(released.minimumDetectableEffect).toBe(0.3)
      expect(released.dataQualityNote).toContain('90%')
    }
  })

  it('§5.2 / §9.6 Category 4 — a NULL result (computable but not significant) still carries its MDE and data-quality note; never bare', () => {
    // p=0.8 → not significant. This is a "null result" in the statistical sense — the
    // exact case §4.1 warns is uninterpretable without data-quality context and an MDE.
    const f: AutocorrelationFinding = {
      type: 'autocorrelation', estimator: 'lag1_correlation', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      lag1: 0.02, standardError: 0.14, pValue: 0.8, effectSize: 0.02, power: 0.82, minimumDetectableEffect: 0.28,
      rawCounts: { nObservations: 49, nDueDays: 49 },
      dataQuality: stubDataQuality({ dispositionCoverage: { rate: 0.95, missingRate: 0 } }),
      sufficiency: { status: 'computable' },
    }
    const released = release.releaseAutocorrelation(f, 'Meditation')
    expect(released.kind).toBe('layer2_cleared')
    if (released.kind === 'layer2_cleared') {
      // A null MUST ship with its MDE ("we could have detected X or larger") — there is
      // no code path in releaseAutocorrelation's cleared branch that omits it.
      expect(released.minimumDetectableEffect).toBe(0.28)
      expect(released.dataQualityNote).toContain('95%')
      expect(released.power).toBe(0.82)
    }
  })

  it('autocorrelation below floor releases as not_yet', () => {
    const f: AutocorrelationFinding = {
      type: 'autocorrelation', estimator: 'lag1_correlation', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      lag1: 0.1, standardError: 0.5, pValue: 0.8, effectSize: 0.1, power: 0.05, minimumDetectableEffect: 0.9,
      rawCounts: { nObservations: 5, nDueDays: 5 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'below_floor', reason: 'need ~7 weeks', nObserved: 5, nNeeded: 49 },
    }
    const released = release.releaseAutocorrelation(f, 'Meditation')
    expect(released.kind).toBe('layer2_not_yet')
    expect(released).not.toHaveProperty('pValue')
  })

  it('trajectory below floor releases as not_yet', () => {
    const f: TrajectoryFinding = {
      type: 'trajectory', estimator: 'regression', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      slope: 0.01, intercept: 0.5, rSquared: 0.1, pValue: 0.9, effectSize: 0.05, power: 0.05, minimumDetectableEffect: 0.5,
      rawCounts: { nMonths: 1, nDueDaysTotal: 30 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'below_floor', reason: 'need 2-5 months', nObserved: 1, nNeeded: 2 },
    }
    const released = release.releaseTrajectory(f, 'Workout')
    expect(released.kind).toBe('layer2_not_yet')
    expect(released).not.toHaveProperty('effectSize')
  })

  it('day-of-week scope not_detectable (non-daily habit) releases as not_yet, never a cleared finding', () => {
    const f: DayOfWeekFinding = {
      type: 'day_of_week', estimator: 'permutation_k7', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      scopeStatus: 'not_detectable', estimatedRho: null, pValue: null, effectSize: null, observedStatistic: null,
      dayMeans: null, power: 0, minimumDetectableEffect: null,
      rawCounts: { nWeeks: 10, nDueDays: 40, nConditions: 7 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'computable' },
    }
    const released = release.releaseDayOfWeek(f, 'Gym (4x/week)')
    expect(released.kind).toBe('layer2_not_yet')
    if (released.kind === 'layer2_not_yet') {
      expect(released.reason).toMatch(/not detectable/)
    }
  })

  it('day-of-week scope undefined (weekly item) releases as not_yet', () => {
    const f: DayOfWeekFinding = {
      type: 'day_of_week', estimator: 'permutation_k7', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      scopeStatus: 'undefined', estimatedRho: null, pValue: null, effectSize: null, observedStatistic: null,
      dayMeans: null, power: 0, minimumDetectableEffect: null,
      rawCounts: { nWeeks: 4, nDueDays: 4, nConditions: 7 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'computable' },
    }
    const released = release.releaseDayOfWeek(f, 'Weekly review')
    expect(released.kind).toBe('layer2_not_yet')
  })

  it('day-of-week applicable + cleared releases per-day means in the summary', () => {
    const f: DayOfWeekFinding = {
      type: 'day_of_week', estimator: 'permutation_k7', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      scopeStatus: 'applicable', estimatedRho: 0.1, pValue: 0.01, effectSize: 1.2, observedStatistic: 0.4,
      dayMeans: [{ dayOfWeek: 1, label: 'Mon', mean: 0.9, n: 52 }, { dayOfWeek: 2, label: 'Tue', mean: 0.5, n: 52 }],
      power: 0.8, minimumDetectableEffect: 0.9,
      rawCounts: { nWeeks: 52, nDueDays: 364, nConditions: 7 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'computable' },
    }
    const released = release.releaseDayOfWeek(f, 'Daily journaling')
    expect(released.kind).toBe('layer2_cleared')
    if (released.kind === 'layer2_cleared') {
      expect(released.summary).toContain('Mon')
      expect(released.summary).toContain('Tue')
      expect(released.power).toBe(0.8)
    }
  })

  it('weekday-vs-weekend (two-condition) below floor releases as not_yet, labeled by its condition names', () => {
    const f: TwoConditionFinding = {
      type: 'two_condition', estimator: 'permutation_k2', userId: USER_ID, itemId: ITEM_ID, window: WINDOW,
      conditionA: 'weekday', conditionB: 'weekend', estimatedRho: 0.5,
      pValue: null, effectSize: null, observedStatistic: null, meanA: null, meanB: null,
      power: 0.048, minimumDetectableEffect: null,
      rawCounts: { nPeriodsA: 20, nPeriodsB: 20, nDueDays: 140 },
      dataQuality: stubDataQuality(),
      sufficiency: { status: 'below_floor', reason: 'k=2 requires n >= 6', nObserved: 4, nNeeded: 6 },
    }
    const released = release.releaseTwoCondition(f, 'Workout')
    expect(released.kind).toBe('layer2_not_yet')
    expect(released.label).toContain('weekday vs weekend')
  })
})

describe('§3.2 / §5.4 — streaks are never released to Layer 3', () => {
  it('release.ts exports no function for streak findings', () => {
    // The single-miss constraint (§5.4) is enforced structurally here: there is no
    // releaseStreak function, so a StreakFinding's current/longest streak counts can
    // never reach the prompt builder through this module — there is no path.
    const exported = Object.keys(release)
    expect(exported.some((name) => /streak/i.test(name))).toBe(false)
  })
})

describe('§9.4 releaseEvidence — only verified + approved + unarchived entries survive', () => {
  function makeEntry(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
    return {
      id: 'e1', userId: USER_ID, claim: 'claim', mechanism: 'mechanism',
      sourceIdentifierType: 'pmid', sourceIdentifier: '123', claimedEvidenceQuality: 'rct',
      groundedJustification: 'justification', provenance: 'seeded', proposedAt: new Date(),
      verificationStatus: 'verified', verifiedAt: new Date(), rejectionReason: null, rejectionDetail: null,
      resolvedPmid: '123', resolvedTitle: 't', resolvedJournal: 'j', resolvedYear: 2020,
      resolvedPublicationTypes: ['Randomized Controlled Trial'], resolvedAbstract: 'abstract',
      actualEvidenceQuality: 'rct',
      approvalStatus: 'approved', approvedAt: new Date(), abstractVisibleAtApproval: 'visible',
      archivedAt: null, createdAt: new Date(),
      ...overrides,
    }
  }

  it('a verified+approved+unarchived entry is released', () => {
    const released = release.releaseEvidence([makeEntry()])
    expect(released).toHaveLength(1)
    expect(released[0].evidenceQuality).toBe('rct')
  })

  it('an unverified entry is excluded even if somehow marked approved', () => {
    const released = release.releaseEvidence([makeEntry({ verificationStatus: 'pending', approvalStatus: 'approved' })])
    expect(released).toHaveLength(0)
  })

  it('a verified-but-not-approved entry is excluded', () => {
    const released = release.releaseEvidence([makeEntry({ approvalStatus: 'pending' })])
    expect(released).toHaveLength(0)
  })

  it('an archived entry is excluded even if verified and approved', () => {
    const released = release.releaseEvidence([makeEntry({ archivedAt: new Date() })])
    expect(released).toHaveLength(0)
  })

  it('uses the ACTUAL evidence quality, never the claimed one', () => {
    const released = release.releaseEvidence([makeEntry({ claimedEvidenceQuality: 'meta_analysis', actualEvidenceQuality: 'observational' })])
    expect(released[0].evidenceQuality).toBe('observational')
  })
})
