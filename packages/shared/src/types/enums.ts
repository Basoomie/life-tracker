// Fixed enumerated sets used across items, occurrences, and events.
// These are TypeScript union literals — the DB stores TEXT with CHECK constraints
// using the same string values.

export type Priority = 'high' | 'medium' | 'low'

export type Valence = 'productive' | 'unproductive' | 'neutral'

// §6.5 — one of four timing precision levels; promotable/editable between them
export type TimingPrecision = 'none' | 'bucket' | 'point' | 'range'

// §9.2 — planned item vs spontaneous item; lives on the creation event, not the kind
export type CreationSource = 'planned' | 'ad_hoc'

// §8.1 — per-item policy for what happens when due-but-untouched at end of day
export type DispositionPolicy = 'skip' | 'excuse' | 'auto_close' | 'require_manual'

// §5.1 — recurrence rule stored as JSONB; null = one-time task
export type RecurrenceRule =
  | { type: 'daily' }
  | { type: 'days_of_week'; days: number[] }    // 0=Sun … 6=Sat
  | { type: 'interval'; unit: 'day' | 'week'; every: number }
  | { type: 'monthly' }

// §5.2 — stats-only target; not a scheduling mode
export type QuotaTarget = {
  count: number
  period: 'week' | 'month'
}

// ── v2 §9.4 — Evidence base (evidence standard: verify, don't request) ────────

// Only these two identifier types are accepted; both resolve against PubMed (§9.4
// "quality-gated sources"). A DOI that does not resolve to a PubMed-indexed record
// is treated the same as an identifier that does not exist at all.
export type SourceIdentifierType = 'pmid' | 'doi'

// Tiers mirror §6.3 / §9.4 wording exactly. Derived from the source's ACTUAL PubMed
// publication-type tags (see apps/backend/src/evidence/classify.ts) — never trusted
// from the proposer's claim.
export type EvidenceQuality =
  | 'meta_analysis'
  | 'systematic_review'
  | 'rct'
  | 'observational'
  | 'mechanistic_plausibility_only'

// Provenance is recorded but confers no privilege — seeded entries traverse the
// identical verify → approve pipeline as AI-proposed ones (§9.4.1: "no privileged bypass").
export type EvidenceProvenance = 'seeded' | 'ai_proposed'

export type VerificationStatus = 'pending' | 'verified' | 'rejected'

// Distinct from VerificationStatus's 'rejected': this is the HUMAN relevance/fairness
// judgment (§9.4.1 step 3), made only after verification already passed.
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

// v2 §9.4.1 follow-up — diagnostic, NOT a gate. Records whether the fetched abstract's
// <details> panel was open in the approval UI at the moment Approve was clicked.
//
// This is visibility, not reading — do not treat it as a stronger signal than that.
// "visible" means it was in front of the reviewer, not that they read it. There is no
// 'unknown' state: an approval always has an entry with or without a resolved abstract,
// and the panel is always either open or collapsed at the moment of the click.
export type AbstractVisibilityAtApproval = 'visible' | 'hidden' | 'no_abstract'

// Explicable failure reasons (§9.4: "verification failures must be explicable").
export type VerificationFailureReason =
  | 'malformed_identifier'        // doesn't look like a PMID or DOI at all
  | 'identifier_not_found'        // does not resolve to an indexed PubMed record
  | 'evidence_quality_mismatch'   // claimed tier != the tier derived from the record
  | 'network_error'               // resolution could not be attempted/completed — never treated as pass
