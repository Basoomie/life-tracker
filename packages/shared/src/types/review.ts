// v2 §6 / §9.2 / §9.5.2 — The AI Review: shared types for the stored review record.
//
// These are the API-facing / storage shapes (what step 3b persists and what a future
// reviews UI would consume). The structural gate types that keep an un-cleared Layer 2
// finding from ever reaching the prompt builder (§2, §9.6 Category 4) are backend-internal
// — see apps/backend/src/review/types.ts — because that seam has no meaning outside the
// server process that owns the event log.

import type { EvidenceQuality, SourceIdentifierType } from './enums'
import type { DateWindow } from './stats'

// §6.4 — weekly is primary; monthly and quarterly reuse the same calculators at a wider
// window. No daily cadence exists (§6.4: "a single day can't clear any threshold").
export type ReviewCadence = 'weekly' | 'monthly' | 'quarterly'

// §9.4 item 3 — the structured recommendation object. Everything EXCEPT `recommendation`,
// `confidence`, and the two `targetedMetric*` fields is copied verbatim from a verified +
// approved evidence_entries row (never generated fresh by the LLM at review time) — see
// apps/backend/src/review/verification.ts. This is what makes "rendered FROM the verified
// structure" literal rather than aspirational: the evidentiary fields were vetted in step 3a,
// long before this review ever ran.
export type Recommendation = {
  recommendation: string              // LLM-authored: the tailored, actionable suggestion
  mechanism: string                   // copied from the evidence entry
  sourceIdentifier: string            // copied from the evidence entry
  sourceIdentifierType: SourceIdentifierType
  evidenceQuality: EvidenceQuality    // copied from the evidence entry (actual, not claimed)
  confidence: 'low' | 'medium' | 'high'   // LLM-authored
  groundedJustification: string       // copied from the evidence entry (§9.4.2)
  targetedMetricFactId: string | null  // which released fact this recommendation is about
  targetedMetricLabel: string | null
}

// §9.2.1 — fed forward to the NEXT review as a structured record, never as prose.
// metricValueThen is fixed at the value observed the FIRST time this (evidence, metric)
// pairing was recommended; metricValueNow / delta are recomputed fresh each review so a
// repeated, unmoved recommendation is visible as a fact, not rediscovered from scratch.
export type FeedForwardRecord = {
  factId: string
  label: string
  sourceIdentifier: string
  recommendation: string
  timesRecommended: number
  metricValueThen: number | null
  metricValueNow: number | null
  delta: number | null
}

// A stored review — immutable once generated (§CLAUDE.md: event log is source of truth;
// corrections are new events/rows, never edits-in-place). Retained indefinitely (§9.5.2).
export type Review = {
  id: string
  userId: string
  cadence: ReviewCadence
  window: DateWindow
  generatedAt: Date
  narrative: string              // LLM synthesis (§9.2); may be '' if the model's output
                                  // was malformed (fails-safe — see llm-client.ts)
  recommendations: Recommendation[]
  feedForwardOut: FeedForwardRecord[]   // this review's contribution to the NEXT review's input
  prose: string                  // rendered, ready-to-display text (render.ts)
}
