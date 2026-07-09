// §3.1 — Adherence calculators.
//
// Pure functions: DayObservation[] → finding.  No DB access, no domain knowledge.
// This is the "statistics side" of the observation-array seam (§9.1.1).
//
// Leaf adherence: binary hit-rate.
//   rawAdherence = completedCount / dueCount (includes excused — default headline).
//   adherenceExclExcused = completedCount / (dueCount - excusedCount).
//   excuseRate = excusedCount / (dueCount - completedCount) — excused share of misses.
//
// Parent adherence: mean of daily derived percentages per §3.1.
//   children breakdown is ALWAYS present (per §3.1 — "not a drill-down, a default").
//
// §13.4 user_id scoping is carried through as a field on every finding.

import type { DayObservation, ChildObservationMap } from '../types'
import type { LeafAdherenceFinding, ChildAdherenceFinding, ParentAdherenceFinding, DateWindow } from '@tracker/shared'

function safeDivide(n: number, d: number): number {
  return d === 0 ? 0 : n / d
}

function computeLeafCounts(observations: DayObservation[]) {
  let dueCount = 0, completedCount = 0, excusedCount = 0,
      skippedCount = 0, autoCloseCount = 0, missingCount = 0

  for (const obs of observations) {
    dueCount++
    if (obs.disposition === 'missing') { missingCount++; continue }
    if (obs.completionPercent >= 100)  completedCount++
    if (obs.disposition === 'excused')    excusedCount++
    if (obs.disposition === 'skipped')    skippedCount++
    if (obs.disposition === 'auto_closed') autoCloseCount++
  }

  return { dueCount, completedCount, excusedCount, skippedCount, autoCloseCount, missingCount }
}

/**
 * §3.1 — Compute adherence for a leaf item.
 * Pure: takes observation arrays only, no DB access.
 */
export function computeLeafAdherence(
  itemId: string,
  userId: string,
  window: DateWindow,
  observations: DayObservation[]
): LeafAdherenceFinding {
  const { dueCount, completedCount, excusedCount, skippedCount, autoCloseCount, missingCount } =
    computeLeafCounts(observations)

  const rawAdherence = safeDivide(completedCount, dueCount)
  const adherenceExclExcused = safeDivide(completedCount, dueCount - excusedCount)
  const excuseRate = safeDivide(excusedCount, dueCount - completedCount)

  return {
    type: 'leaf_adherence',
    userId,
    itemId,
    window,
    rawCounts: { dueCount, completedCount, excusedCount, skippedCount, autoCloseCount, missingCount },
    rawAdherence,
    adherenceExclExcused,
    excuseRate,
  }
}

/**
 * §3.1 — Compute adherence for a parent item.
 * Parent adherence = mean of daily derived percentages.
 * children is always included (§3.1: not a drill-down, a default).
 */
export function computeParentAdherence(
  itemId: string,
  userId: string,
  window: DateWindow,
  parentObservations: DayObservation[],
  childObservations: ChildObservationMap
): ParentAdherenceFinding {
  let dueCount = 0, excusedCount = 0, missingCount = 0, declaredOverrideCount = 0
  let derivedSum = 0, derivedExclExcusedSum = 0, derivedExclExcusedCount = 0

  for (const obs of parentObservations) {
    dueCount++
    // Missing parent occurrence: the parent's own event record is absent, but
    // completionPercent is still derived from children (it's always computed).
    // We include it in the mean — a logging gap doesn't erase children's work.
    if (obs.disposition === 'missing') {
      missingCount++
      derivedSum += obs.completionPercent
      derivedExclExcusedSum += obs.completionPercent
      derivedExclExcusedCount++
      continue
    }
    derivedSum += obs.completionPercent
    if (obs.disposition === 'excused') excusedCount++
    else {
      derivedExclExcusedSum += obs.completionPercent
      derivedExclExcusedCount++
    }
    if (obs.declaredPercent !== null) declaredOverrideCount++
  }

  // Mean over ALL due days (including missing — derived % is always computable from children)
  const meanDerivedPercent = safeDivide(derivedSum, dueCount)
  const meanDerivedExclExcused = safeDivide(derivedExclExcusedSum, derivedExclExcusedCount)
  const completedDays = parentObservations.filter(o => o.completionPercent >= 100).length
  const excuseRate = safeDivide(excusedCount, dueCount - completedDays)

  // Build per-child findings (always present per spec)
  const children: ChildAdherenceFinding[] = []
  for (const [childItemId, childObs] of childObservations) {
    const counts = computeLeafCounts(childObs)
    const { dueCount: cDue, completedCount: cComp, excusedCount: cExc,
            skippedCount: cSkip, autoCloseCount: cAC, missingCount: cMiss } = counts
    children.push({
      type: 'child_adherence',
      userId,
      itemId: childItemId,
      window,
      rawCounts: { dueCount: cDue, completedCount: cComp, excusedCount: cExc,
                   skippedCount: cSkip, autoCloseCount: cAC, missingCount: cMiss },
      rawAdherence: safeDivide(cComp, cDue),
      adherenceExclExcused: safeDivide(cComp, cDue - cExc),
      excuseRate: safeDivide(cExc, cDue - cComp),
    })
  }

  return {
    type: 'parent_adherence',
    userId,
    itemId,
    window,
    rawCounts: { dueCount, excusedCount, missingCount, declaredOverrideCount },
    meanDerivedPercent,
    meanDerivedExclExcused,
    excuseRate,
    children,
  }
}
