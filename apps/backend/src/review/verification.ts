// v2 §9.4 / §9.2 — The verification gate for review-time citations.
//
// Unlike step 3a's verifyCandidate (apps/backend/src/evidence/verify.ts), which resolves
// a NEW candidate against PubMed, this gate has a much narrower job: the LLM was handed a
// CLOSED list of already-verified-and-approved evidence entries (ReleasedEvidence — see
// release.ts / prompt-builder.ts) and may cite ONLY those, by id. Any "evidenceEntryId"
// that is not in that exact list — fabricated, misremembered, or belonging to an entry
// that was never in the prompt in the first place — is dropped, never rendered.
//
// The evidentiary fields of the resulting Recommendation (mechanism, sourceIdentifier,
// evidenceQuality, groundedJustification) are copied VERBATIM from the matched evidence
// entry. The LLM never authors them at this step — it only supplies the tailored
// recommendation text, its confidence, and which fact (if any) the recommendation targets.

import type { Recommendation } from '@tracker/shared'
import type { RawRecommendationCandidate, ReleasedEvidence, ReleasedFinding } from './types'

export function verifyRecommendations(
  raw: RawRecommendationCandidate[],
  evidence: ReleasedEvidence[],
  facts: ReleasedFinding[]
): Recommendation[] {
  const evidenceById = new Map(evidence.map((e) => [e.id, e]))
  const factById = new Map(facts.map((f) => [f.factId, f]))

  const out: Recommendation[] = []
  for (const candidate of raw) {
    const matched = evidenceById.get(candidate.evidenceEntryId)
    if (!matched) continue // fabricated / unapproved / not-in-prompt — DROPPED, never shown

    const targetedFact = candidate.targetedMetricFactId ? factById.get(candidate.targetedMetricFactId) : undefined

    out.push({
      recommendation: candidate.recommendationText,
      mechanism: matched.mechanism,
      sourceIdentifier: matched.sourceIdentifier,
      sourceIdentifierType: matched.sourceIdentifierType,
      evidenceQuality: matched.evidenceQuality,
      confidence: candidate.confidence,
      groundedJustification: matched.groundedJustification,
      targetedMetricFactId: targetedFact ? targetedFact.factId : null,
      targetedMetricLabel: targetedFact ? targetedFact.label : null,
    })
  }
  return out
}
