// v2 §2 / §5.2 / §5.4 — The release gate.
//
// This module is the ONLY place a ReleasedFinding or ReleasedEvidence is constructed.
// It is a pure function layer: Finding (from Layer 1 / 1.5 / 2) or EvidenceEntry in,
// ReleasedFinding / ReleasedEvidence out. No DB access, no LLM call.
//
// Two deliberate omissions enforce §5.4 (the single-miss constraint) structurally rather
// than by convention:
//   1. StreakFinding is never released. Streaks are a display affordance (§3.2 note) —
//      Layer 2 and Layer 3 reason in rates over windows, never streaks. Because this
//      module is the only source of facts for the prompt builder, and it has no
//      `releaseStreak` function, a streak count simply never reaches the LLM. There is
//      nothing to accidentally narrate.
//   2. Every released fact is a WINDOW-level aggregate (a rate, a count, an effect size)
//      — never a per-day observation. A single missed day cannot appear in the prompt
//      because the day-level granularity is never released, only aggregates over it.
//
// A below-floor / out-of-scope Layer 2 finding is released as ReleasedLayer2NotYet, which
// (per types.ts) has no field to carry a point estimate — see releaseLayer2* below.

import type {
  AdherenceFinding,
  TimeStatsFinding,
  AdHocShareFinding,
  ProcrastinationFinding,
  DataQualityFinding,
  ContextStabilityFinding,
  AutocorrelationFinding,
  TrajectoryFinding,
  DayOfWeekFinding,
  TwoConditionFinding,
  EvidenceEntry,
} from '@tracker/shared'
import type {
  ReleasedLayer1Fact,
  ReleasedDataQualityFact,
  ReleasedLayer2Cleared,
  ReleasedLayer2NotYet,
  ReleasedEvidence,
} from './types'

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

// ── §3.1 Adherence ────────────────────────────────────────────────────────────────────

export function releaseAdherence(f: AdherenceFinding, itemName: string): ReleasedLayer1Fact {
  if (f.type === 'leaf_adherence') {
    const excuseNote = f.rawCounts.excusedCount > 0
      ? `, excused ${f.rawCounts.excusedCount} of ${f.rawCounts.dueCount - f.rawCounts.completedCount} misses`
      : ''
    return {
      kind: 'layer1',
      factId: `adherence:${f.itemId}`,
      itemId: f.itemId,
      label: `${itemName} — adherence`,
      summary: `${itemName}: ${pct(f.rawAdherence)} raw adherence (${f.rawCounts.completedCount} of ${f.rawCounts.dueCount} completed${excuseNote})`,
      metricValue: f.rawAdherence,
      rawCounts: f.rawCounts,
    }
  }
  // Parent: derived % drives the headline; per-child breakdown always ships (§3.1).
  const children = f.children
    .map((c) => `${c.itemId}: ${pct(c.rawAdherence)}`)
    .join('; ')
  return {
    kind: 'layer1',
    factId: `adherence:${f.itemId}`,
    itemId: f.itemId,
    label: `${itemName} — adherence`,
    summary: `${itemName}: ${pct(f.meanDerivedPercent / 100)} mean derived completion. Per-child: ${children || '(no children observed)'}`,
    metricValue: f.meanDerivedPercent,
    rawCounts: { dueCount: f.rawCounts.dueCount, excusedCount: f.rawCounts.excusedCount, missingCount: f.rawCounts.missingCount },
  }
}

// ── §3.3 Time ─────────────────────────────────────────────────────────────────────────

export function releaseTimeStats(f: TimeStatsFinding, itemName: string): ReleasedLayer1Fact {
  const deltaNote = f.plannedVsActualDeltaMin !== null
    ? `, planned-vs-actual delta ${f.plannedVsActualDeltaMin >= 0 ? '+' : ''}${f.plannedVsActualDeltaMin}min`
    : ''
  return {
    kind: 'layer1',
    factId: `time:${f.itemId}`,
    itemId: f.itemId,
    label: `${itemName} — time`,
    summary: `${itemName}: ${f.totalMin} minutes tracked across ${f.rawCounts.sessionCount} sessions${deltaNote}`,
    metricValue: f.totalMin,
    rawCounts: f.rawCounts,
  }
}

export function releaseAdHocShare(f: AdHocShareFinding): ReleasedLayer1Fact {
  return {
    kind: 'layer1',
    factId: 'adhoc_share:global',
    itemId: null,
    label: 'Ad-hoc time share',
    summary: `${pct(1 - f.adHocShare)} of tracked time was planned, ${pct(f.adHocShare)} ad-hoc; of the ad-hoc time, ${pct(f.adHocByValence.unproductive / Math.max(1, f.adHocMin))} was flagged unproductive`,
    metricValue: f.adHocShare,
    rawCounts: f.rawCounts,
  }
}

// ── §3.4 Procrastination ──────────────────────────────────────────────────────────────

export function releaseProcrastination(f: ProcrastinationFinding, itemName: string): ReleasedLayer1Fact {
  return {
    kind: 'layer1',
    factId: `procrastination:${f.itemId}`,
    itemId: f.itemId,
    label: `${itemName} — procrastination`,
    summary: `${itemName}: rescheduled ${f.rescheduleCount} times (longest chain ${f.longestRescheduleChain}); ${f.backfillStats.count} backfilled completions, median lag ${f.backfillStats.medianLagDays}d`,
    metricValue: f.rescheduleCount,
    rawCounts: f.rawCounts,
  }
}

// ── §4 Data quality ───────────────────────────────────────────────────────────────────

export function releaseDataQuality(f: DataQualityFinding, label: string): ReleasedDataQualityFact {
  return {
    kind: 'data_quality',
    factId: `data_quality:${f.itemId ?? 'global'}`,
    itemId: f.itemId,
    label: `${label} — logging health`,
    summary: dataQualitySummary(f),
    metricValue: f.dispositionCoverage.rate,
    rawCounts: f.rawCounts,
  }
}

// Shared by releaseDataQuality and every releaseLayer2* (§5.2: "every finding ships with
// its Layer 1.5 data-quality context").
export function dataQualitySummary(dq: DataQualityFinding): string {
  const coverage = `${pct(dq.dispositionCoverage.rate)} of due days have an explicit disposition or auto-close`
  const backfill = dq.backfillLateness
    ? `; median backfill lag ${dq.backfillLateness.medianLagDays}d (${pct(dq.backfillLateness.proportionOver1Day)} over 1 day late)`
    : ''
  const gaps = dq.rawCounts.missingCount > 0 ? `; ${dq.rawCounts.missingCount} due days have no record at all` : ''
  return `${coverage}${backfill}${gaps}`
}

// ── §5.3 Layer 2 — cleared vs. not-yet ────────────────────────────────────────────────

function notYet(
  factId: string,
  itemId: string,
  label: string,
  insight: ReleasedLayer2NotYet['insight'],
  reason: string,
  nObserved: number,
  nNeeded: number
): ReleasedLayer2NotYet {
  return { kind: 'layer2_not_yet', factId, itemId, label, insight, reason, nObserved, nNeeded }
}

export function releaseContextStability(f: ContextStabilityFinding, itemName: string): ReleasedLayer2Cleared | ReleasedLayer2NotYet {
  const factId = `context_stability:${f.itemId}`
  if (f.sufficiency.status === 'below_floor') {
    return notYet(factId, f.itemId, `${itemName} — context stability`, 'context_stability', f.sufficiency.reason, f.sufficiency.nObserved, f.sufficiency.nNeeded)
  }
  return {
    kind: 'layer2_cleared',
    factId,
    itemId: f.itemId,
    label: `${itemName} — context stability`,
    insight: 'context_stability',
    estimator: f.estimator,
    summary: `${itemName}: sessions cluster around ${f.circularMeanHour.toFixed(1)}h (circular variance ${f.circularVariance.toFixed(2)}, 0=fixed time, 1=random)`,
    metricValue: f.effectSize,
    power: f.power,
    pValue: null,
    minimumDetectableEffect: f.minimumDetectableEffect,
    dataQualityNote: dataQualitySummary(f.dataQuality),
  }
}

export function releaseAutocorrelation(f: AutocorrelationFinding, itemName: string): ReleasedLayer2Cleared | ReleasedLayer2NotYet {
  const factId = `autocorrelation:${f.itemId}`
  if (f.sufficiency.status === 'below_floor') {
    return notYet(factId, f.itemId, `${itemName} — streakiness`, 'autocorrelation', f.sufficiency.reason, f.sufficiency.nObserved, f.sufficiency.nNeeded)
  }
  return {
    kind: 'layer2_cleared',
    factId,
    itemId: f.itemId,
    label: `${itemName} — streakiness`,
    insight: 'autocorrelation',
    estimator: f.estimator,
    summary: `${itemName}: lag-1 autocorrelation ${f.lag1.toFixed(2)} (p=${f.pValue.toFixed(3)}) — ${f.lag1 > 0 ? 'misses/hits cluster' : 'no detectable clustering'}`,
    metricValue: f.effectSize,
    power: f.power,
    pValue: f.pValue,
    minimumDetectableEffect: f.minimumDetectableEffect,
    dataQualityNote: dataQualitySummary(f.dataQuality),
  }
}

export function releaseTrajectory(f: TrajectoryFinding, itemName: string): ReleasedLayer2Cleared | ReleasedLayer2NotYet {
  const factId = `trajectory:${f.itemId}`
  if (f.sufficiency.status === 'below_floor') {
    return notYet(factId, f.itemId, `${itemName} — trajectory`, 'trajectory', f.sufficiency.reason, f.sufficiency.nObserved, f.sufficiency.nNeeded)
  }
  return {
    kind: 'layer2_cleared',
    factId,
    itemId: f.itemId,
    label: `${itemName} — trajectory`,
    insight: 'trajectory',
    estimator: f.estimator,
    summary: `${itemName}: adherence is ${f.slope >= 0 ? 'rising' : 'declining'} by ${(Math.abs(f.slope) * 100).toFixed(1)} points/month (p=${f.pValue.toFixed(3)}, R²=${f.rSquared.toFixed(2)})`,
    metricValue: f.effectSize,
    power: f.power,
    pValue: f.pValue,
    minimumDetectableEffect: f.minimumDetectableEffect,
    dataQualityNote: dataQualitySummary(f.dataQuality),
  }
}

export function releaseDayOfWeek(f: DayOfWeekFinding, itemName: string): ReleasedLayer2Cleared | ReleasedLayer2NotYet {
  const factId = `day_of_week:${f.itemId}`
  if (f.scopeStatus === 'not_detectable') {
    return notYet(factId, f.itemId, `${itemName} — day-of-week`, 'day_of_week', 'day-of-week effects are not detectable in any practical timeframe for a non-daily habit (§5.3.1)', 0, 0)
  }
  if (f.scopeStatus === 'undefined') {
    return notYet(factId, f.itemId, `${itemName} — day-of-week`, 'day_of_week', 'day-of-week has no meaning for this item (one observation per bucket)', 0, 0)
  }
  if (f.sufficiency.status === 'below_floor') {
    return notYet(factId, f.itemId, `${itemName} — day-of-week`, 'day_of_week', f.sufficiency.reason, f.sufficiency.nObserved, f.sufficiency.nNeeded)
  }
  const means = (f.dayMeans ?? []).map((d) => `${d.label} ${pct(d.mean)}`).join(', ')
  return {
    kind: 'layer2_cleared',
    factId,
    itemId: f.itemId,
    label: `${itemName} — day-of-week`,
    insight: 'day_of_week',
    estimator: f.estimator,
    summary: `${itemName}: per-day adherence — ${means || '(no per-day breakdown)'} (p=${f.pValue?.toFixed(3) ?? 'n/a'})`,
    metricValue: f.effectSize ?? 0,
    power: f.power,
    pValue: f.pValue,
    minimumDetectableEffect: f.minimumDetectableEffect,
    dataQualityNote: dataQualitySummary(f.dataQuality),
  }
}

export function releaseTwoCondition(f: TwoConditionFinding, itemName: string): ReleasedLayer2Cleared | ReleasedLayer2NotYet {
  const factId = `two_condition:${f.itemId}`
  if (f.sufficiency.status === 'below_floor') {
    return notYet(factId, f.itemId, `${itemName} — ${f.conditionA} vs ${f.conditionB}`, 'two_condition', f.sufficiency.reason, f.sufficiency.nObserved, f.sufficiency.nNeeded)
  }
  return {
    kind: 'layer2_cleared',
    factId,
    itemId: f.itemId,
    label: `${itemName} — ${f.conditionA} vs ${f.conditionB}`,
    insight: 'two_condition',
    estimator: f.estimator,
    summary: `${itemName}: ${f.conditionA} ${pct(f.meanA ?? 0)} vs ${f.conditionB} ${pct(f.meanB ?? 0)} (p=${f.pValue?.toFixed(3) ?? 'n/a'}, power ${pct(f.power)})`,
    metricValue: f.effectSize ?? 0,
    power: f.power,
    pValue: f.pValue,
    minimumDetectableEffect: f.minimumDetectableEffect,
    dataQualityNote: dataQualitySummary(f.dataQuality),
  }
}

// ── Evidence ──────────────────────────────────────────────────────────────────────────

// Defense-in-depth filter (§9.4.1's findUsableEvidenceEntries already applies this exact
// filter at the query level — this is the second, structural checkpoint: even if a caller
// passed this function every evidence row in the table, only usable ones would survive).
export function releaseEvidence(entries: EvidenceEntry[]): ReleasedEvidence[] {
  return entries
    .filter((e) => e.verificationStatus === 'verified' && e.approvalStatus === 'approved' && e.archivedAt === null)
    .map((e) => ({
      id: e.id,
      claim: e.claim,
      mechanism: e.mechanism,
      sourceIdentifier: e.sourceIdentifier,
      sourceIdentifierType: e.sourceIdentifierType,
      // Actual, code-derived tier — never the proposer's claimed tier (mirrors §9.4 item 4).
      evidenceQuality: e.actualEvidenceQuality ?? e.claimedEvidenceQuality,
      groundedJustification: e.groundedJustification,
    }))
}
