// v2 §9.4.1 — Maintaining the evidence base: generate → verify → approve.
//
// This module is the ONLY way an evidence_entries row is created or transitions
// status. There is deliberately no other write path (no direct repo calls from
// routes) — that is what "no bypass" means: proposeEvidenceEntry() always runs the
// gate, and approveEvidenceEntry() refuses anything that hasn't cleared it. Seeded
// entries (evidence/seed-data.ts) call proposeEvidenceEntry() exactly like any
// AI-proposed candidate would in step 3b — no privileged insertion route exists.

import type { Pool } from 'pg'
import type {
  AbstractVisibilityAtApproval,
  EvidenceCandidate,
  EvidenceEntry,
  EvidenceProvenance,
} from '@tracker/shared'
import * as repos from '../db/repos/index'
import { verifyCandidate, type VerificationResult } from './verify'
import type { PubmedClientDeps } from './pubmed-client'

// ── Generate + Verify ───────────────────────────────────────────────────────────
// "Generate" is the entry point named in §9.4.1 step 1. In step 3a it is invoked by
// a script/fixture (evidence/seed-data.ts, or a test); in step 3b an LLM's proposals
// arrive here identically. There is no separate "generate" function to call first —
// this one function IS both generate and verify, so a caller cannot do one without
// the other.
export async function proposeEvidenceEntry(
  pool: Pool,
  userId: string,
  candidate: EvidenceCandidate,
  provenance: EvidenceProvenance,
  deps?: PubmedClientDeps
): Promise<EvidenceEntry> {
  const inserted = await repos.insertEvidenceEntry(pool, { userId, provenance, ...candidate })

  await repos.insertEvent(pool, {
    userId,
    eventType: 'evidence_entry_proposed',
    occurrenceId: null,
    itemId: null,
    appliesToDay: null,
    payload: {
      evidenceEntryId: inserted.id,
      provenance,
      sourceIdentifierType: candidate.sourceIdentifierType,
      sourceIdentifier: candidate.sourceIdentifier,
      claimedEvidenceQuality: candidate.claimedEvidenceQuality,
    },
  })

  const result = await verifyCandidate(candidate, deps)
  const verified = await applyAndLogVerification(pool, userId, inserted.id, result)
  return verified
}

async function applyAndLogVerification(
  pool: Pool,
  userId: string,
  entryId: string,
  result: VerificationResult
): Promise<EvidenceEntry> {
  const updated = await repos.applyVerificationResult(pool, entryId, userId, result)
  if (!updated) throw new Error(`evidence entry not found: ${entryId}`)

  if (result.status === 'verified') {
    await repos.insertEvent(pool, {
      userId,
      eventType: 'evidence_entry_verified',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: {
        evidenceEntryId: entryId,
        actualEvidenceQuality: result.actualEvidenceQuality,
        resolvedPmid: result.resolved.pmid,
      },
    })
  } else {
    await repos.insertEvent(pool, {
      userId,
      eventType: 'evidence_entry_verification_rejected',
      occurrenceId: null,
      itemId: null,
      appliesToDay: null,
      payload: {
        evidenceEntryId: entryId,
        reason: result.reason,
        detail: result.detail,
      },
    })
  }

  return updated
}

// ── Approve ──────────────────────────────────────────────────────────────────
// The human relevance-and-fairness step (§9.4.1 step 3). Refuses anything that
// hasn't cleared verification — this is the enforcement point for "no bypass":
// there is no way to reach 'approved' without first passing through verifyCandidate.
//
// §9.4.1 follow-up (deliberate, not an oversight): approval is NEVER blocked or warned
// on abstractVisible, and never will be. A gate that can be satisfied without doing the
// thing it gates is worse than no gate — it launders the omission. Forcing a click
// before Approve is enabled does not force reading; it converts a real check into a
// ritual, and the system would end up implicitly certifying "this abstract was read"
// for entries where it was only ever clicked open and ignored. Same reasoning as
// rejecting excused-days-excluded-from-adherence (§3.1) and requiring citations be
// verified rather than merely requested (§9.4): don't let a soft signal masquerade as
// a hard one. abstractVisible is recorded purely as a diagnostic (see below), never
// consulted here to accept, reject, or warn.
//
// The caller (the UI) reports whether the abstract panel was open at the moment of the
// click. Whether an abstract existed at all is NOT trusted from the caller — that fact
// is already known server-side from the entry itself.
export async function approveEvidenceEntry(
  pool: Pool,
  userId: string,
  entryId: string,
  abstractVisible: boolean
): Promise<EvidenceEntry> {
  const entry = await repos.findEvidenceEntryById(pool, entryId, userId)
  if (!entry) throw new Error(`evidence entry not found: ${entryId}`)
  if (entry.archivedAt) throw new Error('cannot approve an archived evidence entry')
  if (entry.verificationStatus !== 'verified') {
    throw new Error(
      `cannot approve evidence entry ${entryId}: verification_status is "${entry.verificationStatus}", not "verified"`
    )
  }

  const visibility: AbstractVisibilityAtApproval =
    entry.resolvedAbstract === null ? 'no_abstract' : abstractVisible ? 'visible' : 'hidden'

  const updated = await repos.setApprovalStatus(pool, entryId, userId, 'approved', visibility)
  if (!updated) throw new Error(`evidence entry not found: ${entryId}`)

  await repos.insertEvent(pool, {
    userId,
    eventType: 'evidence_entry_approved',
    occurrenceId: null,
    itemId: null,
    appliesToDay: null,
    payload: { evidenceEntryId: entryId, abstractVisibleAtApproval: visibility },
  })

  return updated
}

// ── Reject (human) ───────────────────────────────────────────────────────────
// Distinct from a verification rejection: this is a human judging the claim doesn't
// fairly represent the source, or isn't relevant — reachable only after verification
// passed (mirrors approve's precondition, so rejection is always a considered call,
// never a default state for un-triaged entries).
export async function rejectEvidenceEntry(
  pool: Pool,
  userId: string,
  entryId: string
): Promise<EvidenceEntry> {
  const entry = await repos.findEvidenceEntryById(pool, entryId, userId)
  if (!entry) throw new Error(`evidence entry not found: ${entryId}`)
  if (entry.verificationStatus !== 'verified') {
    throw new Error(
      `cannot approve/reject evidence entry ${entryId}: verification_status is "${entry.verificationStatus}", not "verified"`
    )
  }

  const updated = await repos.setApprovalStatus(pool, entryId, userId, 'rejected')
  if (!updated) throw new Error(`evidence entry not found: ${entryId}`)

  await repos.insertEvent(pool, {
    userId,
    eventType: 'evidence_entry_approval_rejected',
    occurrenceId: null,
    itemId: null,
    appliesToDay: null,
    payload: { evidenceEntryId: entryId },
  })

  return updated
}

// ── Archive (soft-delete; never hard-delete — §CLAUDE.md, §9.4.1) ──────────────
export async function archiveEvidenceEntryWithEvent(
  pool: Pool,
  userId: string,
  entryId: string
): Promise<EvidenceEntry> {
  const archived = await repos.archiveEvidenceEntry(pool, entryId, userId)
  if (!archived) throw new Error(`evidence entry not found or already archived: ${entryId}`)

  await repos.insertEvent(pool, {
    userId,
    eventType: 'evidence_entry_archived',
    occurrenceId: null,
    itemId: null,
    appliesToDay: null,
    payload: { evidenceEntryId: entryId },
  })

  return archived
}
