// v2 §9.2.1 — Past reviews feed forward as a STRUCTURED record, never prose.
//
// Pure functions: no DB access. Identity of "the same suggestion" recurring across
// reviews is the (sourceIdentifier, targetedMetricFactId) pair — deterministic, no fuzzy
// text matching on the LLM's phrasing (which can vary review to review even when the
// underlying suggestion is identical).

import type { FeedForwardRecord, Recommendation } from '@tracker/shared'
import type { ReleasedFinding } from './types'

function currentMetricValues(facts: ReleasedFinding[]): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (const f of facts) {
    if (f.kind === 'layer2_not_yet') continue // no metric to compare — see types.ts
    out.set(f.factId, f.metricValue)
  }
  return out
}

/**
 * Recomputes the PREVIOUS review's feed-forward records against THIS review's current
 * facts — this is what goes into the prompt as "here is what happened to the metrics you
 * targeted before" (§9.2.1's "if the recommendation has been made twelve times and the
 * metric has not moved, that is itself a finding").
 */
export function computeFeedForwardInput(
  previousFeedForwardOut: FeedForwardRecord[],
  currentFacts: ReleasedFinding[]
): FeedForwardRecord[] {
  const values = currentMetricValues(currentFacts)
  return previousFeedForwardOut.map((r) => {
    const metricValueNow = values.has(r.factId) ? values.get(r.factId)! : r.metricValueNow
    const delta = r.metricValueThen !== null && metricValueNow !== null ? metricValueNow - r.metricValueThen : null
    return { ...r, metricValueNow, delta }
  })
}

/**
 * Builds THIS review's contribution to the NEXT review's feed-forward input, from its own
 * verified recommendations. A repeated (sourceIdentifier, factId) pair keeps its ORIGINAL
 * baseline (metricValueThen) so "delta since" always measures from when the suggestion was
 * first made, and its timesRecommended count increments. A new pairing starts fresh.
 */
export function buildFeedForwardOut(
  feedForwardInput: FeedForwardRecord[],
  recommendations: Recommendation[],
  currentFacts: ReleasedFinding[]
): FeedForwardRecord[] {
  const values = currentMetricValues(currentFacts)
  const priorByKey = new Map(feedForwardInput.map((r) => [`${r.sourceIdentifier}::${r.factId}`, r]))

  const withTarget = recommendations.filter((r) => r.targetedMetricFactId !== null)

  return withTarget.map((r) => {
    const factId = r.targetedMetricFactId as string
    const key = `${r.sourceIdentifier}::${factId}`
    const prior = priorByKey.get(key)
    const metricValueNow = values.has(factId) ? values.get(factId)! : null
    const metricValueThen = prior ? prior.metricValueThen : metricValueNow
    const delta = metricValueThen !== null && metricValueNow !== null ? metricValueNow - metricValueThen : null
    return {
      factId,
      label: r.targetedMetricLabel ?? factId,
      sourceIdentifier: r.sourceIdentifier,
      recommendation: r.recommendation,
      timesRecommended: (prior?.timesRecommended ?? 0) + 1,
      metricValueThen,
      metricValueNow,
      delta,
    }
  })
}
