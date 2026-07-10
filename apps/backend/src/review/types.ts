// v2 §2 / §9.2 / §9.6 Category 4 — The structural gate.
//
// "Never gate a fact. Always gate an inference." (§2) The types below are what makes that
// enforceable rather than merely instructed. Each is a SEPARATE object shape (not one type
// with optional fields) so that a below-floor Layer 2 finding literally cannot be constructed
// with a point estimate attached — TypeScript's excess-property checking on object literals
// rejects it at the one place (release.ts) where these are built.
//
// Everything in this file is pure data. No Pool, no repos, no domain, no event types beyond
// the plain enums re-exported from @tracker/shared. The prompt builder (prompt-builder.ts)
// imports ONLY from this file — that is the "structurally incapable" guarantee: the prompt
// builder has no way to reach the event log, occurrences, or raw items, because this module
// never gives it a handle to any of them.

import type {
  DateWindow,
  Layer2Estimator,
  Layer2Finding,
  EvidenceQuality,
  SourceIdentifierType,
  FeedForwardRecord,
  ReviewCadence,
} from '@tracker/shared'

// ── Released findings (the ONLY shapes the prompt builder may receive) ───────────────

// Layer 1 (descriptive) and Layer 1.5 (data quality) facts always ship — they are counts,
// never gated (§2, §3, §4). `summary` is computed in code (see release.ts), never left for
// the LLM to reconstruct from raw numbers.
export type ReleasedLayer1Fact = {
  kind: 'layer1'
  factId: string
  itemId: string | null
  label: string
  summary: string
  metricValue: number | null
  rawCounts: Record<string, number>
}

export type ReleasedDataQualityFact = {
  kind: 'data_quality'
  factId: string
  itemId: string | null
  label: string
  summary: string
  metricValue: number | null
  rawCounts: Record<string, number>
}

// A Layer 2 finding whose sufficiency is 'computable' (§5.2). Carries power, effect size,
// MDE, and the data-quality note that every Layer 2 finding must travel with — a null must
// never reach the model bare (§5.2 / v2 rule 1).
export type ReleasedLayer2Cleared = {
  kind: 'layer2_cleared'
  factId: string
  itemId: string
  label: string
  insight: Layer2Finding['type']
  estimator: Layer2Estimator
  summary: string
  metricValue: number     // the finding's own effect size
  power: number
  pValue: number | null
  minimumDetectableEffect: number | null
  dataQualityNote: string
}

// A Layer 2 finding below its sufficiency floor (or out of scope, e.g. day-of-week on a
// non-daily habit). NOTE what is absent: no power, no effectSize, no pValue, no estimator.
// It is impossible to construct this object with a point estimate attached — there is no
// field to put one in. This is what makes a below-floor finding unable to "enter the prompt
// as an asserted result" (§9.2 seam requirement): the type itself has nowhere to carry one.
export type ReleasedLayer2NotYet = {
  kind: 'layer2_not_yet'
  factId: string
  itemId: string
  label: string
  insight: Layer2Finding['type']
  reason: string
  nObserved: number
  nNeeded: number
}

export type ReleasedFinding =
  | ReleasedLayer1Fact
  | ReleasedDataQualityFact
  | ReleasedLayer2Cleared
  | ReleasedLayer2NotYet

// ── Released evidence (the ONLY evidence the prompt builder may cite) ────────────────
//
// Constructed only from entries where verificationStatus === 'verified' AND
// approvalStatus === 'approved' AND archivedAt === null (release.ts releaseEvidence).
// evidenceQuality here is always the code-derived ACTUAL tier, never the proposer's
// claimed tier — mirrors the same rule the verification gate itself enforces in step 3a.
export type ReleasedEvidence = {
  id: string
  claim: string
  mechanism: string
  sourceIdentifier: string
  sourceIdentifierType: SourceIdentifierType
  evidenceQuality: EvidenceQuality
  groundedJustification: string
}

// ── The prompt builder's only input ──────────────────────────────────────────────────

export type PromptInput = {
  cadence: ReviewCadence
  window: DateWindow
  facts: ReleasedFinding[]
  evidence: ReleasedEvidence[]
  feedForward: FeedForwardRecord[]
}

// ── The LLM's raw (untrusted) output shape, before verification ─────────────────────

export type RawRecommendationCandidate = {
  evidenceEntryId: string
  recommendationText: string
  confidence: 'low' | 'medium' | 'high'
  targetedMetricFactId: string | null
}

export type RawReviewOutput = {
  narrative: string
  recommendations: RawRecommendationCandidate[]
}
