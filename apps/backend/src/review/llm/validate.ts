// v2 §9.2 "fails safe under model substitution" — the ONE shared schema validator every
// adapter must funnel its (provider-shaped) response through before returning.
//
// Provider-neutral by construction: it takes an already-extracted plain JS value —
// however the adapter obtained it (a tool call's parsed arguments, a JSON-mode text
// completion run through JSON.parse, anything else) — and validates it against the
// shared RawReviewOutput schema. This is what "obtaining structured output... validating
// against the shared recommendation schema" (the interface contract) means in code: one
// function, reused by every adapter, so no adapter can quietly relax the schema.
//
// Never throws. Anything that doesn't fit degrades to EMPTY_OUTPUT — malformed input of
// any shape is indistinguishable, from the engine's point of view, from "no
// recommendations this period."

import type { RawRecommendationCandidate, RawReviewOutput } from '../types'

export const EMPTY_OUTPUT: RawReviewOutput = { narrative: '', recommendations: [] }

function isWellFormedCandidate(c: unknown): c is RawRecommendationCandidate {
  if (typeof c !== 'object' || c === null) return false
  const r = c as Record<string, unknown>
  return (
    typeof r.evidenceEntryId === 'string' &&
    typeof r.recommendationText === 'string' &&
    (r.confidence === 'low' || r.confidence === 'medium' || r.confidence === 'high') &&
    (r.targetedMetricFactId === null || typeof r.targetedMetricFactId === 'string')
  )
}

export function validateReviewOutput(value: unknown): RawReviewOutput {
  if (typeof value !== 'object' || value === null) return EMPTY_OUTPUT
  const obj = value as Record<string, unknown>
  const narrative = typeof obj.narrative === 'string' ? obj.narrative : ''
  const recommendations = Array.isArray(obj.recommendations)
    ? obj.recommendations.filter(isWellFormedCandidate)
    : []
  return { narrative, recommendations }
}

// Defensive JSON.parse for adapters working from a raw text completion (JSON mode, or a
// tool call whose arguments arrive as a string rather than a pre-parsed object). Returns
// undefined rather than throwing on invalid JSON, truncated output, or non-string input —
// the adapter is expected to treat `undefined` the same as any other malformed response.
export function tryParseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
