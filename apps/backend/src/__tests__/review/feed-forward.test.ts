// v2 §9.2.1 / §9.6 Category 4 — feed-forward.ts: past reviews feed forward as a
// structured record, never prose; repeated-recommendation detection.

import { describe, it, expect } from 'vitest'
import { computeFeedForwardInput, buildFeedForwardOut } from '../../review/feed-forward'
import type { FeedForwardRecord, Recommendation } from '@tracker/shared'
import type { ReleasedFinding } from '../../review/types'

const FACTS: ReleasedFinding[] = [
  { kind: 'layer2_cleared', factId: 'context_stability:item1', itemId: 'item1',
    label: 'Japanese immersion — context stability', insight: 'context_stability', estimator: 'variance',
    summary: 's', metricValue: 0.4, power: 0.8, pValue: null, minimumDetectableEffect: 0.3, dataQualityNote: 'n' },
]

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    recommendation: 'Anchor Japanese immersion to a consistent time',
    mechanism: 'context-dependent repetition',
    sourceIdentifier: '23211256',
    sourceIdentifierType: 'pmid',
    evidenceQuality: 'observational',
    confidence: 'medium',
    groundedJustification: 'justification',
    targetedMetricFactId: 'context_stability:item1',
    targetedMetricLabel: 'Japanese immersion — context stability',
    ...overrides,
  }
}

describe('§9.2.1 — feed-forward is a structured record, not prose', () => {
  it('buildFeedForwardOut never stores past narrative/prose — only recommendation, metric, and delta fields', () => {
    const out = buildFeedForwardOut([], [recommendation()], FACTS)
    expect(out).toHaveLength(1)
    const keys = Object.keys(out[0]).sort()
    expect(keys).toEqual(['delta', 'factId', 'label', 'metricValueNow', 'metricValueThen', 'recommendation', 'sourceIdentifier', 'timesRecommended'].sort())
  })

  it('a recommendation with no targeted metric is excluded from feed-forward (nothing to track)', () => {
    const out = buildFeedForwardOut([], [recommendation({ targetedMetricFactId: null, targetedMetricLabel: null })], FACTS)
    expect(out).toEqual([])
  })
})

describe('§9.2.1 — repeated-recommendation detection: same suggestion, unmoved metric, across reviews', () => {
  it('a brand-new recommendation starts at timesRecommended=1 with its baseline equal to the current metric', () => {
    const out = buildFeedForwardOut([], [recommendation()], FACTS)
    expect(out[0].timesRecommended).toBe(1)
    expect(out[0].metricValueThen).toBe(0.4)
    expect(out[0].metricValueNow).toBe(0.4)
    expect(out[0].delta).toBe(0)
  })

  it('a repeated recommendation (same sourceIdentifier + factId) increments the count and KEEPS the original baseline', () => {
    const previous: FeedForwardRecord[] = [{
      factId: 'context_stability:item1', label: 'Japanese immersion — context stability',
      sourceIdentifier: '23211256', recommendation: 'Anchor Japanese immersion to a consistent time',
      timesRecommended: 11, metricValueThen: 0.1, metricValueNow: 0.12, delta: 0.02,
    }]
    const input = computeFeedForwardInput(previous, FACTS)
    const out = buildFeedForwardOut(input, [recommendation()], FACTS)
    expect(out[0].timesRecommended).toBe(12)
    // Baseline is preserved from the FIRST time it was recommended, not reset.
    expect(out[0].metricValueThen).toBe(0.1)
    expect(out[0].metricValueNow).toBe(0.4)
    expect(out[0].delta).toBeCloseTo(0.3)
  })

  it('twelve repeats with an unmoved metric surfaces as delta ≈ 0, exactly the "advice is not landing" signal', () => {
    const previous: FeedForwardRecord[] = [{
      factId: 'context_stability:item1', label: 'Japanese immersion — context stability',
      sourceIdentifier: '23211256', recommendation: 'Anchor Japanese immersion to a consistent time',
      timesRecommended: 11, metricValueThen: 0.4, metricValueNow: 0.4, delta: 0,
    }]
    const input = computeFeedForwardInput(previous, FACTS) // FACTS still reports 0.4 — no movement
    const out = buildFeedForwardOut(input, [recommendation()], FACTS)
    expect(out[0].timesRecommended).toBe(12)
    expect(out[0].delta).toBe(0)
  })

  it('a DIFFERENT evidence source targeting the same metric is tracked as a distinct suggestion (starts fresh)', () => {
    const previous: FeedForwardRecord[] = [{
      factId: 'context_stability:item1', label: 'Japanese immersion — context stability',
      sourceIdentifier: 'OTHER-SOURCE', recommendation: 'A different suggestion',
      timesRecommended: 5, metricValueThen: 0.1, metricValueNow: 0.1, delta: 0,
    }]
    const input = computeFeedForwardInput(previous, FACTS)
    const out = buildFeedForwardOut(input, [recommendation()], FACTS)
    expect(out[0].timesRecommended).toBe(1)
    expect(out[0].metricValueThen).toBe(0.4)
  })
})

describe('computeFeedForwardInput recomputes metricValueNow/delta against the CURRENT review\'s facts', () => {
  it('updates metricValueNow and delta even when the recommendation is not repeated this time', () => {
    const previous: FeedForwardRecord[] = [{
      factId: 'context_stability:item1', label: 'l', sourceIdentifier: 's', recommendation: 'r',
      timesRecommended: 3, metricValueThen: 0.1, metricValueNow: 0.2, delta: 0.1,
    }]
    const input = computeFeedForwardInput(previous, FACTS)
    expect(input[0].metricValueNow).toBe(0.4)
    expect(input[0].delta).toBeCloseTo(0.3)
    expect(input[0].metricValueThen).toBe(0.1) // baseline never changes here
  })

  it('when the target fact no longer exists this period, the prior metricValueNow is preserved rather than nulled', () => {
    const previous: FeedForwardRecord[] = [{
      factId: 'no-longer-exists', label: 'l', sourceIdentifier: 's', recommendation: 'r',
      timesRecommended: 1, metricValueThen: 0.1, metricValueNow: 0.15, delta: 0.05,
    }]
    const input = computeFeedForwardInput(previous, FACTS)
    expect(input[0].metricValueNow).toBe(0.15)
  })
})
