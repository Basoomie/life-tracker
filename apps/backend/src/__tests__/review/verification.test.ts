// v2 §9.4 / §9.6 Category 4 — verification.ts: a recommendation citing an unverified or
// unapproved source is DROPPED, not rendered.

import { describe, it, expect } from 'vitest'
import { verifyRecommendations } from '../../review/verification'
import type { ReleasedEvidence, ReleasedFinding, RawRecommendationCandidate } from '../../review/types'

const EVIDENCE: ReleasedEvidence[] = [
  {
    id: 'ev-1',
    claim: 'Consistent context builds automaticity',
    mechanism: 'context-dependent repetition',
    sourceIdentifier: '23211256',
    sourceIdentifierType: 'pmid',
    evidenceQuality: 'observational',
    groundedJustification: 'Automaticity increased with repetition in a stable context.',
  },
]

const FACTS: ReleasedFinding[] = [
  {
    kind: 'layer2_cleared', factId: 'context_stability:item1', itemId: 'item1',
    label: 'Japanese immersion — context stability', insight: 'context_stability', estimator: 'variance',
    summary: 'summary', metricValue: 0.8, power: 0.8, pValue: null, minimumDetectableEffect: 0.3,
    dataQualityNote: 'note',
  },
]

describe('§9.4 item 4 — a recommendation citing a fabricated or unapproved source is DROPPED', () => {
  it('drops a candidate whose evidenceEntryId does not match anything in the closed evidence list', () => {
    const raw: RawRecommendationCandidate[] = [
      { evidenceEntryId: 'ev-does-not-exist', recommendationText: 'invented advice', confidence: 'high', targetedMetricFactId: null },
    ]
    const result = verifyRecommendations(raw, EVIDENCE, FACTS)
    expect(result).toHaveLength(0)
  })

  it('accepts a candidate citing an id that IS in the evidence list, copying the evidentiary fields verbatim from it', () => {
    const raw: RawRecommendationCandidate[] = [
      { evidenceEntryId: 'ev-1', recommendationText: 'Anchor Japanese immersion to a consistent time', confidence: 'medium', targetedMetricFactId: 'context_stability:item1' },
    ]
    const result = verifyRecommendations(raw, EVIDENCE, FACTS)
    expect(result).toHaveLength(1)
    expect(result[0].recommendation).toBe('Anchor Japanese immersion to a consistent time')
    // These four fields must come from the evidence entry, not from the LLM candidate —
    // the candidate object above never even provided them.
    expect(result[0].mechanism).toBe('context-dependent repetition')
    expect(result[0].sourceIdentifier).toBe('23211256')
    expect(result[0].evidenceQuality).toBe('observational')
    expect(result[0].groundedJustification).toBe('Automaticity increased with repetition in a stable context.')
    expect(result[0].targetedMetricLabel).toBe('Japanese immersion — context stability')
  })

  it('a mix of valid and fabricated candidates keeps only the valid one', () => {
    const raw: RawRecommendationCandidate[] = [
      { evidenceEntryId: 'ev-1', recommendationText: 'valid', confidence: 'low', targetedMetricFactId: null },
      { evidenceEntryId: 'ev-fake', recommendationText: 'fabricated', confidence: 'high', targetedMetricFactId: null },
    ]
    const result = verifyRecommendations(raw, EVIDENCE, FACTS)
    expect(result).toHaveLength(1)
    expect(result[0].recommendation).toBe('valid')
  })

  it('zero candidates in, zero recommendations out — a valid, expected outcome (§9.4 item 6)', () => {
    expect(verifyRecommendations([], EVIDENCE, FACTS)).toEqual([])
  })

  it('a targetedMetricFactId that does not match any current fact is nulled out rather than dropping the recommendation', () => {
    const raw: RawRecommendationCandidate[] = [
      { evidenceEntryId: 'ev-1', recommendationText: 'valid but stale target', confidence: 'low', targetedMetricFactId: 'no-such-fact' },
    ]
    const result = verifyRecommendations(raw, EVIDENCE, FACTS)
    expect(result).toHaveLength(1)
    expect(result[0].targetedMetricFactId).toBeNull()
    expect(result[0].targetedMetricLabel).toBeNull()
  })

  it('an empty evidence list drops every candidate, however plausible-sounding', () => {
    const raw: RawRecommendationCandidate[] = [
      { evidenceEntryId: 'ev-1', recommendationText: 'plausible sounding advice', confidence: 'high', targetedMetricFactId: null },
    ]
    expect(verifyRecommendations(raw, [], FACTS)).toEqual([])
  })
})
