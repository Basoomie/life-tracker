// v2 §9.2 "fails safe under model substitution" — validate.ts: the ONE schema validator
// shared by every adapter. Provider-neutral: takes an already-parsed plain JS value,
// regardless of how an adapter obtained it.

import { describe, it, expect } from 'vitest'
import { validateReviewOutput, tryParseJson, EMPTY_OUTPUT } from '../../../review/llm/validate'

describe('§9.2 validateReviewOutput — malformed input of any shape degrades to empty, never throws', () => {
  it('a non-object value yields EMPTY_OUTPUT', () => {
    expect(validateReviewOutput('just a string')).toEqual(EMPTY_OUTPUT)
    expect(validateReviewOutput(42)).toEqual(EMPTY_OUTPUT)
    expect(validateReviewOutput(null)).toEqual(EMPTY_OUTPUT)
    expect(validateReviewOutput(undefined)).toEqual(EMPTY_OUTPUT)
  })

  it('a well-formed object passes through with narrative and valid recommendations intact', () => {
    const result = validateReviewOutput({
      narrative: 'steady week',
      recommendations: [{ evidenceEntryId: 'ev-1', recommendationText: 'x', confidence: 'medium', targetedMetricFactId: null }],
    })
    expect(result.narrative).toBe('steady week')
    expect(result.recommendations).toHaveLength(1)
  })

  it('a missing narrative field falls back to empty string rather than propagating garbage', () => {
    expect(validateReviewOutput({ recommendations: [] }).narrative).toBe('')
    expect(validateReviewOutput({ narrative: 123, recommendations: [] }).narrative).toBe('')
  })

  it('a missing or non-array recommendations field falls back to an empty array', () => {
    expect(validateReviewOutput({ narrative: '' }).recommendations).toEqual([])
    expect(validateReviewOutput({ narrative: '', recommendations: 'not an array' }).recommendations).toEqual([])
    expect(validateReviewOutput({ narrative: '', recommendations: null }).recommendations).toEqual([])
  })

  it('filters out individually malformed recommendation candidates without dropping well-formed siblings', () => {
    const result = validateReviewOutput({
      narrative: '',
      recommendations: [
        { evidenceEntryId: 'ev-1', recommendationText: 'good', confidence: 'low', targetedMetricFactId: null },
        { evidenceEntryId: 'ev-2', recommendationText: 'missing confidence', targetedMetricFactId: null },
        { evidenceEntryId: 'ev-3', confidence: 'high', targetedMetricFactId: null }, // missing recommendationText
        { recommendationText: 'missing evidenceEntryId', confidence: 'low', targetedMetricFactId: null },
        { evidenceEntryId: 'ev-4', recommendationText: 'bad confidence', confidence: 'extreme', targetedMetricFactId: null },
        { evidenceEntryId: 'ev-5', recommendationText: 'bad target type', confidence: 'low', targetedMetricFactId: 42 },
        'not even an object',
        null,
      ],
    })
    expect(result.recommendations).toHaveLength(1)
    expect(result.recommendations[0].evidenceEntryId).toBe('ev-1')
  })

  it('accepts a string or null targetedMetricFactId, rejects any other type', () => {
    const result = validateReviewOutput({
      narrative: '',
      recommendations: [
        { evidenceEntryId: 'ev-1', recommendationText: 'a', confidence: 'low', targetedMetricFactId: 'fact-1' },
        { evidenceEntryId: 'ev-2', recommendationText: 'b', confidence: 'low', targetedMetricFactId: null },
      ],
    })
    expect(result.recommendations).toHaveLength(2)
  })
})

describe('tryParseJson — defensive JSON parsing for text-completion adapters', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a": 1}')).toEqual({ a: 1 })
  })

  it('returns undefined for invalid/truncated JSON rather than throwing', () => {
    expect(tryParseJson('{"a": 1')).toBeUndefined()
    expect(tryParseJson('not json at all')).toBeUndefined()
    expect(tryParseJson('')).toBeUndefined()
  })

  it('returns undefined for non-string input', () => {
    expect(tryParseJson(undefined)).toBeUndefined()
    expect(tryParseJson(null)).toBeUndefined()
    expect(tryParseJson(42)).toBeUndefined()
    expect(tryParseJson({ already: 'an object' })).toBeUndefined()
  })
})
