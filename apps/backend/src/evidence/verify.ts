// v2 §9.4 / §9.4.1 — The verification gate. This is the fraud detector.
//
// Governing frame: the proposer (an LLM in step 3b; a script/fixture here in 3a) is
// untrusted. This function must behave correctly against an ADVERSARIAL candidate —
// a well-formed but fabricated identifier, a real identifier with an overclaimed
// evidence_quality — not just against malformed garbage. Every path either returns
// 'verified' after every check has explicitly passed, or returns 'rejected' with an
// explicable reason. There is no path that fails open (§9.4: "failure to verify is
// never permission to trust").
//
// Pure with respect to the database — no Pool, no userId, no DB access. It only
// depends on network I/O (injectable via deps, per PubmedClientDeps) and the pure
// classifier. The DB-writing orchestration lives in pipeline.ts.

import type { EvidenceCandidate, EvidenceQuality } from '@tracker/shared'
import {
  resolveDoiToPmid,
  fetchPublicationRecord,
  fetchAbstract,
  PubmedNetworkError,
  type PublicationRecord,
  type PubmedClientDeps,
} from './pubmed-client'
import { derivePublicationTypeTier } from './classify'

const PMID_PATTERN = /^\d+$/
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/

export type VerificationResult =
  | { status: 'verified'; resolved: PublicationRecord; actualEvidenceQuality: EvidenceQuality }
  | {
      status: 'rejected'
      reason: 'malformed_identifier' | 'identifier_not_found' | 'evidence_quality_mismatch' | 'network_error'
      detail: string
      resolved?: PublicationRecord
      actualEvidenceQuality?: EvidenceQuality
    }

export async function verifyCandidate(
  candidate: EvidenceCandidate,
  deps?: PubmedClientDeps
): Promise<VerificationResult> {
  // ── Format validation ────────────────────────────────────────────────────────
  if (candidate.sourceIdentifierType === 'pmid' && !PMID_PATTERN.test(candidate.sourceIdentifier)) {
    return {
      status: 'rejected',
      reason: 'malformed_identifier',
      detail: `"${candidate.sourceIdentifier}" is not a well-formed PMID (digits only)`,
    }
  }
  if (candidate.sourceIdentifierType === 'doi' && !DOI_PATTERN.test(candidate.sourceIdentifier)) {
    return {
      status: 'rejected',
      reason: 'malformed_identifier',
      detail: `"${candidate.sourceIdentifier}" is not a well-formed DOI (expected 10.XXXX/...)`,
    }
  }

  try {
    // ── Resolve to a PMID (DOIs resolve THROUGH PubMed — §9.4 item 2's source-quality
    //    gate is enforced by construction: unindexed sources have no PMID to find) ──
    let pmid: string
    if (candidate.sourceIdentifierType === 'doi') {
      const resolved = await resolveDoiToPmid(candidate.sourceIdentifier, deps)
      if (!resolved) {
        return {
          status: 'rejected',
          reason: 'identifier_not_found',
          detail: `DOI "${candidate.sourceIdentifier}" does not resolve to a PubMed-indexed record`,
        }
      }
      pmid = resolved
    } else {
      pmid = candidate.sourceIdentifier
    }

    // ── Identifier must exist ────────────────────────────────────────────────────
    const record = await fetchPublicationRecord(pmid, deps)
    if (!record) {
      return {
        status: 'rejected',
        reason: 'identifier_not_found',
        detail: `PMID ${pmid} was not found in PubMed`,
      }
    }

    // ── Claimed evidence_quality must match the ACTUAL type, derived from the
    //    record — never trusted from the entry (§9.4 item 4) ─────────────────────
    const actualEvidenceQuality = derivePublicationTypeTier(record.publicationTypes)
    if (actualEvidenceQuality !== candidate.claimedEvidenceQuality) {
      return {
        status: 'rejected',
        reason: 'evidence_quality_mismatch',
        detail:
          `claimed "${candidate.claimedEvidenceQuality}", but PubMed publication types ` +
          `[${record.publicationTypes.join(', ') || '(none)'}] indicate "${actualEvidenceQuality}"`,
        resolved: record,
        actualEvidenceQuality,
      }
    }

    // Best-effort: the human review step (§9.4.1 step 3) needs the abstract to check
    // grounded_justification against — a bare title/journal/year is not enough to catch
    // a subtly-wrong number (§9.4.2). Fetch failure here never turns a verified result
    // into a rejection; the fraud checks above already passed.
    const abstract = await fetchAbstract(pmid, deps)

    return { status: 'verified', resolved: { ...record, abstract }, actualEvidenceQuality }
  } catch (err) {
    if (err instanceof PubmedNetworkError) {
      // §9.4: never fail open. A network error is a rejection, not a pass.
      return { status: 'rejected', reason: 'network_error', detail: err.message }
    }
    throw err
  }
}
